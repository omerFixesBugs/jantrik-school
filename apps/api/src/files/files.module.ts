import {
  Global,
  Inject,
  Injectable,
  Module,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UPLOAD_MAX_BYTES, type StoredFileKind } from '@jantrik/shared';
import type { Request, Response } from 'express';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { FILE_STORE, type FileStore, type StoredFileMeta } from './file-store.js';
import { ImageService, type ProcessedImage } from './image.service.js';
import { PostgresFileStore } from './postgres-file-store.js';

/** What multer hands over for the `file` field (memory storage). */
export interface UploadedImage {
  buffer: Buffer;
}

/** Uploads per person per 10 minutes (decision F8): each one costs CPU to re-encode. */
export const UPLOADS_PER_USER = 60;

/**
 * A multipart route with one image in the field `file`: at most UPLOAD_MAX_BYTES (bigger: 413),
 * one file and no other fields. The type and name the browser sends are never trusted.
 */
export const ImageUpload = () =>
  applyDecorators(
    UseInterceptors(
      FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 0 } }),
    ),
  );

/** An upload ready to store: re-encoded, its kind known. */
export type PreparedImage = ProcessedImage & { kind: StoredFileKind };

/**
 * Upload → ImageService → FileStore, with the per-person limit. In two steps (from the review):
 * `prepare` touches no database (routes marked @OwnTransaction call it before opening their
 * transaction); `store` puts the file in the request's transaction.
 */
@Injectable()
export class ImageUploads {
  constructor(
    @Inject(FILE_STORE) private readonly files: FileStore,
    private readonly images: ImageService,
    private readonly limiter: RateLimiter,
    private readonly context: RequestContext,
  ) {}

  async prepare(kind: StoredFileKind, upload: UploadedImage | undefined): Promise<PreparedImage> {
    if (!upload?.buffer?.length) {
      throw apiError(400, 'FILE_REQUIRED', 'Choose an image to upload', { field: 'file' });
    }
    await this.limiter.consume({
      key: `file-upload:${this.context.requirePrincipal().userId}`,
      limit: UPLOADS_PER_USER,
      windowSec: 600,
    });
    return { kind, ...(await this.images.process(kind, upload.buffer)) };
  }

  store(image: PreparedImage, replaces: string | null): Promise<StoredFileMeta> {
    return this.files.put(image, { replaces });
  }
}

/**
 * Sends a stored image from an entity route (never /files/:id): a strong ETag (its SHA-256),
 * `Cache-Control: private, no-cache`, and 304 for a matching If-None-Match without reading the
 * bytes. 404 when there is no file.
 */
export async function sendStoredImage(
  files: FileStore,
  id: string | null,
  req: Request,
  res: Response,
): Promise<void> {
  const meta = id ? await files.meta(id) : null;
  if (!meta) throw apiError(404, 'NOT_FOUND', 'No image');
  res.setHeader('ETag', `"${meta.sha256}"`);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  const file = await files.get(meta.id);
  if (!file) throw apiError(404, 'NOT_FOUND', 'No image');
  res.type(file.mime);
  res.send(file.bytes);
}

@Global()
@Module({
  providers: [ImageService, ImageUploads, { provide: FILE_STORE, useClass: PostgresFileStore }],
  exports: [ImageService, ImageUploads, FILE_STORE],
})
export class FilesModule {}
