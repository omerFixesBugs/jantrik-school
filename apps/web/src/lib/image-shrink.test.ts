import { describe, expect, it } from 'vitest';
import { fitWithin, shrinkForUpload, UPLOAD_LONG_SIDE } from './image-shrink';

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

describe('shrinkForUpload', () => {
  it('sends the original when the browser cannot decode images (no createImageBitmap)', async () => {
    const file = new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' });
    expect(await shrinkForUpload(file, true)).toBe(file);
  });
});
