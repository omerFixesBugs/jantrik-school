import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '@jantrik/db';
import type { IngestEnv } from '../config/ingest-env.js';

/** Driver errors that mean "not reachable (yet)": the start-up check tries again on these only. */
const UNREACHABLE = new Set([
  'DatabaseNotReachable',
  'SocketTimeout',
  'ConnectionClosed',
  'TooManyConnections',
]);

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
  /** Waits between start-up checks while the database is not reachable (about 30 s in all). */
  retryDelaysMs = [1000, 2000, 4000, 8000, 15000];

  constructor(config: ConfigService<IngestEnv, true>) {
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
   * Starts only when the check passes: the login runs ingest_resolve and reads neither students
   * nor punches (e.g. not DATABASE_URL pasted by mistake). A database that is not reachable yet is
   * asked again a few times; any other failure, or still no answer, stops the start.
   */
  async onModuleInit(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
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
        const raw = databaseError(error)?.kind;
        const kind = typeof raw === 'string' && /^[A-Za-z]{1,60}$/.test(raw) ? raw : undefined;
        const delay = this.retryDelaysMs[attempt];
        if (kind === undefined || !UNREACHABLE.has(kind) || delay === undefined) {
          throw new Error(
            `Could not check the device receiver's database login (DATABASE_INGEST_URL): ` +
              `${[errorLabel(error), kind].filter(Boolean).join(' ')}. ` +
              'The receiver does not start unchecked.',
          );
        }
        this.logger.warn(`Database not reachable (${kind}); checking again in ${delay / 1000} s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (row?.resolve === true && row.students === false && row.punches === false) return;
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

/**
 * What the driver says about a failed query: the database's error code (e.g. P0001 for RAISE,
 * 23514 for a CHECK) and message, or the kind of failure (e.g. DatabaseNotReachable).
 */
function databaseError(
  error: unknown,
): { code?: unknown; message?: unknown; kind?: unknown } | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: unknown } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause as
    { originalCode?: unknown; originalMessage?: unknown; kind?: unknown } | undefined;
  return cause && { code: cause.originalCode, message: cause.originalMessage, kind: cause.kind };
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
