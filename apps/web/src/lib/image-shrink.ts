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
 * A smaller copy of `file` to upload: JPEG (quality 0.85) on white for photos (`opaque`), PNG
 * otherwise (logos, signatures and seals keep their transparency). The original is returned when
 * the browser cannot decode it (the server then says why), when it is small already, or when the
 * copy would not be smaller.
 */
export async function shrinkForUpload(file: File, opaque: boolean): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function') return file;
    const bitmap = await createImageBitmap(file); // EXIF orientation applied by the browser
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
