import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeUpright,
  fitWithin,
  jpegOrientation,
  shrinkForUpload,
  UPLOAD_LONG_SIDE,
} from './image-shrink';

/** A JPEG start with an EXIF APP1 segment holding only the Orientation tag. */
function jpegWithOrientation(
  orientation: number,
  order: 'MM' | 'II' = 'MM',
): Uint8Array<ArrayBuffer> {
  const be = order === 'MM';
  const u16 = (n: number) => (be ? [n >> 8, n & 255] : [n & 255, n >> 8]);
  const u32 = (n: number) =>
    be
      ? [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]
      : [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
  const tiff = [
    ...(be ? [0x4d, 0x4d] : [0x49, 0x49]),
    ...u16(42),
    ...u32(8),
    ...u16(1), // one IFD entry
    ...u16(0x0112), // Orientation
    ...u16(3), // SHORT
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const app1 = [...[0x45, 0x78, 0x69, 0x66, 0, 0], ...tiff]; // "Exif\0\0"
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]);
}

describe('fitWithin (the browser-side shrink before upload)', () => {
  it('scales the long side down to the limit, keeping the shape', () => {
    expect(fitWithin(4000, 3000, UPLOAD_LONG_SIDE)).toEqual({
      width: 1600,
      height: 1200,
      scaled: true,
    });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600, scaled: true });
  });

  it('never enlarges a small image', () => {
    expect(fitWithin(600, 800, 1600)).toEqual({ width: 600, height: 800, scaled: false });
    expect(fitWithin(1, 1, 1600)).toEqual({ width: 1, height: 1, scaled: false });
  });

  it('keeps at least one pixel a side', () => {
    expect(fitWithin(100_000, 10, 1600)).toEqual({ width: 1600, height: 1, scaled: true });
  });
});

describe('jpegOrientation', () => {
  it('reads the EXIF orientation of a JPEG (both byte orders), null without one', () => {
    expect(jpegOrientation(jpegWithOrientation(6).buffer as ArrayBuffer)).toBe(6);
    expect(jpegOrientation(jpegWithOrientation(3, 'II').buffer as ArrayBuffer)).toBe(3);
    expect(jpegOrientation(jpegWithOrientation(1).buffer as ArrayBuffer)).toBe(1);
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull();
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
  });
});

describe('decodeUpright (an engine without imageOrientation, review round 3)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const oldEngine = () => {
    const decoded = { width: 10, height: 10, close: () => undefined };
    const decode = vi.fn((_file: Blob, options?: object) =>
      options ? Promise.reject(new TypeError('unknown option')) : Promise.resolve(decoded),
    );
    vi.stubGlobal('createImageBitmap', decode);
    return { decode, decoded };
  };

  it('decodes without the option when nothing needs turning', async () => {
    const { decode, decoded } = oldEngine();
    const upright = new File([jpegWithOrientation(1)], 'a.jpg', { type: 'image/jpeg' });
    expect(await decodeUpright(upright)).toBe(decoded);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', {
      type: 'image/png',
    });
    expect(await decodeUpright(png)).toBe(decoded);
    expect(decode).toHaveBeenCalledTimes(4);
  });

  it('gives up (the original is sent; the server turns it) when the photo needs turning', async () => {
    const { decode } = oldEngine();
    const sideways = new File([jpegWithOrientation(6)], 'a.jpg', { type: 'image/jpeg' });
    expect(await decodeUpright(sideways)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('shrinkForUpload', () => {
  it('sends the original when the browser cannot decode images (no createImageBitmap)', async () => {
    const file = new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' });
    expect(await shrinkForUpload(file, true)).toBe(file);
  });
});
