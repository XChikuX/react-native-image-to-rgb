import { NitroModules } from 'react-native-nitro-modules'
import type {
  ImageToRgb,
  ConvertOptions,
  ConvertResult,
  PixelFormat,
  DataType,
  ChannelLayout,
  ResizeMode,
  CropRect,
} from './specs/ImageToRgb.nitro'

export type {
  ImageToRgb,
  ConvertOptions,
  ConvertResult,
  PixelFormat,
  DataType,
  ChannelLayout,
  ResizeMode,
  CropRect,
}

// -----------------------------------------------------------------------------
// HybridObject singleton
// -----------------------------------------------------------------------------

const ImageToRgbHybrid =
  NitroModules.createHybridObject<ImageToRgb>('ImageToRgb')

// -----------------------------------------------------------------------------
// Normalization presets
// -----------------------------------------------------------------------------

/**
 * Per-channel `(mean, std)` triplets in 0..255 byte scale.
 *
 * Output value per channel = `(byte - mean) / std`.
 *
 * - `none`:     mean=0, std=1     → raw 0..255 in float
 * - `'0-1'`:    mean=0, std=255   → scaled to 0..1
 * - `'-1-1'`:   mean=127.5, std=127.5 → scaled to -1..1 (MobileNet, Inception)
 * - `'imagenet'`: ImageNet RGB mean/std (× 255), the standard for torchvision-trained models
 * - `'yolo'`:   alias of `'0-1'` (darknet/YOLOv4/v5 standard)
 */
export type NormalizationPreset = 'none' | '0-1' | '-1-1' | 'imagenet' | 'yolo'

interface MeanStd {
  meanR: number
  meanG: number
  meanB: number
  stdR: number
  stdG: number
  stdB: number
}

const NORMALIZATION_PRESETS: Record<NormalizationPreset, MeanStd> = {
  'none': { meanR: 0, meanG: 0, meanB: 0, stdR: 1, stdG: 1, stdB: 1 },
  '0-1': { meanR: 0, meanG: 0, meanB: 0, stdR: 255, stdG: 255, stdB: 255 },
  '-1-1': {
    meanR: 127.5,
    meanG: 127.5,
    meanB: 127.5,
    stdR: 127.5,
    stdG: 127.5,
    stdB: 127.5,
  },
  // ImageNet stats in 0..255 byte scale: 0.485*255, 0.456*255, 0.406*255 for mean
  // and 0.229*255, 0.224*255, 0.225*255 for std.
  'imagenet': {
    meanR: 123.675,
    meanG: 116.28,
    meanB: 103.53,
    stdR: 58.395,
    stdG: 57.12,
    stdB: 57.375,
  },
  'yolo': { meanR: 0, meanG: 0, meanB: 0, stdR: 255, stdG: 255, stdB: 255 },
}

/**
 * Either a named preset (string) or an explicit mean/std definition.
 * Numbers may be a single value (broadcast to all 3 channels) or a `[R,G,B]` triple.
 */
export type Normalization =
  | NormalizationPreset
  | {
      mean: number | [number, number, number]
      std: number | [number, number, number]
    }

function resolveNormalization(n: Normalization | undefined): MeanStd {
  if (n == null) return NORMALIZATION_PRESETS.none
  if (typeof n === 'string') {
    const preset = NORMALIZATION_PRESETS[n]
    if (preset == null) {
      throw new Error(
        `[react-native-image-to-rgb] Unknown normalization preset: "${n}". ` +
          `Expected one of: ${Object.keys(NORMALIZATION_PRESETS).join(', ')}.`
      )
    }
    return preset
  }
  const triple = (
    v: number | [number, number, number]
  ): [number, number, number] => (typeof v === 'number' ? [v, v, v] : v)
  const [mR, mG, mB] = triple(n.mean)
  const [sR, sG, sB] = triple(n.std)
  if (sR === 0 || sG === 0 || sB === 0) {
    throw new Error(
      '[react-native-image-to-rgb] normalization std must be non-zero on every channel'
    )
  }
  return { meanR: mR, meanG: mG, meanB: mB, stdR: sR, stdG: sG, stdB: sB }
}

// -----------------------------------------------------------------------------
// Public high-level options
// -----------------------------------------------------------------------------

export interface ConvertImageOptions {
  /** Target output width. If both width and height are omitted, the source size is used. */
  width?: number
  /** Target output height. If both width and height are omitted, the source size is used. */
  height?: number
  /** Optional source-space crop, applied after EXIF normalization but before resize. */
  crop?: CropRect
  /** Default `'rgb'`. */
  pixelFormat?: PixelFormat
  /** Default `'uint8'`. */
  dataType?: DataType
  /** Default `'hwc'`. `'chw'` is required by darknet/YOLOv4 and most ONNX models. */
  channelLayout?: ChannelLayout
  /** Default `'stretch'`. Use `'letterbox'` for YOLO. */
  resizeMode?: ResizeMode
  /** Letterbox/contain padding color as `[R, G, B]`, 0..255. Default `[114, 114, 114]`. */
  letterboxColor?: [number, number, number]
  /** Normalization for float dtypes; ignored for integer dtypes. */
  normalization?: Normalization
  /** Explicit rotation (0/90/180/270) applied after EXIF normalization. Default 0. */
  rotation?: 0 | 90 | 180 | 270
  /** Ignore the source image's EXIF orientation tag. Default `false`. */
  ignoreExif?: boolean
}

function isFloatDtype(dt: DataType): boolean {
  return dt === 'float16' || dt === 'float32'
}

function buildNativeOptions(
  options: ConvertImageOptions | undefined
): ConvertOptions {
  const o = options ?? {}
  const dataType: DataType = o.dataType ?? 'uint8'
  const [lR, lG, lB] = o.letterboxColor ?? [114, 114, 114]

  const native: ConvertOptions = {
    width: o.width,
    height: o.height,
    crop: o.crop,
    pixelFormat: o.pixelFormat ?? 'rgb',
    dataType,
    channelLayout: o.channelLayout ?? 'hwc',
    resizeMode: o.resizeMode ?? 'stretch',
    letterboxR: lR,
    letterboxG: lG,
    letterboxB: lB,
    rotation: o.rotation ?? 0,
    ignoreExif: o.ignoreExif ?? false,
  }

  if (isFloatDtype(dataType)) {
    // Only forward mean/std for float dtypes (skipped natively for int dtypes anyway).
    const ms = resolveNormalization(o.normalization)
    native.meanR = ms.meanR
    native.meanG = ms.meanG
    native.meanB = ms.meanB
    native.stdR = ms.stdR
    native.stdG = ms.stdG
    native.stdB = ms.stdB
  } else if (o.normalization != null) {
    // Loud, since silent normalization-drop is a footgun for integer-quant pipelines.

    console.warn(
      `[react-native-image-to-rgb] normalization is ignored for integer dataType "${dataType}". ` +
        `Use 'float16' or 'float32' if you need mean/std normalization.`
    )
  }

  return native
}

// -----------------------------------------------------------------------------
// Main API
// -----------------------------------------------------------------------------

/**
 * Decode + resize + pack an image into a zero-copy ArrayBuffer, asynchronously.
 *
 * @example
 * const { data, width, height } = await convertImage(uri, {
 *   width: 224, height: 224, dataType: 'float32', normalization: '-1-1',
 * })
 * const output = await model.run([data])   // react-native-fast-tflite v3
 */
export function convertImage(
  uri: string,
  options?: ConvertImageOptions
): Promise<ConvertResult> {
  if (typeof uri !== 'string' || uri.length === 0) {
    return Promise.reject(
      new Error(
        '[react-native-image-to-rgb] convertImage: uri must be a non-empty string'
      )
    )
  }
  let nativeOptions: ConvertOptions
  try {
    nativeOptions = buildNativeOptions(options)
  } catch (e) {
    return Promise.reject(e)
  }
  return ImageToRgbHybrid.convertImage(uri, nativeOptions)
}

/**
 * Synchronous variant of `convertImage`. Blocks the calling thread.
 * Useful inside vision-camera worklets or other JSI-runtime contexts.
 */
export function convertImageSync(
  uri: string,
  options?: ConvertImageOptions
): ConvertResult {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error(
      '[react-native-image-to-rgb] convertImageSync: uri must be a non-empty string'
    )
  }
  return ImageToRgbHybrid.convertImageSync(uri, buildNativeOptions(options))
}

// -----------------------------------------------------------------------------
// Convenience presets — strong defaults for popular pipelines
// -----------------------------------------------------------------------------

/**
 * One-call preset for **darknet / YOLOv4 / YOLOv5 / YOLOv8** style inputs:
 * RGB, float32, CHW layout, letterbox-resized with gray (114) padding,
 * normalized to `[0, 1]`. Default size is `416×416` (YOLOv4); pass `size: 608`
 * for the high-res variant, or e.g. `size: 640` for YOLOv5/v8.
 *
 * The returned `contentX/Y/Width/Height` describe where the actual image lives
 * inside the letterboxed canvas — use it to un-project detections back to
 * source coordinates.
 */
export function toYoloInput(
  uri: string,
  size: number = 416
): Promise<ConvertResult> {
  return convertImage(uri, {
    width: size,
    height: size,
    pixelFormat: 'rgb',
    dataType: 'float32',
    channelLayout: 'chw',
    resizeMode: 'letterbox',
    letterboxColor: [114, 114, 114],
    normalization: 'yolo', // /255
  })
}

/**
 * One-call preset for **TFLite mobile classifiers** (MobileNet, EfficientNet, etc.).
 * Defaults match the most common signature: `224×224×3`, RGB, **uint8**, HWC.
 *
 * For float TFLite models, override `dataType` and pick a `normalization` preset:
 *
 * @example
 * // Float MobileNet
 * await toTFLiteInput(uri, { dataType: 'float32', normalization: '-1-1' })
 * // EfficientNet (ImageNet stats)
 * await toTFLiteInput(uri, { size: 240, dataType: 'float32', normalization: 'imagenet' })
 */
export function toTFLiteInput(
  uri: string,
  opts: {
    size?: number
    dataType?: DataType
    normalization?: Normalization
    pixelFormat?: PixelFormat
  } = {}
): Promise<ConvertResult> {
  const size = opts.size ?? 224
  return convertImage(uri, {
    width: size,
    height: size,
    pixelFormat: opts.pixelFormat ?? 'rgb',
    dataType: opts.dataType ?? 'uint8',
    channelLayout: 'hwc',
    resizeMode: 'stretch',
    normalization: opts.normalization,
  })
}

// -----------------------------------------------------------------------------
// Back-compat shim — v0.1.x API
// -----------------------------------------------------------------------------

/**
 * @deprecated Use {@link convertImage} for ~10–100× faster, allocation-free results.
 *
 * Returns a plain `number[]` of length `width * height * 3` with interleaved RGB bytes,
 * matching the behavior of v0.1.x. Kept for drop-in compatibility.
 */
export async function convertToRGB(uri: string): Promise<number[]> {
  const result = await convertImage(uri, {
    pixelFormat: 'rgb',
    dataType: 'uint8',
    channelLayout: 'hwc',
  })
  const bytes = new Uint8Array(result.data)
  // Array.from is the fastest reliable way to materialize a TypedArray as number[].
  return Array.from(bytes)
}

// -----------------------------------------------------------------------------
// Typed-array view helpers
// -----------------------------------------------------------------------------

/**
 * Returns the result's `data` as the natural TypedArray for its `dataType`.
 *
 * Note: JavaScript has no built-in `Float16Array` in most runtimes as of 2026,
 * so `float16` results are surfaced as a `Uint16Array` of raw IEEE-754 half-floats.
 * Pass them directly to `model.run([view.buffer])` — TFLite/CoreML interpret the
 * raw bytes correctly. Use a userland decoder if you need to inspect them in JS.
 */
export function asTypedArray(
  result: ConvertResult
): Uint8Array | Int8Array | Uint16Array | Float32Array {
  switch (result.dataType) {
    case 'uint8':
      return new Uint8Array(result.data)
    case 'int8':
      return new Int8Array(result.data)
    case 'uint16':
    case 'float16':
      return new Uint16Array(result.data)
    case 'float32':
      return new Float32Array(result.data)
    default: {
      // Exhaustiveness check
      const _exhaustive: never = result.dataType
      throw new Error(
        `[react-native-image-to-rgb] Unknown dataType: ${String(_exhaustive)}`
      )
    }
  }
}

/** Bytes per sample for each supported dtype. */
export function bytesPerSample(dataType: DataType): 1 | 2 | 4 {
  switch (dataType) {
    case 'uint8':
    case 'int8':
      return 1
    case 'uint16':
    case 'float16':
      return 2
    case 'float32':
      return 4
  }
}

/** Number of channels for each pixel format. */
export function channelsFor(pixelFormat: PixelFormat): 3 | 4 {
  return pixelFormat === 'rgb' || pixelFormat === 'bgr' ? 3 : 4
}
