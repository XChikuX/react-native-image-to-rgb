import type { HybridObject } from 'react-native-nitro-modules'

/**
 * The output channel order of the packed pixel data.
 * - `rgb`  / `bgr`:  3 channels (most TFLite & darknet/YOLO models)
 * - `rgba` / `bgra` / `argb` / `abgr`: 4 channels
 */
export type PixelFormat = 'rgb' | 'rgba' | 'argb' | 'bgr' | 'bgra' | 'abgr'

/**
 * The numeric type of each channel sample written to the output buffer.
 *
 * | Type      | Bytes/sample | Range          |
 * |-----------|--------------|----------------|
 * | `uint8`   | 1            | 0..255         |
 * | `int8`    | 1            | -128..127      |
 * | `uint16`  | 2            | 0..65535       |
 * | `float16` | 2            | IEEE-754 half  |
 * | `float32` | 4            | IEEE-754 float |
 *
 * Normalization (`mean*` / `std*`) is only applied when `dataType` is `float16`
 * or `float32`. For integer dtypes the raw decoded byte values are written.
 */
export type DataType = 'uint8' | 'int8' | 'uint16' | 'float16' | 'float32'

/**
 * Memory layout of the output tensor.
 * - `hwc` (default): `[height][width][channels]` — TFLite, TensorFlow, most mobile models.
 * - `chw`: `[channels][height][width]` — darknet/YOLOv4, ONNX, PyTorch models.
 */
export type ChannelLayout = 'hwc' | 'chw'

/**
 * How the decoded image is fit into the requested `width`/`height`.
 * - `stretch`:   Resize freely, ignoring aspect ratio. (default)
 * - `cover`:     Scale + center-crop so the output is fully covered.
 * - `contain`:   Scale so the whole image fits; pad with `letterbox*` color.
 * - `letterbox`: Alias of `contain`. The YOLO/darknet convention.
 */
export type ResizeMode = 'stretch' | 'cover' | 'contain' | 'letterbox'

/** A pixel-space crop applied to the original (post-EXIF) image before resize. */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ConvertOptions {
  width?: number
  height?: number
  crop?: CropRect

  pixelFormat?: PixelFormat
  dataType?: DataType
  channelLayout?: ChannelLayout

  resizeMode?: ResizeMode
  letterboxR?: number
  letterboxG?: number
  letterboxB?: number

  meanR?: number
  meanG?: number
  meanB?: number
  stdR?: number
  stdG?: number
  stdB?: number

  rotation?: number
  ignoreExif?: boolean
}

export interface ConvertResult {
  data: ArrayBuffer
  width: number
  height: number
  channels: number
  pixelFormat: PixelFormat
  dataType: DataType
  channelLayout: ChannelLayout
  contentX: number
  contentY: number
  contentWidth: number
  contentHeight: number
  sourceWidth: number
  sourceHeight: number
}

/**
 * The Nitro HybridObject backing `react-native-ai-image`.
 *
 * Renamed from `ImageToRgb` -> `AiImage` so the registry key, native module
 * symbols, and pod/lib names do not collide with the legacy
 * `react-native-image-to-rgb` package when both are installed side-by-side.
 */
export interface AiImage extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  convertImage(uri: string, options: ConvertOptions): Promise<ConvertResult>
  convertImageSync(uri: string, options: ConvertOptions): ConvertResult
}
