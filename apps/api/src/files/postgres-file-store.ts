import { createHash } from 'node:crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_LIMITS, type StoredMime } from '@jantrik/shared';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { Db } from '../tenancy/db.service.js';
import type { FileStore, PutFile, StoredFileMeta } from './file-store.js';

const META = {
  id: true,
  kind: true,
  mime: true,
  sizeBytes: true,
  sha256: true,
  width: true,
  height: true,
} as const;

/**
 * FileStore in Postgres (decision S7): stored_files under the same RLS as every tenant row, so the
 * existing backups cover the files. The only code that touches stored_files and
 * stored_file_usage (file-store-access.spec.ts). Works in the request's transaction: a file and
 * the row that points at it commit or roll back together.
 */
@Injectable()
export class PostgresFileStore implements FileStore {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get capBytes(): number {
    return this.config.get('FILE_STORAGE_PER_TENANT_MB', { infer: true }) * 1024 * 1024;
  }

  /**
   * The institute's lock: every put and delete holds it until commit, so two uploads at once
   * cannot both pass the cap, and the total always equals the sum of the rows.
   */
  async lock(): Promise<void> {
    await this.db.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('stored-files:' || app_current_tenant_id()::text, 0))`;
  }

  async put(file: PutFile): Promise<StoredFileMeta> {
    const limit = FILE_LIMITS[file.kind];
    const size = file.bytes.length;
    // ImageService guarantees these; reaching here otherwise is a bug, not a user error.
    if (size === 0 || size > limit.maxBytes || !limit.mimes.includes(file.mime)) {
      throw new InternalServerErrorException(`A ${file.kind} of ${size} bytes (${file.mime})`);
    }
    const tx = this.db.tx;
    const tenantId = this.context.requireTenantId();
    await this.lock();
    const usage = await tx.storedFileUsage.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
      select: { bytesUsed: true },
    });
    const capBytes = this.capBytes;
    const bytesUsed = Number(usage.bytesUsed);
    if (bytesUsed + size > capBytes) {
      throw apiError(413, 'STORAGE_FULL', "The institute's storage for images is full", {
        bytesUsed,
        capBytes,
      });
    }
    const row = await tx.storedFile.create({
      data: {
        tenantId,
        kind: file.kind,
        mime: file.mime,
        bytes: new Uint8Array(file.bytes),
        sizeBytes: size,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        width: file.width,
        height: file.height,
        createdById: this.context.principal?.userId ?? null,
      },
      select: META,
    });
    await tx.storedFileUsage.update({
      where: { tenantId },
      data: { bytesUsed: { increment: size }, fileCount: { increment: 1 } },
      select: { id: true },
    });
    return toMeta(row);
  }

  async get(id: string): Promise<(StoredFileMeta & { bytes: Buffer }) | null> {
    const row = await this.db.tx.storedFile.findUnique({
      where: { id },
      select: { ...META, bytes: true },
    });
    if (!row) return null;
    const { bytes, ...meta } = row;
    return { ...toMeta(meta), bytes: Buffer.from(bytes) };
  }

  async meta(id: string): Promise<StoredFileMeta | null> {
    const row = await this.db.tx.storedFile.findUnique({ where: { id }, select: META });
    return row ? toMeta(row) : null;
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.tx;
    await this.lock();
    const row = await tx.storedFile.findUnique({ where: { id }, select: { sizeBytes: true } });
    if (!row) return;
    await tx.storedFile.delete({ where: { id }, select: { id: true } });
    await tx.storedFileUsage.updateMany({
      data: { bytesUsed: { decrement: row.sizeBytes }, fileCount: { decrement: 1 } },
    });
  }

  async usage(): Promise<{ bytesUsed: number; capBytes: number }> {
    const row = await this.db.tx.storedFileUsage.findFirst({ select: { bytesUsed: true } });
    return { bytesUsed: Number(row?.bytesUsed ?? 0), capBytes: this.capBytes };
  }
}

function toMeta(row: {
  id: string;
  kind: StoredFileMeta['kind'];
  mime: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
}): StoredFileMeta {
  return { ...row, mime: row.mime as StoredMime };
}
