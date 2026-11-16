import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { ImageService, processImage, sniffImage } from './image.service.js';

// docs/files.md: what an upload becomes before it is stored. Test images are made with sharp.

const noise = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp(randomBytes(width * height * channels), { raw: { width, height, channels } });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);
  }
  return 'resolved';
};

/** A valid PNG header (IHDR) declaring width × height, with a tiny IDAT: a decompression bomb. */
function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(width + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('processImage', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'a %s photo becomes a JPEG within 600 × 800 and 200 KB',
    async (format) => {
      const input = await noise(1200, 1600).toFormat(format).toBuffer();
      const out = await processImage('STUDENT_PHOTO', input);
      expect(out.mime).toBe('image/jpeg');
      expect(out.bytes.length).toBeLessThanOrEqual(200 * 1024);
      expect(out.width).toBeLessThanOrEqual(600);
      expect(out.height).toBeLessThanOrEqual(800);
      const meta = await sharp(out.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', out.width, out.height]);
    },
  );

  it('a large, detailed photo (3000 × 2000 of noise) still fits the cap', async () => {
    const input = await noise(3000, 2000).jpeg({ quality: 95 }).toBuffer();
    const out = await processImage('STUDENT_PHOTO', input);
    expect(out.bytes.length).toBeLessThanOrEqual(200 * 1024);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(800);
  });

  it('a small photo is not enlarged', async () => {
    const out = await processImage('STUDENT_PHOTO', await noise(120, 160).png().toBuffer());
    expect([out.width, out.height]).toEqual([120, 160]);
  });

  it('strips EXIF (GPS included) after turning the photo upright', async () => {
    const input = await noise(400, 200)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Make: 'PhoneCo', Model: 'X1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 48/1 0/1' },
      })
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(input.includes(Buffer.from('PhoneCo'))).toBe(true);
    const out = await processImage('STUDENT_PHOTO', input);
    const after = await sharp(out.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(out.bytes.includes(Buffer.from('PhoneCo'))).toBe(false);
    // Rotated a quarter turn: 400 × 200 becomes 200 × 400.
    expect([out.width, out.height]).toEqual([200, 400]);
  });

  it('a transparent logo stays transparent (PNG), within 512 × 512 and 100 KB', async () => {
    const pixels = Buffer.alloc(800 * 800 * 4); // fully transparent…
    for (let i = 0; i < 200 * 800 * 4; i += 4) pixels.set([20, 90, 60, 255], i); // …but a band
    const input = await sharp(pixels, { raw: { width: 800, height: 800, channels: 4 } })
      .png()
      .toBuffer();
    const out = await processImage('LOGO', input);
    expect(out.mime).toBe('image/png');
    expect(out.bytes.length).toBeLessThanOrEqual(100 * 1024);
    expect([out.width, out.height]).toEqual([512, 512]);
    expect((await sharp(out.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('a seal too detailed for a PNG under 100 KB is stored as WebP', async () => {
    const out = await processImage('SEAL', await noise(512, 512).png().toBuffer());
    expect(out.bytes.length).toBeLessThanOrEqual(100 * 1024);
    expect(out.mime).toBe('image/webp');
  });

  it.each(['STUDENT_PHOTO', 'LOGO', 'SEAL', 'SIGNATURE'] as const)(
    'even pure noise (the worst case) is done well inside the request time: %s',
    async (kind) => {
      const input = await noise(2400, 2400, 4).png({ compressionLevel: 1 }).toBuffer();
      const started = Date.now();
      const out = await processImage(kind, input);
      expect(out.bytes.length).toBeLessThanOrEqual(
        kind === 'STUDENT_PHOTO' ? 200 * 1024 : 100 * 1024,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
    },
  );

  it('a signature is a PNG within 600 × 240', async () => {
    const out = await processImage('SIGNATURE', await noise(1200, 400).jpeg().toBuffer());
    expect(out.mime).toBe('image/png');
    expect(out.bytes.length).toBeLessThanOrEqual(100 * 1024);
    expect(out.width).toBeLessThanOrEqual(600);
    expect(out.height).toBeLessThanOrEqual(240);
  });

  it('refuses a text file, a GIF, an SVG and a truncated JPEG', async () => {
    const jpg = await noise(300, 300).jpeg().toBuffer();
    const gif = await noise(20, 20).gif().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    for (const input of [Buffer.from('hello, not an image'), gif, svg, jpg.subarray(0, 600)]) {
      expect(await code(processImage('STUDENT_PHOTO', input))).toBe('IMAGE_INVALID');
    }
  });

  it('refuses a decompression bomb by its header, without decoding it', async () => {
    const bomb = pngClaiming(50_000, 50_000);
    expect(bomb.length).toBeLessThan(60_000);
    const started = Date.now();
    expect(await code(processImage('STUDENT_PHOTO', bomb))).toBe('IMAGE_TOO_BIG');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('sniffs only JPEG, PNG and WebP', async () => {
    expect(sniffImage(await noise(4, 4).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffImage(await noise(4, 4).png().toBuffer())).toBe('png');
    expect(sniffImage(await noise(4, 4).webp().toBuffer())).toBe('webp');
    expect(sniffImage(await noise(4, 4).gif().toBuffer())).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('ImageService', () => {
  it('runs at most two images at once', async () => {
    const service = new ImageService();
    const input = await noise(1600, 1200).jpeg().toBuffer();
    let peak = 0;
    // Watch the service's own counter while five run.
    const watch = setInterval(() => {
      peak = Math.max(peak, (service as unknown as { running: number }).running);
    }, 1);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.process('STUDENT_PHOTO', input)),
    );
    clearInterval(watch);
    expect(results).toHaveLength(5);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
