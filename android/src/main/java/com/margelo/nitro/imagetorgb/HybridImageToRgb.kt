package com.margelo.nitro.imagetorgb

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.annotation.Keep
import androidx.exifinterface.media.ExifInterface
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.core.Promise
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Kotlin implementation of the `ImageToRgb` HybridObject.
 *
 * Pipeline:
 *  1. Load bytes from `uri` (file://, plain path, content://, http(s)://, data:image/...;base64,...).
 *  2. Decode with `BitmapFactory` into a software ARGB_8888 bitmap.
 *  3. Apply EXIF orientation (unless `ignoreExif`), then explicit `rotation`.
 *  4. Apply optional `crop` (clamped to image bounds).
 *  5. Resize to `width`×`height` according to `resizeMode`.
 *  6. Pack pixels into a direct `ByteBuffer` per `pixelFormat`/`dataType`/`channelLayout`,
 *     applying mean/std normalization only for float dtypes.
 *  7. Wrap the buffer in a zero-copy Nitro `ArrayBuffer` and return.
 */
@DoNotStrip
@Keep
class HybridImageToRgb : HybridImageToRgbSpec() {

  override fun convertImage(uri: String, options: ConvertOptions): Promise<ConvertResult> =
    Promise.parallel { runConversion(uri, options) }

  override fun convertImageSync(uri: String, options: ConvertOptions): ConvertResult =
    runConversion(uri, options)

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private fun runConversion(uri: String, options: ConvertOptions): ConvertResult {
    val pixelFormat = options.pixelFormat ?: PixelFormat.RGB
    val dataType = options.dataType ?: DataType.UINT8
    val channelLayout = options.channelLayout ?: ChannelLayout.HWC
    val resizeMode = options.resizeMode ?: ResizeMode.STRETCH

    val rawBitmap = decodeBitmap(uri)
    try {
      val ignoreExif = options.ignoreExif ?: false
      val exifRotation = if (ignoreExif) 0 else readExifRotationDegrees(uri)
      val explicitRotation = normalizeRotation(options.rotation)
      val totalRotation = (exifRotation + explicitRotation) % 360
      val oriented = rotate(rawBitmap, totalRotation)
      val sourceWidth = oriented.width
      val sourceHeight = oriented.height

      val cropped = applyCrop(oriented, options.crop)

      val targetW = (options.width ?: cropped.width.toDouble()).toInt().coerceAtLeast(1)
      val targetH = (options.height ?: cropped.height.toDouble()).toInt().coerceAtLeast(1)
      val letterboxR = clampByte(options.letterboxR ?: 114.0)
      val letterboxG = clampByte(options.letterboxG ?: 114.0)
      val letterboxB = clampByte(options.letterboxB ?: 114.0)

      val resized = resizeToCanvas(
        bitmap = cropped,
        targetW = targetW,
        targetH = targetH,
        mode = resizeMode,
        padR = letterboxR,
        padG = letterboxG,
        padB = letterboxB,
      )
      // `cropped` is recycled inside `resizeToCanvas` if it's distinct from the result source.
      if (cropped !== oriented && cropped !== rawBitmap && !cropped.isRecycled) cropped.recycle()
      if (oriented !== rawBitmap && !oriented.isRecycled) oriented.recycle()

      val channels = channelsFor(pixelFormat)
      val bytesPerSample = bytesPerSample(dataType)
      val totalBytes = targetW * targetH * channels * bytesPerSample
      val buffer = ByteBuffer.allocateDirect(totalBytes).order(ByteOrder.nativeOrder())

      val meanRgb = floatArrayOf(
        (options.meanR ?: 0.0).toFloat(),
        (options.meanG ?: 0.0).toFloat(),
        (options.meanB ?: 0.0).toFloat(),
      )
      val stdRgb = floatArrayOf(
        (options.stdR ?: 1.0).toFloat(),
        (options.stdG ?: 1.0).toFloat(),
        (options.stdB ?: 1.0).toFloat(),
      )

      packPixels(
        argbPixels = resized.argbPixels,
        width = targetW,
        height = targetH,
        out = buffer,
        pixelFormat = pixelFormat,
        dataType = dataType,
        channelLayout = channelLayout,
        meanRgb = meanRgb,
        stdRgb = stdRgb,
      )

      return ConvertResult(
        data = ArrayBuffer.wrap(buffer),
        width = targetW.toDouble(),
        height = targetH.toDouble(),
        channels = channels.toDouble(),
        pixelFormat = pixelFormat,
        dataType = dataType,
        channelLayout = channelLayout,
        contentX = resized.contentX.toDouble(),
        contentY = resized.contentY.toDouble(),
        contentWidth = resized.contentWidth.toDouble(),
        contentHeight = resized.contentHeight.toDouble(),
        sourceWidth = sourceWidth.toDouble(),
        sourceHeight = sourceHeight.toDouble(),
      )
    } finally {
      if (!rawBitmap.isRecycled) rawBitmap.recycle()
    }
  }

  // -------------------------------------------------------------------------
  // I/O
  // -------------------------------------------------------------------------

  private fun decodeBitmap(uri: String): Bitmap {
    val bytes = loadBytes(uri)
    val opts = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inMutable = false
      inScaled = false
      inPremultiplied = false
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
      ?: throw RuntimeException("[react-native-ai-image] Failed to decode image at: $uri")
  }

  private fun loadBytes(uri: String): ByteArray {
    if (uri.startsWith("data:")) {
      val commaIdx = uri.indexOf(',')
      require(commaIdx > 0) { "[react-native-ai-image] Malformed data: URI" }
      val header = uri.substring(0, commaIdx)
      val payload = uri.substring(commaIdx + 1)
      return if (header.contains(";base64", ignoreCase = true)) {
        android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
      } else {
        java.net.URLDecoder.decode(payload, "UTF-8").toByteArray(Charsets.ISO_8859_1)
      }
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      val conn = URL(uri).openConnection() as HttpURLConnection
      conn.connectTimeout = 15_000
      conn.readTimeout = 30_000
      conn.instanceFollowRedirects = true
      try {
        conn.inputStream.use { return readAllBytes(it) }
      } finally {
        conn.disconnect()
      }
    }
    if (uri.startsWith("content://") || uri.startsWith("android.resource://")) {
      val ctx = NitroModules.applicationContext
        ?: throw RuntimeException("[react-native-ai-image] No Android context available for content:// URI")
      ctx.contentResolver.openInputStream(Uri.parse(uri))?.use { return readAllBytes(it) }
        ?: throw RuntimeException("[react-native-ai-image] Could not open content URI: $uri")
    }
    val path = if (uri.startsWith("file://")) Uri.parse(uri).path ?: uri.removePrefix("file://") else uri
    val file = java.io.File(path)
    if (!file.exists()) {
      throw RuntimeException("[react-native-ai-image] File does not exist: $path")
    }
    return file.readBytes()
  }

  private fun readAllBytes(stream: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = stream.read(buf)
      if (n <= 0) break
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  private fun readExifRotationDegrees(uri: String): Int {
    return try {
      val stream = openStreamForExif(uri) ?: return 0
      stream.use {
        val exif = ExifInterface(it)
        when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90
          ExifInterface.ORIENTATION_ROTATE_180 -> 180
          ExifInterface.ORIENTATION_ROTATE_270 -> 270
          else -> 0
        }
      }
    } catch (_: Throwable) {
      0
    }
  }

  private fun openStreamForExif(uri: String): InputStream? {
    return when {
      uri.startsWith("data:") -> null
      uri.startsWith("http://") || uri.startsWith("https://") -> null
      uri.startsWith("content://") || uri.startsWith("android.resource://") -> {
        NitroModules.applicationContext?.contentResolver?.openInputStream(Uri.parse(uri))
      }
      else -> {
        val path = if (uri.startsWith("file://")) Uri.parse(uri).path ?: uri.removePrefix("file://") else uri
        java.io.File(path).takeIf { it.exists() }?.inputStream()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private fun normalizeRotation(value: Double?): Int {
    val r = (value ?: 0.0).toInt()
    val n = ((r % 360) + 360) % 360
    return when (n) {
      0, 90, 180, 270 -> n
      else -> throw IllegalArgumentException(
        "[react-native-ai-image] rotation must be 0, 90, 180, or 270 (got $r)"
      )
    }
  }

  private fun rotate(src: Bitmap, degrees: Int): Bitmap {
    if (degrees == 0) return src
    val m = Matrix().apply { postRotate(degrees.toFloat()) }
    return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
  }

  private fun applyCrop(src: Bitmap, crop: CropRect?): Bitmap {
    if (crop == null) return src
    val x = crop.x.toInt().coerceIn(0, max(0, src.width - 1))
    val y = crop.y.toInt().coerceIn(0, max(0, src.height - 1))
    val w = crop.width.toInt().coerceIn(1, src.width - x)
    val h = crop.height.toInt().coerceIn(1, src.height - y)
    if (x == 0 && y == 0 && w == src.width && h == src.height) return src
    return Bitmap.createBitmap(src, x, y, w, h)
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  private data class ResizedImage(
    val argbPixels: IntArray,
    val contentX: Int,
    val contentY: Int,
    val contentWidth: Int,
    val contentHeight: Int,
  )

  private fun resizeToCanvas(
    bitmap: Bitmap,
    targetW: Int,
    targetH: Int,
    mode: ResizeMode,
    padR: Int,
    padG: Int,
    padB: Int,
  ): ResizedImage {
    val srcW = bitmap.width
    val srcH = bitmap.height

    return when (mode) {
      ResizeMode.STRETCH -> {
        val scaled =
          if (srcW == targetW && srcH == targetH) bitmap
          else Bitmap.createScaledBitmap(bitmap, targetW, targetH, true)
        try {
          val pixels = IntArray(targetW * targetH)
          scaled.getPixels(pixels, 0, targetW, 0, 0, targetW, targetH)
          ResizedImage(pixels, 0, 0, targetW, targetH)
        } finally {
          if (scaled !== bitmap && !scaled.isRecycled) scaled.recycle()
        }
      }

      ResizeMode.COVER -> {
        val srcAspect = srcW.toDouble() / srcH
        val dstAspect = targetW.toDouble() / targetH
        val scaledW: Int
        val scaledH: Int
        if (srcAspect > dstAspect) {
          scaledH = targetH
          scaledW = max(targetW, (srcW.toDouble() * scaledH / srcH).roundToInt())
        } else {
          scaledW = targetW
          scaledH = max(targetH, (srcH.toDouble() * scaledW / srcW).roundToInt())
        }
        val scaled =
          if (srcW == scaledW && srcH == scaledH) bitmap
          else Bitmap.createScaledBitmap(bitmap, scaledW, scaledH, true)
        try {
          val cropX = (scaledW - targetW) / 2
          val cropY = (scaledH - targetH) / 2
          val pixels = IntArray(targetW * targetH)
          scaled.getPixels(pixels, 0, targetW, cropX, cropY, targetW, targetH)
          ResizedImage(pixels, 0, 0, targetW, targetH)
        } finally {
          if (scaled !== bitmap && !scaled.isRecycled) scaled.recycle()
        }
      }

      ResizeMode.CONTAIN, ResizeMode.LETTERBOX -> {
        val scale = min(targetW.toDouble() / srcW, targetH.toDouble() / srcH)
        val newW = max(1, (srcW * scale).roundToInt())
        val newH = max(1, (srcH * scale).roundToInt())
        val offsetX = (targetW - newW) / 2
        val offsetY = (targetH - newH) / 2

        val pad = (0xFF shl 24) or (padR shl 16) or (padG shl 8) or padB
        val pixels = IntArray(targetW * targetH) { pad }

        val scaled =
          if (srcW == newW && srcH == newH) bitmap
          else Bitmap.createScaledBitmap(bitmap, newW, newH, true)
        try {
          val row = IntArray(newW)
          for (y in 0 until newH) {
            scaled.getPixels(row, 0, newW, 0, y, newW, 1)
            val dstRowStart = (offsetY + y) * targetW + offsetX
            System.arraycopy(row, 0, pixels, dstRowStart, newW)
          }
          ResizedImage(pixels, offsetX, offsetY, newW, newH)
        } finally {
          if (scaled !== bitmap && !scaled.isRecycled) scaled.recycle()
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Packing — single hot sweep over all pixels.
  // -------------------------------------------------------------------------

  private fun packPixels(
    argbPixels: IntArray,
    width: Int,
    height: Int,
    out: ByteBuffer,
    pixelFormat: PixelFormat,
    dataType: DataType,
    channelLayout: ChannelLayout,
    meanRgb: FloatArray,
    stdRgb: FloatArray,
  ) {
    val channels = channelsFor(pixelFormat)
    val total = width * height

    // For each output channel slot, which source channel does it read from?
    // Source channels are indexed: 0=R 1=G 2=B 3=A
    val srcIdx = when (pixelFormat) {
      PixelFormat.RGB -> intArrayOf(0, 1, 2)
      PixelFormat.BGR -> intArrayOf(2, 1, 0)
      PixelFormat.RGBA -> intArrayOf(0, 1, 2, 3)
      PixelFormat.BGRA -> intArrayOf(2, 1, 0, 3)
      PixelFormat.ARGB -> intArrayOf(3, 0, 1, 2)
      PixelFormat.ABGR -> intArrayOf(3, 2, 1, 0)
    }
    val perOutMean = FloatArray(channels)
    val perOutStd = FloatArray(channels)
    for (c in 0 until channels) {
      val s = srcIdx[c]
      perOutMean[c] = if (s == 3) 0f else meanRgb[s]
      perOutStd[c] = if (s == 3) 1f else stdRgb[s]
    }

    val bytesPerSample = bytesPerSample(dataType)
    val isChw = channelLayout == ChannelLayout.CHW
    val planeStrideBytes = total * bytesPerSample

    val srcChannels = IntArray(4)
    for (i in 0 until total) {
      val argb = argbPixels[i]
      // Android `Bitmap.getPixels` always returns 0xAARRGGBB ints, regardless of native byte order.
      srcChannels[3] = (argb ushr 24) and 0xFF // A
      srcChannels[0] = (argb ushr 16) and 0xFF // R
      srcChannels[1] = (argb ushr 8) and 0xFF  // G
      srcChannels[2] = argb and 0xFF           // B

      for (c in 0 until channels) {
        val v = srcChannels[srcIdx[c]]
        val byteOffset = if (isChw) {
          c * planeStrideBytes + i * bytesPerSample
        } else {
          (i * channels + c) * bytesPerSample
        }
        writeSample(out, byteOffset, v, dataType, perOutMean[c], perOutStd[c])
      }
    }
  }

  private fun writeSample(
    out: ByteBuffer,
    offset: Int,
    byteValue: Int,
    dataType: DataType,
    mean: Float,
    std: Float,
  ) {
    when (dataType) {
      DataType.UINT8 -> out.put(offset, byteValue.toByte())
      DataType.INT8 -> out.put(offset, (byteValue - 128).toByte())
      DataType.UINT16 -> {
        // Canonical 8 → 16 bit expansion: x * 257  ( == (x << 8) | x ).
        val v = byteValue * 257
        out.putShort(offset, v.toShort())
      }
      DataType.FLOAT16 -> {
        val f = (byteValue.toFloat() - mean) / std
        out.putShort(offset, floatToHalfBits(f))
      }
      DataType.FLOAT32 -> {
        val f = (byteValue.toFloat() - mean) / std
        out.putFloat(offset, f)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private fun clampByte(d: Double): Int = max(0, min(255, d.roundToInt()))

  companion object {
    private fun channelsFor(pf: PixelFormat): Int = when (pf) {
      PixelFormat.RGB, PixelFormat.BGR -> 3
      else -> 4
    }

    private fun bytesPerSample(dt: DataType): Int = when (dt) {
      DataType.UINT8, DataType.INT8 -> 1
      DataType.UINT16, DataType.FLOAT16 -> 2
      DataType.FLOAT32 -> 4
    }

    /**
     * Convert a float32 value to IEEE-754 binary16 bits (round-to-nearest-even).
     * Handles subnormals, infinities, NaNs and overflow to inf.
     */
    @JvmStatic
    internal fun floatToHalfBits(f: Float): Short {
      val bits = java.lang.Float.floatToRawIntBits(f)
      val sign = (bits ushr 16) and 0x8000
      val rawExp = (bits ushr 23) and 0xFF
      val mant = bits and 0x7FFFFF

      // NaN / Inf
      if (rawExp == 0xFF) {
        return if (mant != 0) {
          // Preserve NaN, set the quiet bit
          (sign or 0x7E00).toShort()
        } else {
          (sign or 0x7C00).toShort()
        }
      }

      val newExp = rawExp - 127 + 15
      if (newExp >= 0x1F) {
        // Overflow → +/- inf
        return (sign or 0x7C00).toShort()
      }
      if (newExp <= 0) {
        // Subnormal or underflow to zero
        if (newExp < -10) return sign.toShort()
        val mantWithImplicit = mant or 0x800000
        val shift = 14 - newExp
        val rounded = (mantWithImplicit ushr shift) +
          ((mantWithImplicit ushr (shift - 1)) and 1)
        return (sign or rounded).toShort()
      }
      // Normalized
      var m = (mant ushr 13) + ((mant ushr 12) and 1)
      var e = newExp
      if (m and 0x400 != 0) {
        m = 0
        e += 1
        if (e >= 0x1F) return (sign or 0x7C00).toShort()
      }
      return (sign or (e shl 10) or m).toShort()
    }
  }
}
