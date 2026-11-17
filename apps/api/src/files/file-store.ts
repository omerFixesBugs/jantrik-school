import type { StoredFileKind, StoredMime } from '@jantrik/shared';

/** What a stored file is, without its bytes. */
export interface StoredFileMeta {
  id: string;
  kind: StoredFileKind;
  mime: StoredMime;
  sizeBytes: number;
  /** Hex SHA-256 of the bytes: the ETag. */
  sha256: string;
  width: number;
  height: number;
}

export interface PutFile {
  kind: StoredFileKind;
  mime: StoredMime;
  /** Already re-encoded by ImageService: never the uploaded bytes. */
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * Where images live (docs/files.md, decision S7). Callers use only this interface, never the
 * files' tables (file-store-access.spec.ts checks it), so moving to R2/S3 later is a new
 * implementation and a copy job, with no caller changes. Every method works in the current request's institute and
 * transaction: a file another institute stored does not exist here.
 */
export interface FileStore {
  /**
   * Holds the institute's file lock until the transaction ends (put and delete take it too).
   * Take it before reading which file a row points at and replacing or clearing it, so two
   * changes of one image cannot both see the same old file (one would be left behind).
   */
  lock(): Promise<void>;
  /**
   * Stores a file; 413 STORAGE_FULL when the institute's total would pass its cap. `replaces`:
   * the file this one replaces, counted as freed, so a replacement that does not grow the total
   * is allowed near the cap, and one no bigger than the old file even over it. The caller MUST
   * then delete that file in the same transaction (after pointing the row at the new one), or
   * the total ends above the cap. Take `lock()` before reading which file is replaced.
   */
  put(file: PutFile, opts?: { replaces?: string | null }): Promise<StoredFileMeta>;
  /** The file with its bytes, or null (unknown here). */
  get(id: string): Promise<(StoredFileMeta & { bytes: Buffer }) | null>;
  /** The file without its bytes, or null. */
  meta(id: string): Promise<StoredFileMeta | null>;
  /** Deletes a file (nothing may still point at it) and gives its size back to the total. */
  delete(id: string): Promise<void>;
  /** The institute's total and cap, in bytes. */
  usage(): Promise<{ bytesUsed: number; capBytes: number }>;
}

export const FILE_STORE = Symbol('FILE_STORE');
