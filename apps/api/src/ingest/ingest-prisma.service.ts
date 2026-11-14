import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PoolOptions, type PrismaClient } from '@jantrik/db';
import type { IngestEnv } from '../config/ingest-env.js';

/** How long one start-up check, or opening one connection, may take. */
const STARTUP_CHECK_TIMEOUT_MS = 10_000;

/**
 * The receiver's connection pool: opening a connection fails after the check's time limit instead
 * of waiting forever (a check that timed out while connecting does not keep its attempt in the
 * pool), and TCP keep-alive notices a database that went away. Queries themselves have no time
 * limit yet (decision #79 in docs/decisions-pending.md).
 */
export const INGEST_POOL: PoolOptions = {
  connectionTimeoutMillis: STARTUP_CHECK_TIMEOUT_MS,
  keepAlive: true,
};

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
  /**
   * Waits between start-up checks while the check itself fails, about 3 minutes in all: the
   * database may not be reachable yet, or not migrated yet (the e2e run starts the API before its
   * global setup migrates the database).
   */
  retryDelaysMs = [1000, 2000, 4000, 8000, ...Array<number>(11).fill(15000)];
  /**
   * How long one start-up check may take before it counts as failed (and is asked again): a
   * database that accepts the connection and never answers would otherwise hang the start. The
   * check answers in milliseconds on a working database.
   */
  checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS;

  constructor(config: ConfigService<IngestEnv, true>) {
    const url = config.get('DATABASE_INGEST_URL', { infer: true });
    if (!url) {
      throw new Error(
        'DATABASE_INGEST_URL is required for the device receiver (login jantrik_ingest_app). ' +
          'See docs/database.md.',
      );
    }
    this.client = createPrismaClient(url, INGEST_POOL);
  }

  /**
   * Starts only when the check passes: the login runs ingest_resolve and reads neither students
   * nor punches (e.g. not DATABASE_URL pasted by mistake). A check that answers otherwise stops the
   * start at once. A check that fails (no connection, an error such as 42501 before the migrations
   * ran, or no answer within `checkTimeoutMs`) is asked again with backoff, one log line each with
   * the error's codes, and still failing after the last wait stops the start. When the receiver
   * runs inside the API, the API is already listening meanwhile; the receiver comes up when the
   * check passes.
   */
  async onModuleInit(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let row: StartupCheck | undefined;
      try {
        [row] = await this.check();
      } catch (error) {
        const raw = databaseError(error)?.kind;
        const kind = typeof raw === 'string' && /^[A-Za-z]{1,60}$/.test(raw) ? raw : undefined;
        const label = [errorLabel(error), kind].filter(Boolean).join(' ');
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new Error(
            `Could not check the device receiver's database login (DATABASE_INGEST_URL): ` +
              `${label}. The receiver does not start unchecked.`,
          );
        }
        this.logger.warn(
          `Start-up check failed (${label}): the database may not be ready yet; ` +
            `checking again in ${delay / 1000} s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (row?.resolve === true && row.students === false && row.punches === false) {
        if (attempt > 0) this.logger.log('Start-up check passed');
        return;
      }
      throw new Error(
        'DATABASE_INGEST_URL must use the device receiver login (jantrik_ingest_app): it runs ' +
          'the ingest_* functions and reads no table. See docs/database.md.',
      );
    }
  }

  /**
   * One start-up check, failed with a `StartupCheckTimeout` error when it has no answer within
   * `checkTimeoutMs`. A query that answers after that is ignored (its late failure too).
   */
  private async check(): Promise<StartupCheck[]> {
    const query = (async () =>
      this.client.$queryRaw<StartupCheck[]>`
        SELECT has_function_privilege(
                 'public.ingest_resolve(text, inet, timestamptz, text, integer, text)', 'EXECUTE'
               ) AS resolve,
               has_table_privilege('public.students', 'SELECT') AS students,
               has_table_privilege('public.device_punches', 'SELECT') AS punches`)();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('No answer in time'), { name: 'StartupCheckTimeout' }));
      }, this.checkTimeoutMs);
    });
    try {
      // The race handles the query's rejection too: one that fails after the timeout is not an
      // unhandled rejection (tested).
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

type StartupCheck = { resolve: boolean; students: boolean; punches: boolean };

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
