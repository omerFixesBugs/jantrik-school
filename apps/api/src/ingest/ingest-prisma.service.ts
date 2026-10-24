import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '@jantrik/db';
import type { Env } from '../config/env.js';

/**
 * The device receiver's own database login (DATABASE_INGEST_URL, role jantrik_ingest_app). It may
 * run the four ingest_* functions and read no table, so a device request can never reach an
 * institute's rows. Each function runs as its own statement in READ COMMITTED (never inside a
 * longer transaction): the per-device row lock relies on every statement taking a new snapshot.
 * Provided by IngestAppModule only (ingest-isolation.spec.ts checks who imports it).
 */
@Injectable()
export class IngestPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DeviceReceiver');
  readonly client: PrismaClient;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('DATABASE_INGEST_URL', { infer: true });
    if (!url) {
      throw new Error(
        'DATABASE_INGEST_URL is required for the device receiver (login jantrik_ingest_app). ' +
          'See docs/database.md.',
      );
    }
    this.client = createPrismaClient(url);
  }

  /**
   * Refuse to start unless the login is the receiver's: it runs ingest_resolve and cannot read
   * students or punches (e.g. DATABASE_URL pasted by mistake). An unreachable database only warns
   * here; requests fail on their own then.
   */
  async onModuleInit(): Promise<void> {
    let row: { resolve: boolean; students: boolean; punches: boolean } | undefined;
    try {
      [row] = await this.client.$queryRaw<
        { resolve: boolean; students: boolean; punches: boolean }[]
      >`
        SELECT has_function_privilege(
                 'public.ingest_resolve(text, inet, timestamptz, text, integer, text)', 'EXECUTE'
               ) AS resolve,
               has_table_privilege('public.students', 'SELECT') AS students,
               has_table_privilege('public.device_punches', 'SELECT') AS punches`;
    } catch (error) {
      this.logger.warn(`Could not check the database role: ${(error as Error).message}`);
      return;
    }
    if (row?.resolve !== true || row.students !== false || row.punches !== false) {
      throw new Error(
        'DATABASE_INGEST_URL must use the device receiver login (jantrik_ingest_app): it runs ' +
          'the ingest_* functions and reads no table. See docs/database.md.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

/** The database's error code of a failed query (e.g. P0001 for RAISE, 23514 for a CHECK). */
function databaseError(error: unknown): { code?: unknown; message?: unknown } | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: unknown } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause as
    { originalCode?: unknown; originalMessage?: unknown } | undefined;
  return cause && { code: cause.originalCode, message: cause.originalMessage };
}

/**
 * The device's answer when an ingest function refused its input (`RAISE EXCEPTION 'INGEST_…'`):
 * 413 for too many rows or results, 400 otherwise. Null for any other error.
 */
export function ingestRefusalStatus(error: unknown): 400 | 413 | null {
  const db = databaseError(error);
  if (db?.code !== 'P0001' || typeof db.message !== 'string') return null;
  if (!/^INGEST_[A-Z_]+$/.test(db.message)) return null;
  return db.message.startsWith('INGEST_TOO_MANY_') ? 413 : 400;
}

/**
 * What may be logged about an error: its name and codes only. Messages are never logged: a
 * CHECK failure's detail repeats the row (tenant and device ids), and others echo device input.
 */
export function errorLabel(error: unknown): string {
  const token = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(v) ? v : undefined;
  const e = error as { name?: unknown; code?: unknown } | null;
  return [token(e?.name) ?? 'Error', token(e?.code), token(databaseError(error)?.code)]
    .filter(Boolean)
    .join(' ');
}
