# react-native-image-to-rgb

> Fast, zero-copy image → RGB tensor conversion for React Native, built on [**Nitro Modules**](https://github.com/mrousavy/nitro). Strong, opinionated defaults for **darknet/YOLOv4** and **TFLite** pipelines.

[![version](https://img.shields.io/npm/v/react-native-image-to-rgb.svg)](https://www.npmjs.com/package/react-native-image-to-rgb)
[![license](https://img.shields.io/npm/l/react-native-image-to-rgb.svg)](https://github.com/XChikuX/react-native-image-to-rgb/blob/main/LICENSE)

`react-native-image-to-rgb` decodes an image, applies EXIF orientation, optionally crops/rotates, resizes it (`stretch` / `cover` / `contain` / **`letterbox`**), and packs the pixels into a tightly-laid-out `ArrayBuffer` ready to feed to TFLite, ONNX, CoreML, or darknet/YOLO models — **without ever materialising a JS `number[]`**.

Why care?

- **Zero copy.** The output `ArrayBuffer` is shared between native and JS via JSI. No serialisation, no `Bridge`. Hand it straight to `react-native-fast-tflite` (≥ 1.4) or `onnxruntime-react-native`.
- **Every dtype you actually need.** `uint8`, `int8`, `uint16`, `float16` (binary16), `float32`. The bytes are written natively, so float16 doesn't require a userland encoder.
- **Tier C accuracy.** `letterbox` resize with explicit padding colour and reported content rect — the standard YOLOv4/v5/v8 pre-processing — done at native speed.
- **HWC and CHW.** TFLite wants HWC. darknet/YOLO and most ONNX models want CHW. Both are first-class.

---

## Installation

```sh
bun add react-native-image-to-rgb react-native-nitro-modules
# or: yarn add / npm i — they all work
cd ios && pod install
```

> `react-native-nitro-modules` is a **peer dependency** and must also be installed in your app.

The library requires React Native **0.71+**, iOS **13+**, Android **API 24+**.

---

## Quickstart

```ts
import { convertImage, asTypedArray } from 'react-native-image-to-rgb'

const { data, width, height, contentX, contentY, contentWidth, contentHeight } =
  await convertImage(uri, {
    width: 640,
    height: 640,
    pixelFormat: 'rgb',
    dataType: 'float32',
    channelLayout: 'chw',
    resizeMode: 'letterbox',     // YOLO-style aspect-preserving resize
    normalization: 'yolo',       // == { mean: 0, std: 255 }
  })

const tensor = asTypedArray({ ...result, data })  // Float32Array view
const detections = await yolo.run([tensor.buffer])
```

---

## API

### `convertImage(uri, options?) → Promise<ConvertResult>`
### `convertImageSync(uri, options?) → ConvertResult`

`uri` accepts:

| Form | Example |
|---|---|
| File path | `'/var/mobile/.../IMG_0001.jpg'` |
| File URL | `'file:///tmp/photo.png'` |
| Content URI (Android) | `'content://media/external/images/media/42'` |
| HTTP(S) | `'https://example.com/cat.jpg'` |
| Data URI | `'data:image/jpeg;base64,/9j/4AAQ…'` |

`options` (all fields optional, see defaults below):

| Field | Type | Default | Notes |
|---|---|---|---|
| `width` / `height` | `number` | _source size_ | Target output dimensions. |
| `crop` | `{ x, y, width, height }` | none | Source-space crop applied **after** EXIF normalisation. |
| `pixelFormat` | `'rgb' \| 'rgba' \| 'argb' \| 'bgr' \| 'bgra' \| 'abgr'` | `'rgb'` | 3- or 4-channel order. |
| `dataType` | `'uint8' \| 'int8' \| 'uint16' \| 'float16' \| 'float32'` | `'uint8'` | Includes Tier-C `int8`, `uint16`, `float16`. |
| `channelLayout` | `'hwc' \| 'chw'` | `'hwc'` | `'chw'` for darknet/YOLO/ONNX. |
| `resizeMode` | `'stretch' \| 'cover' \| 'contain' \| 'letterbox'` | `'stretch'` | `'letterbox'` is an alias of `'contain'`. |
| `letterboxColor` | `[R, G, B]` (0..255) | `[114, 114, 114]` | Canonical YOLO gray. |
| `normalization` | _preset_ \| `{ mean, std }` | `'none'` | **Only applied for float dtypes.** |
| `rotation` | `0 \| 90 \| 180 \| 270` | `0` | Applied **after** EXIF. |
| `ignoreExif` | `boolean` | `false` | If true, skip auto-EXIF orientation. |

#### `ConvertResult`

```ts
{
  data: ArrayBuffer       // tightly packed, length = width*height*channels*bytesPerSample
  width, height, channels // output dims
  pixelFormat, dataType, channelLayout
  contentX, contentY, contentWidth, contentHeight  // image rect inside the canvas (relevant for letterbox)
  sourceWidth, sourceHeight                        // dims after EXIF, before any resize
}
```

For letterboxed input, use `contentX/Y/Width/Height` to un-project detection coordinates back to source pixels.

### Normalization

Output value per channel = `(byte − mean) / std`. **Only applied when `dataType` is `float16` or `float32`** — for integer dtypes the raw 0..255 / 0..65535 / −128..127 byte value is written, and passing `normalization` will log a warning and be ignored.

| Preset | mean (R, G, B) | std (R, G, B) | Use for |
|---|---|---|---|
| `'none'` | 0, 0, 0 | 1, 1, 1 | Raw float bytes (0..255). |
| `'0-1'` | 0, 0, 0 | 255, 255, 255 | Float TFLite, many ONNX. |
| `'-1-1'` | 127.5, 127.5, 127.5 | 127.5, 127.5, 127.5 | MobileNet, Inception. |
| `'imagenet'` | 123.675, 116.28, 103.53 | 58.395, 57.12, 57.375 | torchvision-trained models. |
| `'yolo'` | 0, 0, 0 | 255, 255, 255 | Alias of `'0-1'`. |

Or pass explicit values:

```ts
normalization: { mean: 0, std: 1 }                     // broadcast
normalization: { mean: [1, 2, 3], std: [10, 20, 30] }  // per channel
```

### `toYoloInput(uri, size = 416) → Promise<ConvertResult>`

One-call preset for **darknet / YOLOv4 / YOLOv5 / YOLOv8**. Sets RGB, float32, CHW, letterbox with `[114, 114, 114]` padding, `/255` normalisation. Pass `size: 608` (high-res YOLOv4), `size: 640` (YOLOv5/v8), etc.

```ts
const { data, contentX, contentY, contentWidth, contentHeight } =
  await toYoloInput(uri, 416)
```

### `toTFLiteInput(uri, opts?) → Promise<ConvertResult>`

One-call preset for **TFLite mobile classifiers**. Defaults to `224 × 224 × 3` uint8 HWC RGB (MobileNetV2 / EfficientNet-Lite). For float models:

```ts
// Float MobileNet
await toTFLiteInput(uri, { dataType: 'float32', normalization: '-1-1' })
// EfficientNet-B0 ImageNet
await toTFLiteInput(uri, { size: 224, dataType: 'float32', normalization: 'imagenet' })
```

### Typed-array helpers

```ts
import { asTypedArray, bytesPerSample, channelsFor } from 'react-native-image-to-rgb'

const view = asTypedArray(result)
// → Uint8Array | Int8Array | Uint16Array | Float32Array
// (float16 returns a Uint16Array of raw IEEE-754 half-floats —
//  pass `view.buffer` straight to the inference engine.)
```

### `convertToRGB(uri) → Promise<number[]>`  *(deprecated)*

Drop-in replacement for the v0.1.x API that returns a plain `number[]` of interleaved RGB bytes. Use `convertImage` instead — it is dramatically faster and avoids the boxing cost.

---

## Worked examples

### YOLOv4 (darknet) with [`react-native-fast-tflite`](https://github.com/mrousavy/react-native-fast-tflite)

```ts
import { toYoloInput } from 'react-native-image-to-rgb'

const yolo = await loadTensorflowModel(require('./yolov4-416.tflite'))

const input = await toYoloInput(uri, 416)
const [boxes, scores, classes] = await yolo.run([input.data])

// Un-project to source pixels: a detected (x, y, w, h) in the 416×416 canvas maps to:
const sx = (x: number) => (x - input.contentX) * input.sourceWidth / input.contentWidth
const sy = (y: number) => (y - input.contentY) * input.sourceHeight / input.contentHeight
```

### TFLite MobileNetV2 float

```ts
import { toTFLiteInput, asTypedArray } from 'react-native-image-to-rgb'

const m = await loadTensorflowModel(require('./mobilenet_v2_1.0_224.tflite'))

const result = await toTFLiteInput(uri, {
  size: 224, dataType: 'float32', normalization: '-1-1',
})
const out = await m.run([asTypedArray(result).buffer])
```

### Quantised TFLite (uint8 / int8)

```ts
// Quantised MobileNet uses uint8 with NO normalisation
await toTFLiteInput(uri, { size: 224, dataType: 'uint8' })

// Some quant models use signed int8 (zero-point 128):
await convertImage(uri, {
  width: 224, height: 224, dataType: 'int8', channelLayout: 'hwc',
})
```

### Float16 input (Apple Neural Engine, some EdgeTPU paths)

```ts
const result = await convertImage(uri, {
  width: 192, height: 192,
  dataType: 'float16',
  normalization: '0-1',
})
// asTypedArray returns Uint16Array — pass result.data straight to the engine.
```

### Inside a vision-camera worklet (synchronous)

```ts
const frame = useFrameProcessor((frame) => {
  'worklet'
  const tensor = convertImageSync(frame.toString(), {
    width: 224, height: 224, dataType: 'uint8',
  })
  detector.runSync([tensor.data])
}, [])
```

---

## Migration from v0.1.x

The v0.1.x `convertToRGB(uri) → Promise<number[]>` API is kept as a deprecated shim. Migration is a 1-line change:

```diff
- const arr = await convertToRGB(uri)                   // number[]  (slow, ~100× allocation)
+ const { data } = await convertImage(uri, { dataType: 'uint8' })  // ArrayBuffer (zero-copy)
- const view = new Uint8Array(arr)
+ const view = new Uint8Array(data)
```

---

## How it works

- **iOS** (Swift) uses Core Graphics / Accelerate (`vImage` under the hood of `CGContext`) to decode + resize at full hardware speed, then a single sweep packs the pixels into a Nitro `ArrayBuffer` using `ArrayBuffer.allocate`.
- **Android** (Kotlin) uses `BitmapFactory` (with EXIF via `androidx.exifinterface`) + `Bitmap.createScaledBitmap` (bilinear), then packs into a direct `ByteBuffer` wrapped as a Nitro `ArrayBuffer`.
- Both platforms apply EXIF first, then explicit rotation, then crop, then resize, then a **single** packing pass that handles all `pixelFormat × dataType × channelLayout` combinations — there is no intermediate copy.

---

## Contributing

```sh
bun install
bun run specs       # re-run nitrogen if you change src/specs/*.nitro.ts
bun run typecheck
bun run lint
bun test
```

---

## Credits

Built on top of [Marc Rousavy](https://github.com/mrousavy)'s [Nitro Modules](https://github.com/mrousavy/nitro). Originally inspired by, and a complete rewrite of, the v0.1.x version of `react-native-image-to-rgb`.

## License

MIT © [XChikuX](https://github.com/XChikuX)
