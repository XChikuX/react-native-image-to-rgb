//
//  HybridAiImage.swift
//  react-native-ai-image
//
//  Swift implementation of the `AiImage` Nitro HybridObject.
//

import Accelerate
import CoreGraphics
import Foundation
import ImageIO
import NitroModules
import UIKit

final class HybridAiImage: HybridAiImageSpec {

  // MARK: - HybridObject entry points

  func convertImage(uri: String, options: ConvertOptions) throws -> Promise<ConvertResult> {
    return Promise.parallel {
      try Self.runConversion(uri: uri, options: options)
    }
  }

  func convertImageSync(uri: String, options: ConvertOptions) throws -> ConvertResult {
    return try Self.runConversion(uri: uri, options: options)
  }

  // MARK: - Pipeline

  private static func runConversion(uri: String, options: ConvertOptions) throws -> ConvertResult {
    let pixelFormat = options.pixelFormat ?? .rgb
    let dataType = options.dataType ?? .uint8
    let channelLayout = options.channelLayout ?? .hwc
    let resizeMode = options.resizeMode ?? .stretch

    // 1. Load source data
    let data = try loadData(uri: uri)

    // 2. Honor EXIF orientation → normalised, upright RGBA8 pixel buffer
    let ignoreExif = options.ignoreExif ?? false
    guard let cgImage = decodeCGImage(data: data, applyExif: !ignoreExif) else {
      throw RuntimeError.error(withMessage: "[react-native-ai-image] Failed to decode image at: \(uri)")
    }

    // 3. Apply explicit rotation on top
    let explicitRotation = try normalizeRotation(options.rotation)
    let oriented = rotateCGImage(cgImage, degrees: explicitRotation)
    let sourceWidth = oriented.width
    let sourceHeight = oriented.height

    // 4. Optional source-space crop
    let cropped = applyCrop(oriented, crop: options.crop)

    // 5. Resize per mode
    let targetW = max(1, Int(options.width ?? Double(cropped.width)))
    let targetH = max(1, Int(options.height ?? Double(cropped.height)))
    let padR = clampByte(options.letterboxR ?? 114.0)
    let padG = clampByte(options.letterboxG ?? 114.0)
    let padB = clampByte(options.letterboxB ?? 114.0)

    let resized = try resizeToCanvas(
      cropped,
      targetW: targetW,
      targetH: targetH,
      mode: resizeMode,
      padR: padR, padG: padG, padB: padB
    )

    // 6. Pack into output ArrayBuffer
    let channels = channelsFor(pixelFormat)
    let bytesPerSample = bytesPerSample(dataType)
    let totalBytes = targetW * targetH * channels * bytesPerSample

    let arrayBuffer = ArrayBuffer.allocate(size: totalBytes)
    let outBase = arrayBuffer.data

    let meanRgb: (Float, Float, Float) = (
      Float(options.meanR ?? 0.0),
      Float(options.meanG ?? 0.0),
      Float(options.meanB ?? 0.0)
    )
    let stdRgb: (Float, Float, Float) = (
      Float(options.stdR ?? 1.0),
      Float(options.stdG ?? 1.0),
      Float(options.stdB ?? 1.0)
    )

    packPixels(
      rgbaPixels: resized.rgbaPixels,
      width: targetW,
      height: targetH,
      out: outBase,
      pixelFormat: pixelFormat,
      dataType: dataType,
      channelLayout: channelLayout,
      meanRgb: meanRgb,
      stdRgb: stdRgb
    )

    return ConvertResult(
      data: arrayBuffer,
      width: Double(targetW),
      height: Double(targetH),
      channels: Double(channels),
      pixelFormat: pixelFormat,
      dataType: dataType,
      channelLayout: channelLayout,
      contentX: Double(resized.contentX),
      contentY: Double(resized.contentY),
      contentWidth: Double(resized.contentWidth),
      contentHeight: Double(resized.contentHeight),
      sourceWidth: Double(sourceWidth),
      sourceHeight: Double(sourceHeight)
    )
  }

  // MARK: - I/O

  private static func loadData(uri: String) throws -> Data {
    if uri.hasPrefix("data:") {
      guard let commaIdx = uri.firstIndex(of: ",") else {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] Malformed data: URI")
      }
      let header = String(uri[..<commaIdx])
      let payload = String(uri[uri.index(after: commaIdx)...])
      if header.lowercased().contains(";base64") {
        guard let decoded = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else {
          throw RuntimeError.error(withMessage: "[react-native-ai-image] Invalid base64 data URI")
        }
        return decoded
      } else {
        let decoded = payload.removingPercentEncoding ?? payload
        return Data(decoded.utf8)
      }
    }
    if uri.hasPrefix("http://") || uri.hasPrefix("https://") {
      guard let url = URL(string: uri) else {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] Invalid http(s) URL: \(uri)")
      }
      // Synchronous fetch; we are already on a background thread (Promise.parallel or sync call).
      let semaphore = DispatchSemaphore(value: 0)
      var fetched: Data?
      var fetchError: Error?
      var request = URLRequest(url: url)
      request.timeoutInterval = 30
      let task = URLSession.shared.dataTask(with: request) { d, _, err in
        fetched = d
        fetchError = err
        semaphore.signal()
      }
      task.resume()
      _ = semaphore.wait(timeout: .now() + 30)
      if let err = fetchError {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] HTTP fetch failed: \(err.localizedDescription)")
      }
      guard let result = fetched else {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] HTTP fetch returned no data for: \(uri)")
      }
      return result
    }
    // Treat anything else as a local path / file:// URL.
    let path: String
    if uri.hasPrefix("file://") {
      guard let url = URL(string: uri), url.isFileURL else {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] Invalid file URL: \(uri)")
      }
      path = url.path
    } else {
      path = uri
    }
    guard FileManager.default.fileExists(atPath: path) else {
      throw RuntimeError.error(withMessage: "[react-native-ai-image] File does not exist: \(path)")
    }
    return try Data(contentsOf: URL(fileURLWithPath: path))
  }

  // MARK: - Decode (with optional EXIF normalization)

  private static func decodeCGImage(data: Data, applyExif: Bool) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    guard let raw = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    if !applyExif {
      return raw
    }
    // Read EXIF orientation and bake it in by drawing through UIImage.
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
    let exifInt = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    let orientation = uiOrientation(fromExif: exifInt)
    if orientation == .up { return raw }

    // UIKit handles the rotation deterministically and is hardware-accelerated.
    let uiImg = UIImage(cgImage: raw, scale: 1, orientation: orientation)
    let renderer = UIGraphicsImageRenderer(size: uiImg.size, format: { () -> UIGraphicsImageRendererFormat in
      let f = UIGraphicsImageRendererFormat.preferred()
      f.scale = 1
      f.opaque = false
      return f
    }())
    let baked = renderer.image { _ in uiImg.draw(in: CGRect(origin: .zero, size: uiImg.size)) }
    return baked.cgImage ?? raw
  }

  private static func uiOrientation(fromExif exif: Int) -> UIImage.Orientation {
    switch exif {
    case 2: return .upMirrored
    case 3: return .down
    case 4: return .downMirrored
    case 5: return .leftMirrored
    case 6: return .right
    case 7: return .rightMirrored
    case 8: return .left
    default: return .up
    }
  }

  // MARK: - Geometry

  private static func normalizeRotation(_ value: Double?) throws -> Int {
    let r = Int(value ?? 0)
    let n = ((r % 360) + 360) % 360
    switch n {
    case 0, 90, 180, 270: return n
    default:
      throw RuntimeError.error(withMessage:
        "[react-native-ai-image] rotation must be 0, 90, 180, or 270 (got \(r))")
    }
  }

  private static func rotateCGImage(_ image: CGImage, degrees: Int) -> CGImage {
    if degrees == 0 { return image }
    let radians = CGFloat(degrees) * .pi / 180.0
    let swap = (degrees == 90 || degrees == 270)
    let newW = swap ? image.height : image.width
    let newH = swap ? image.width : image.height
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bytesPerRow = newW * 4
    guard let ctx = CGContext(
      data: nil,
      width: newW,
      height: newH,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    ) else {
      return image
    }
    ctx.translateBy(x: CGFloat(newW) / 2, y: CGFloat(newH) / 2)
    ctx.rotate(by: radians)
    ctx.draw(
      image,
      in: CGRect(x: -CGFloat(image.width) / 2, y: -CGFloat(image.height) / 2,
                 width: CGFloat(image.width), height: CGFloat(image.height))
    )
    return ctx.makeImage() ?? image
  }

  private static func applyCrop(_ image: CGImage, crop: CropRect?) -> CGImage {
    guard let crop = crop else { return image }
    let x = max(0, min(image.width - 1, Int(crop.x)))
    let y = max(0, min(image.height - 1, Int(crop.y)))
    let w = max(1, min(image.width - x, Int(crop.width)))
    let h = max(1, min(image.height - y, Int(crop.height)))
    if x == 0 && y == 0 && w == image.width && h == image.height { return image }
    return image.cropping(to: CGRect(x: x, y: y, width: w, height: h)) ?? image
  }

  // MARK: - Resize → produces a tightly packed RGBA8 buffer for `targetW × targetH`.

  private struct ResizedImage {
    let rgbaPixels: [UInt8]   // length == targetW * targetH * 4
    let contentX: Int
    let contentY: Int
    let contentWidth: Int
    let contentHeight: Int
  }

  private static func resizeToCanvas(
    _ image: CGImage,
    targetW: Int,
    targetH: Int,
    mode: ResizeMode,
    padR: UInt8, padG: UInt8, padB: UInt8
  ) throws -> ResizedImage {
    let srcW = image.width
    let srcH = image.height

    switch mode {
    case .stretch:
      let pixels = try drawRGBA(image, atW: targetW, atH: targetH)
      return ResizedImage(rgbaPixels: pixels, contentX: 0, contentY: 0,
                          contentWidth: targetW, contentHeight: targetH)

    case .cover:
      let srcAspect = Double(srcW) / Double(srcH)
      let dstAspect = Double(targetW) / Double(targetH)
      let scaledW: Int
      let scaledH: Int
      if srcAspect > dstAspect {
        scaledH = targetH
        scaledW = max(targetW, Int((Double(srcW) * Double(scaledH) / Double(srcH)).rounded()))
      } else {
        scaledW = targetW
        scaledH = max(targetH, Int((Double(srcH) * Double(scaledW) / Double(srcW)).rounded()))
      }
      let scaledPixels = try drawRGBA(image, atW: scaledW, atH: scaledH)
      let cropX = (scaledW - targetW) / 2
      let cropY = (scaledH - targetH) / 2
      var out = [UInt8](repeating: 0, count: targetW * targetH * 4)
      out.withUnsafeMutableBufferPointer { outBuf in
        scaledPixels.withUnsafeBufferPointer { srcBuf in
          for y in 0..<targetH {
            let srcRowStart = ((cropY + y) * scaledW + cropX) * 4
            let dstRowStart = y * targetW * 4
            memcpy(outBuf.baseAddress! + dstRowStart,
                   srcBuf.baseAddress! + srcRowStart,
                   targetW * 4)
          }
        }
      }
      return ResizedImage(rgbaPixels: out, contentX: 0, contentY: 0,
                          contentWidth: targetW, contentHeight: targetH)

    case .contain, .letterbox:
      let scale = min(Double(targetW) / Double(srcW), Double(targetH) / Double(srcH))
      let newW = max(1, Int((Double(srcW) * scale).rounded()))
      let newH = max(1, Int((Double(srcH) * scale).rounded()))
      let offsetX = (targetW - newW) / 2
      let offsetY = (targetH - newH) / 2

      let scaledPixels = try drawRGBA(image, atW: newW, atH: newH)
      var canvas = [UInt8](repeating: 0, count: targetW * targetH * 4)
      // Fill with letterbox color (opaque).
      canvas.withUnsafeMutableBufferPointer { buf in
        var i = 0
        while i < buf.count {
          buf[i + 0] = padR
          buf[i + 1] = padG
          buf[i + 2] = padB
          buf[i + 3] = 0xFF
          i += 4
        }
      }
      canvas.withUnsafeMutableBufferPointer { dst in
        scaledPixels.withUnsafeBufferPointer { src in
          for y in 0..<newH {
            let dstRowStart = ((offsetY + y) * targetW + offsetX) * 4
            let srcRowStart = y * newW * 4
            memcpy(dst.baseAddress! + dstRowStart,
                   src.baseAddress! + srcRowStart,
                   newW * 4)
          }
        }
      }
      return ResizedImage(rgbaPixels: canvas, contentX: offsetX, contentY: offsetY,
                          contentWidth: newW, contentHeight: newH)
    }
  }

  /// Draws (and resizes) `image` into a tightly-packed `width × height` RGBA8 buffer using Core Graphics
  /// (which uses Accelerate/vImage internally). Bytes are non-premultiplied, big-endian RGBA.
  private static func drawRGBA(_ image: CGImage, atW width: Int, atH height: Int) throws -> [UInt8] {
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    try pixels.withUnsafeMutableBytes { rawBuf in
      let colorSpace = CGColorSpaceCreateDeviceRGB()
      guard let ctx = CGContext(
        data: rawBuf.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        // Non-premultiplied RGBA: byte order is R, G, B, A in memory.
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
      ) else {
        throw RuntimeError.error(withMessage: "[react-native-ai-image] Failed to create CGContext")
      }
      ctx.interpolationQuality = .high
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      // Manually set alpha to opaque (we used `noneSkipLast` but Core Graphics may leave stale alpha bytes).
      let basePtr = rawBuf.bindMemory(to: UInt8.self).baseAddress!
      var i = 3
      let n = width * height * 4
      while i < n {
        basePtr[i] = 0xFF
        i += 4
      }
    }
    return pixels
  }

  // MARK: - Packing (single sweep)

  private static func packPixels(
    rgbaPixels: [UInt8],
    width: Int,
    height: Int,
    out outBase: UnsafeMutablePointer<UInt8>,
    pixelFormat: PixelFormat,
    dataType: DataType,
    channelLayout: ChannelLayout,
    meanRgb: (Float, Float, Float),
    stdRgb: (Float, Float, Float)
  ) {
    let channels = channelsFor(pixelFormat)
    let total = width * height

    // For each output channel slot, which source channel does it read? 0=R 1=G 2=B 3=A
    let srcIdx: [Int]
    switch pixelFormat {
    case .rgb:  srcIdx = [0, 1, 2]
    case .bgr:  srcIdx = [2, 1, 0]
    case .rgba: srcIdx = [0, 1, 2, 3]
    case .bgra: srcIdx = [2, 1, 0, 3]
    case .argb: srcIdx = [3, 0, 1, 2]
    case .abgr: srcIdx = [3, 2, 1, 0]
    }
    var perOutMean = [Float](repeating: 0, count: channels)
    var perOutStd = [Float](repeating: 1, count: channels)
    let meanArr = [meanRgb.0, meanRgb.1, meanRgb.2]
    let stdArr = [stdRgb.0, stdRgb.1, stdRgb.2]
    for c in 0..<channels {
      let s = srcIdx[c]
      perOutMean[c] = (s == 3) ? 0 : meanArr[s]
      perOutStd[c] = (s == 3) ? 1 : stdArr[s]
    }

    let bytesPerSample = bytesPerSample(dataType)
    let isChw = (channelLayout == .chw)
    let planeStrideBytes = total * bytesPerSample

    rgbaPixels.withUnsafeBufferPointer { srcBuf in
      let src = srcBuf.baseAddress!
      for i in 0..<total {
        let pix = src + i * 4
        // The decode-side buffer is RGBA8 (R at byte 0, A at byte 3).
        let r = Int(pix[0])
        let g = Int(pix[1])
        let b = Int(pix[2])
        let a = Int(pix[3])
        let srcChannels = [r, g, b, a]
        for c in 0..<channels {
          let v = srcChannels[srcIdx[c]]
          let byteOffset = isChw
            ? c * planeStrideBytes + i * bytesPerSample
            : (i * channels + c) * bytesPerSample
          writeSample(out: outBase + byteOffset,
                      byteValue: v,
                      dataType: dataType,
                      mean: perOutMean[c],
                      std: perOutStd[c])
        }
      }
    }
  }

  @inline(__always)
  private static func writeSample(
    out: UnsafeMutablePointer<UInt8>,
    byteValue: Int,
    dataType: DataType,
    mean: Float,
    std: Float
  ) {
    switch dataType {
    case .uint8:
      out.pointee = UInt8(byteValue)
    case .int8:
      let signed = Int8(byteValue - 128)
      out.withMemoryRebound(to: Int8.self, capacity: 1) { $0.pointee = signed }
    case .uint16:
      let v = UInt16(byteValue * 257)
      out.withMemoryRebound(to: UInt16.self, capacity: 1) { $0.pointee = v }
    case .float16:
      let f = (Float(byteValue) - mean) / std
      let h = floatToHalfBits(f)
      out.withMemoryRebound(to: UInt16.self, capacity: 1) { $0.pointee = h }
    case .float32:
      let f = (Float(byteValue) - mean) / std
      out.withMemoryRebound(to: Float.self, capacity: 1) { $0.pointee = f }
    }
  }

  // MARK: - Small helpers

  private static func clampByte(_ d: Double) -> UInt8 {
    let r = Int(d.rounded())
    return UInt8(max(0, min(255, r)))
  }

  private static func channelsFor(_ pf: PixelFormat) -> Int {
    switch pf {
    case .rgb, .bgr: return 3
    default: return 4
    }
  }

  private static func bytesPerSample(_ dt: DataType) -> Int {
    switch dt {
    case .uint8, .int8: return 1
    case .uint16, .float16: return 2
    case .float32: return 4
    }
  }

  /// IEEE-754 binary16 conversion (round-to-nearest-even). Handles subnormals, ±Inf, NaN, and overflow.
  private static func floatToHalfBits(_ f: Float) -> UInt16 {
    let bits = f.bitPattern
    let sign = UInt16((bits >> 16) & 0x8000)
    let rawExp = Int((bits >> 23) & 0xFF)
    let mant = bits & 0x7FFFFF

    if rawExp == 0xFF {
      // Inf / NaN
      if mant != 0 { return sign | 0x7E00 } // qNaN
      return sign | 0x7C00
    }

    let newExp = rawExp - 127 + 15
    if newExp >= 0x1F {
      return sign | 0x7C00  // overflow to ±inf
    }
    if newExp <= 0 {
      if newExp < -10 { return sign } // underflow to ±0
      let mantWithImplicit = mant | 0x800000
      let shift = UInt32(14 - newExp)
      let rounded = (mantWithImplicit >> shift) + ((mantWithImplicit >> (shift - 1)) & 1)
      return sign | UInt16(truncatingIfNeeded: rounded)
    }
    var m = (mant >> 13) + ((mant >> 12) & 1)
    var e = newExp
    if (m & 0x400) != 0 {
      m = 0
      e += 1
      if e >= 0x1F { return sign | 0x7C00 }
    }
    return sign | UInt16(e << 10) | UInt16(truncatingIfNeeded: m)
  }
}
