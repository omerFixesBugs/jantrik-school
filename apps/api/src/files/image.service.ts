import { Injectable } from '@nestjs/common';
import {
  FILE_LIMITS,
  UPLOAD_MAX_PIXELS,
  type StoredFileKind,
  type StoredMime,
} from '@jantrik/shared';
import sharp from 'sharp';
import { apiError } from '../common/api-error.js';

// libvips' operation cache keeps recent images in memory; uploads are one-off, so it only costs RAM.
sharp.cache(false);

export interface ProcessedImage {
  bytes: Buffer;
  mime: StoredMime;
  width: number;
  height: number;
}

/** At most this many images are decoded at once per process (memory: a 48 MP photo is ~150 MB). */
const MAX_PARALLEL = 2;
/** At most this many wait for a slot; more get 503 IMAGE_BUSY instead of queueing without end. */
const MAX_WAITING = 8;

/**
 * A counting semaphore with a bounded queue. A freed slot is handed straight to the first waiter
 * (the count never drops in between), so a newcomer cannot slip in and make it MAX + 1.
 */
export class Slots {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
  ) {}

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    if (this.queue.length >= this.maxWaiting) {
      throw apiError(503, 'IMAGE_BUSY', 'Many images are being prepared; try again in a moment');
    }
    await new Promise<void>((go) => this.queue.push(go));
  }

  release(): void {
    const next = this.queue.shift();
    if (next)
      next(); // the slot passes on: running stays the same
    else this.running--;
  }
}

/**
 * Turns an upload into what is stored (docs/files.md, decision S7): only JPEG, PNG or WebP by
 * content, at most UPLOAD_MAX_PIXELS, EXIF orientation applied, shrunk into the kind's box and
 * re-encoded until it fits the kind's cap. Nothing of the upload is kept but its pixels: EXIF
 * (GPS), ICC, XMP and comments are never copied.
 */
@Injectable()
export class ImageService {
  private readonly slots = new Slots(MAX_PARALLEL, MAX_WAITING);

  async process(kind: StoredFileKind, input: Buffer): Promise<ProcessedImage> {
    await this.slots.acquire();
    try {
      return await processImage(kind, input);
    } finally {
      this.slots.release();
    }
  }
}

type Sniffed = 'jpeg' | 'png' | 'webp';

/** The format by its magic bytes, before any decoder sees the data (no SVG, GIF, HEIC, PDF…). */
export function sniffImage(input: Buffer): Sniffed | null {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    return 'jpeg';
  }
  if (
    input.length >= 8 &&
    input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    input.length >= 12 &&
    input.toString('latin1', 0, 4) === 'RIFF' &&
    input.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

const invalid = () =>
  apiError(422, 'IMAGE_INVALID', 'The file is not a JPEG, PNG or WebP image, or it is damaged');

/** Seconds a decode or an encode may take (sharp's own timer), well inside the queue's turn. */
const SHARP_TIMEOUT = { seconds: 10 };

/** sharp's error as the API's: its timeout → 422 IMAGE_TIMEOUT, anything else IMAGE_INVALID. */
export function imageFailure(error: unknown) {
  return /timeout/i.test((error as Error)?.message ?? '')
    ? apiError(422, 'IMAGE_TIMEOUT', 'The image took too long to process; try a simpler one')
    : invalid();
}

/** sharp's types are an `export =` namespace; these are the shapes used here. */
type Sharp = ReturnType<typeof sharp>;
type Metadata = Awaited<ReturnType<Sharp['metadata']>>;
interface RawImage {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}

interface Encoder {
  mime: StoredMime;
  apply(image: Sharp): Sharp;
}

const jpeg = (quality: number): Encoder => ({
  mime: 'image/jpeg',
  apply: (i) => i.jpeg({ quality, mozjpeg: true }),
});
const png = (colours: number): Encoder => ({
  mime: 'image/png',
  apply: (i) => i.png({ palette: true, colours, quality: 90, compressionLevel: 9, effort: 4 }),
});
const webp = (quality: number): Encoder => ({
  mime: 'image/webp',
  apply: (i) => i.webp({ quality, alphaQuality: 90, effort: 4 }),
});

/** Encoders per kind, best first; the first result under the cap wins. */
function encodersFor(kind: StoredFileKind): { flatten: boolean; encoders: Encoder[] } {
  switch (kind) {
    case 'STUDENT_PHOTO':
    case 'APPLICANT_PHOTO':
      return { flatten: true, encoders: [85, 75, 65, 55, 45].map(jpeg) };
    case 'LOGO':
    case 'SEAL':
      return { flatten: false, encoders: [png(256), ...[90, 75, 60, 50].map(webp)] };
    case 'SIGNATURE':
      return { flatten: false, encoders: [256, 64, 16].map(png) };
    case 'DOCUMENT_ASSET':
      // P8 (the document designer) decides how its assets are processed; nothing uploads one yet.
      throw new Error('DOCUMENT_ASSET uploads are not supported yet');
  }
}

export async function processImage(kind: StoredFileKind, input: Buffer): Promise<ProcessedImage> {
  const limit = FILE_LIMITS[kind];
  const { flatten, encoders } = encodersFor(kind);
  if (!sniffImage(input)) throw invalid();

  // The pixel count is checked before anything is decoded.
  let meta: Metadata;
  try {
    // The header only (no pixel limit here, so a bomb is reported as too big, not as damaged).
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw invalid();
  }
  if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format ?? '')) {
    throw invalid();
  }
  if (meta.width * meta.height > UPLOAD_MAX_PIXELS) {
    throw apiError(
      422,
      'IMAGE_TOO_BIG',
      `The image has too many pixels (at most ${UPLOAD_MAX_PIXELS / 1_000_000} megapixels)`,
    );
  }

  // Decode once (first frame of an animation), upright, shrunk into the box, as raw pixels.
  const box = limit.box!;
  let raw: RawImage;
  try {
    let pipeline = sharp(input, { limitInputPixels: UPLOAD_MAX_PIXELS, failOn: 'truncated' })
      .rotate()
      .resize(box.width, box.height, { fit: 'inside', withoutEnlargement: true });
    if (flatten) pipeline = pipeline.flatten({ background: '#ffffff' });
    raw = await pipeline.raw().timeout(SHARP_TIMEOUT).toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw imageFailure(error);
  }

  const fromRaw = () =>
    sharp(raw.data, {
      raw: {
        width: raw.info.width,
        height: raw.info.height,
        channels: raw.info.channels as 1 | 2 | 3 | 4,
      },
    });

  // Smaller dimensions only when no encoder fits at this size (a very detailed image).
  for (const scale of [1, 0.8, 0.64, 0.5]) {
    const width = Math.max(1, Math.round(raw.info.width * scale));
    const height = Math.max(1, Math.round(raw.info.height * scale));
    for (const encoder of encoders) {
      const sized = scale === 1 ? fromRaw() : fromRaw().resize(width, height, { fit: 'fill' });
      let encoded: RawImage;
      try {
        encoded = await encoder
          .apply(sized)
          .timeout(SHARP_TIMEOUT)
          .toBuffer({ resolveWithObject: true });
      } catch (error) {
        throw imageFailure(error);
      }
      const { data, info } = encoded;
      if (data.length <= limit.maxBytes) {
        return { bytes: data, mime: encoder.mime, width: info.width, height: info.height };
      }
    }
  }
  throw apiError(
    422,
    'IMAGE_CANNOT_SHRINK',
    'The image could not be made small enough; try another',
  );
}
