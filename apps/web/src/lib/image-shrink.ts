// Shrinking a chosen image in the browser before upload (review of P2): a phone's 3-8 MB photo
// becomes about 300 KB, so it uploads in seconds on slow 4G and fits the 5 MB limit. The server
// still decodes, resizes and re-encodes whatever arrives (docs/files.md); this only saves time.

/** The longest side sent: well above every stored box (600 × 800 at most), so nothing is lost. */
export const UPLOAD_LONG_SIDE = 1600;
/** Files at or under this size and within the long side are sent as they are. */
const SMALL_ENOUGH_BYTES = 1_000_000;

/** The size of a width × height image scaled to fit `max` on its longest side (never enlarged). */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number; scaled: boolean } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}

/**
 * The EXIF orientation (1-8) of a JPEG from its first bytes, or null (not a JPEG, or no EXIF
 * orientation before the image data).
 */
export function jpegOrientation(buffer: ArrayBuffer): number | null {
  const v = new DataView(buffer);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= v.byteLength) {
    const marker = v.getUint16(at);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || marker === 0xffd9) return null;
    const size = v.getUint16(at + 2);
    const exif = marker === 0xffe1 && at + 18 <= v.byteLength && v.getUint32(at + 4) === 0x45786966;
    if (exif) {
      const tiff = at + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > v.byteLength) return null;
      const count = v.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > v.byteLength) return null;
        if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little);
      }
      return null;
    }
    at += 2 + size;
  }
  return null;
}

/**
 * The image decoded upright. An engine that predates `imageOrientation` throws a TypeError for
 * it (review round 3): then it is decoded without the option when nothing needs turning (no EXIF
 * orientation, or 1), and otherwise not at all (null: the original is sent, and the server turns
 * it upright).
 */
export async function decodeUpright(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const orientation = jpegOrientation(await file.slice(0, 128 * 1024).arrayBuffer());
    if (orientation !== null && orientation !== 1) return null;
    return createImageBitmap(file);
  }
}

/**
 * A smaller copy of `file` to upload: JPEG (quality 0.85) on white for photos (`opaque`), PNG
 * otherwise (logos, signatures and seals keep their transparency). The original is returned when
 * the browser cannot decode it (the server then says why), when it is small already, or when the
 * copy would not be smaller.
 */
export async function shrinkForUpload(file: File, opaque: boolean): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function') return file;
    const bitmap = await decodeUpright(file);
    if (!bitmap) return file;
    const size = fitWithin(bitmap.width, bitmap.height, UPLOAD_LONG_SIDE);
    if (!size.scaled && file.size <= SMALL_ENOUGH_BYTES) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    if (opaque) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const type = opaque ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]*$/, '') + (opaque ? '.jpg' : '.png');
    return new File([blob], name, { type });
  } catch {
    return file;
  }
}
