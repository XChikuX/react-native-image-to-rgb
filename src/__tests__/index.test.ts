// Jest tests for the JS wrapper layer. The native Nitro HybridObject is mocked
// out — these tests exercise option normalization, preset expansion, the
// back-compat shim, and typed-array helpers, which contain ~all of the
// JS-side logic that ships to users.

let lastCall: { uri: string; options: any } | undefined

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: jest.fn(() => ({
      convertImage: jest.fn(async (uri: string, options: unknown) => {
        lastCall = { uri, options: options as any }
        return mockFakeResult(options)
      }),
      convertImageSync: jest.fn((uri: string, options: unknown) => {
        lastCall = { uri, options: options as any }
        return mockFakeResult(options)
      }),
    })),
  },
}))

function mockFakeResult(options: any) {
  const channels =
    options?.pixelFormat === 'rgba' ||
    options?.pixelFormat === 'argb' ||
    options?.pixelFormat === 'bgra' ||
    options?.pixelFormat === 'abgr'
      ? 4
      : 3
  const bps =
    options?.dataType === 'float32'
      ? 4
      : options?.dataType === 'uint16' || options?.dataType === 'float16'
        ? 2
        : 1
  const w = options?.width ?? 1
  const h = options?.height ?? 1
  return {
    data: new ArrayBuffer(w * h * channels * bps),
    width: w,
    height: h,
    channels,
    pixelFormat: options?.pixelFormat ?? 'rgb',
    dataType: options?.dataType ?? 'uint8',
    channelLayout: options?.channelLayout ?? 'hwc',
    contentX: 0,
    contentY: 0,
    contentWidth: w,
    contentHeight: h,
    sourceWidth: w,
    sourceHeight: h,
  }
}

import {
  asTypedArray,
  bytesPerSample,
  channelsFor,
  convertImage,
  convertImageSync,
  convertToRGB,
  toTFLiteInput,
  toYoloInput,
} from '../index'

beforeEach(() => {
  lastCall = undefined
})

describe('convertImage', () => {
  it('applies all strong defaults when no options are passed', async () => {
    await convertImage('file:///tmp/x.jpg')
    expect(lastCall?.options).toMatchObject({
      pixelFormat: 'rgb',
      dataType: 'uint8',
      channelLayout: 'hwc',
      resizeMode: 'stretch',
      letterboxR: 114,
      letterboxG: 114,
      letterboxB: 114,
      rotation: 0,
      ignoreExif: false,
    })
    // Integer dtype must NOT forward normalization fields.
    expect(lastCall?.options.meanR).toBeUndefined()
    expect(lastCall?.options.stdR).toBeUndefined()
  })

  it('rejects on empty uri', async () => {
    await expect(convertImage('')).rejects.toThrow(/non-empty string/)
  })

  it('throws synchronously on empty uri in sync API', () => {
    expect(() => convertImageSync('')).toThrow(/non-empty string/)
  })

  it('forwards crop and explicit rotation', async () => {
    await convertImage('file:///x.png', {
      crop: { x: 10, y: 20, width: 100, height: 200 },
      rotation: 90,
      ignoreExif: true,
    })
    expect(lastCall?.options.crop).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    })
    expect(lastCall?.options.rotation).toBe(90)
    expect(lastCall?.options.ignoreExif).toBe(true)
  })

  it('letterboxColor overrides the default 114 gray', async () => {
    await convertImage('file:///x.png', { letterboxColor: [0, 255, 128] })
    expect(lastCall?.options.letterboxR).toBe(0)
    expect(lastCall?.options.letterboxG).toBe(255)
    expect(lastCall?.options.letterboxB).toBe(128)
  })
})

describe('normalization presets', () => {
  it('expands "0-1" preset for float32', async () => {
    await convertImage('a', { dataType: 'float32', normalization: '0-1' })
    expect(lastCall?.options).toMatchObject({
      meanR: 0,
      meanG: 0,
      meanB: 0,
      stdR: 255,
      stdG: 255,
      stdB: 255,
    })
  })

  it('expands "-1-1" preset for float16', async () => {
    await convertImage('a', { dataType: 'float16', normalization: '-1-1' })
    expect(lastCall?.options).toMatchObject({
      meanR: 127.5,
      meanG: 127.5,
      meanB: 127.5,
      stdR: 127.5,
      stdG: 127.5,
      stdB: 127.5,
    })
  })

  it('expands "imagenet" preset', async () => {
    await convertImage('a', { dataType: 'float32', normalization: 'imagenet' })
    expect(lastCall?.options.meanR).toBeCloseTo(123.675, 3)
    expect(lastCall?.options.meanG).toBeCloseTo(116.28, 3)
    expect(lastCall?.options.meanB).toBeCloseTo(103.53, 3)
    expect(lastCall?.options.stdR).toBeCloseTo(58.395, 3)
  })

  it('"yolo" is an alias of "0-1"', async () => {
    await convertImage('a', { dataType: 'float32', normalization: 'yolo' })
    expect(lastCall?.options.stdR).toBe(255)
  })

  it('accepts explicit per-channel mean/std as numbers', async () => {
    await convertImage('a', {
      dataType: 'float32',
      normalization: { mean: 0, std: 1 },
    })
    expect(lastCall?.options.meanR).toBe(0)
    expect(lastCall?.options.stdR).toBe(1)
  })

  it('accepts explicit per-channel mean/std as triplets', async () => {
    await convertImage('a', {
      dataType: 'float32',
      normalization: { mean: [1, 2, 3], std: [10, 20, 30] },
    })
    expect(lastCall?.options).toMatchObject({
      meanR: 1,
      meanG: 2,
      meanB: 3,
      stdR: 10,
      stdG: 20,
      stdB: 30,
    })
  })

  it('rejects an unknown preset', async () => {
    await expect(
      convertImage('a', {
        dataType: 'float32',

        normalization: 'wat' as any,
      })
    ).rejects.toThrow(/Unknown normalization preset/)
  })

  it('rejects zero std', async () => {
    await expect(
      convertImage('a', {
        dataType: 'float32',
        normalization: { mean: 0, std: 0 },
      })
    ).rejects.toThrow(/std must be non-zero/)
  })

  it('warns and skips normalization for integer dtype', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await convertImage('a', { dataType: 'uint8', normalization: '-1-1' })
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/ignored for integer dataType "uint8"/)
    )
    expect(lastCall?.options.meanR).toBeUndefined()
    spy.mockRestore()
  })
})

describe('preset helpers', () => {
  it('toYoloInput uses canonical darknet/YOLO defaults', async () => {
    await toYoloInput('img.jpg')
    expect(lastCall?.options).toMatchObject({
      width: 416,
      height: 416,
      pixelFormat: 'rgb',
      dataType: 'float32',
      channelLayout: 'chw',
      resizeMode: 'letterbox',
      letterboxR: 114,
      letterboxG: 114,
      letterboxB: 114,
      stdR: 255,
      stdG: 255,
      stdB: 255,
      meanR: 0,
      meanG: 0,
      meanB: 0,
    })
  })

  it('toYoloInput honors custom size (e.g. 640 for YOLOv5)', async () => {
    await toYoloInput('img.jpg', 640)
    expect(lastCall?.options.width).toBe(640)
    expect(lastCall?.options.height).toBe(640)
  })

  it('toTFLiteInput defaults to 224x224 uint8 HWC RGB', async () => {
    await toTFLiteInput('img.jpg')
    expect(lastCall?.options).toMatchObject({
      width: 224,
      height: 224,
      pixelFormat: 'rgb',
      dataType: 'uint8',
      channelLayout: 'hwc',
    })
    // No normalization applied for uint8.
    expect(lastCall?.options.meanR).toBeUndefined()
  })

  it('toTFLiteInput supports float models with normalization', async () => {
    await toTFLiteInput('img.jpg', {
      size: 240,
      dataType: 'float32',
      normalization: 'imagenet',
    })
    expect(lastCall?.options.width).toBe(240)
    expect(lastCall?.options.dataType).toBe('float32')
    expect(lastCall?.options.meanR).toBeCloseTo(123.675, 3)
  })
})

describe('back-compat: convertToRGB', () => {
  it('returns a plain number[] in RGB uint8 HWC order', async () => {
    const arr = await convertToRGB('file://x.png')
    expect(Array.isArray(arr)).toBe(true)
    expect(lastCall?.options).toMatchObject({
      pixelFormat: 'rgb',
      dataType: 'uint8',
      channelLayout: 'hwc',
    })
  })
})

describe('typed-array helpers', () => {
  const baseResult = {
    data: new ArrayBuffer(12),
    width: 1,
    height: 1,
    channels: 3,
    pixelFormat: 'rgb' as const,
    channelLayout: 'hwc' as const,
    contentX: 0,
    contentY: 0,
    contentWidth: 1,
    contentHeight: 1,
    sourceWidth: 1,
    sourceHeight: 1,
  }

  it('asTypedArray returns the right view per dtype', () => {
    expect(asTypedArray({ ...baseResult, dataType: 'uint8' })).toBeInstanceOf(
      Uint8Array
    )
    expect(asTypedArray({ ...baseResult, dataType: 'int8' })).toBeInstanceOf(
      Int8Array
    )
    expect(asTypedArray({ ...baseResult, dataType: 'uint16' })).toBeInstanceOf(
      Uint16Array
    )
    expect(asTypedArray({ ...baseResult, dataType: 'float16' })).toBeInstanceOf(
      Uint16Array
    )
    expect(asTypedArray({ ...baseResult, dataType: 'float32' })).toBeInstanceOf(
      Float32Array
    )
  })

  it('bytesPerSample maps each dtype correctly', () => {
    expect(bytesPerSample('uint8')).toBe(1)
    expect(bytesPerSample('int8')).toBe(1)
    expect(bytesPerSample('uint16')).toBe(2)
    expect(bytesPerSample('float16')).toBe(2)
    expect(bytesPerSample('float32')).toBe(4)
  })

  it('channelsFor: 3-channel vs 4-channel formats', () => {
    expect(channelsFor('rgb')).toBe(3)
    expect(channelsFor('bgr')).toBe(3)
    expect(channelsFor('rgba')).toBe(4)
    expect(channelsFor('bgra')).toBe(4)
    expect(channelsFor('argb')).toBe(4)
    expect(channelsFor('abgr')).toBe(4)
  })
})
