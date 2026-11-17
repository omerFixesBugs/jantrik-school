import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaClient,
  loginStartupVerdict,
  readLoginPrivileges,
  type PoolOptions,
  type PrismaClient,
} from '@jantrik/db';
import {
  STARTUP_CHECK_TIMEOUT_MS,
  STARTUP_RETRY_DELAYS_MS,
  databaseError,
  errorLabel,
  runStartupCheck,
  startupErrorLabel,
} from '../common/startup-check.js';
import type { IngestEnv } from '../config/ingest-env.js';

export { errorLabel };

/** How long one of the receiver's statements may run (decision #79): 5 s. */
const STATEMENT_TIMEOUT_MS = 5_000;
/** The same limit as Postgres shows it (`current_setting('statement_timeout')`). */
const STATEMENT_TIMEOUT_SETTING = '5s';

/**
 * The receiver's connection pool (node-postgres, at most 10 connections):
 * - Getting a connection fails after the check's time limit instead of waiting forever: opening
 *   one (a check that timed out while connecting does not keep its attempt in the pool), and also
 *   waiting for a free one. With more than 10 device calls in flight and a wait over 10 s, the
 *   waiting requests fail (500); devices send again, nothing is lost.
 * - TCP keep-alive probes an idle connection after 30 s, so a database host that went away is
 *   noticed in minutes, not the operating system's 2 hours.
 * - Every statement stops after 5 s (decision #79, the owner's choice): sent when a connection
 *   opens, enforced by the server (and set on the role too, deploy/postgres/create-roles.sh). The
 *   largest upload (10 000 lines) takes about 2 s to store; one cut by the limit stores nothing
 *   (one statement), the device gets 500 and sends it again.
 * The pool size is node-postgres' default (10).
 */
export const INGEST_POOL: PoolOptions = {
  connectionTimeoutMillis: STARTUP_CHECK_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
  statement_timeout: STATEMENT_TIMEOUT_MS,
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
  retryDelaysMs: readonly number[] = STARTUP_RETRY_DELAYS_MS;
  /**
   * How long one start-up check may take before it counts as failed (and is asked again): a
   * database that accepts the connection and never answers would otherwise hang the start. The
   * check answers in milliseconds on a working database.
   */
  checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS;

  /** Production refuses TEMP and unexpected role settings on this login; elsewhere a warning. */
  private readonly production: boolean;

  constructor(config: ConfigService<IngestEnv, true>) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
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
   * nor punches (e.g. not DATABASE_URL pasted by mistake), its statements stop after 5 s, and it
   * is not a superuser, BYPASSRLS, or able to become such a role. A check that answers otherwise
   * stops the start at once. A check that fails (no connection, an error such as 42501 before the
   * migrations ran, or no answer within `checkTimeoutMs`) is asked again with backoff, one log
   * line each with the error's codes, and still failing after the last wait stops the start. When
   * the receiver runs inside the API, the API is already listening meanwhile; the receiver comes
   * up when the check passes.
   */
  async onModuleInit(): Promise<void> {
    await runStartupCheck({
      run: async () => {
        const [row] = await this.client.$queryRaw<StartupCheck[]>`
          SELECT has_function_privilege(
                   'public.ingest_resolve(text, inet, timestamptz, text, integer, text)', 'EXECUTE'
                 ) AS resolve,
                 has_table_privilege('public.students', 'SELECT') AS students,
                 has_table_privilege('public.device_punches', 'SELECT') AS punches,
                 current_setting('statement_timeout') AS statement_timeout`;
        return { row, privileges: await readLoginPrivileges(this.client) };
      },
      verdict: ({ row, privileges }) => {
        if (row?.resolve !== true || row.students !== false || row.punches !== false) {
          return (
            'DATABASE_INGEST_URL must use the device receiver login (jantrik_ingest_app): it runs ' +
            'the ingest_* functions and reads no table. See docs/database.md.'
          );
        }
        if (row.statement_timeout !== STATEMENT_TIMEOUT_SETTING) {
          return (
            `The device receiver's statements must stop after 5 s (statement_timeout ` +
            `${STATEMENT_TIMEOUT_SETTING}), got ${String(row.statement_timeout)} (decision #79).`
          );
        }
        // Its 5 s statement timeout is a role setting on purpose (decision #79).
        const { problems, warnings } = loginStartupVerdict(privileges, {
          production: this.production,
          expectedSettings: [`statement_timeout=${STATEMENT_TIMEOUT_SETTING}`],
        });
        for (const w of warnings) this.logger.warn(w);
        return problems.length === 0
          ? true
          : `DATABASE_INGEST_URL must use the device receiver login (jantrik_ingest_app): ` +
              `${privileges.login} ${problems.join(', ')}. See docs/database.md.`;
      },
      retryDelaysMs: this.retryDelaysMs,
      checkTimeoutMs: this.checkTimeoutMs,
      logger: this.logger,
      what: "the device receiver's database login (DATABASE_INGEST_URL)",
      unchecked: 'The receiver does not start unchecked.',
      label: startupErrorLabel,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

type StartupCheck = {
  resolve: boolean;
  students: boolean;
  punches: boolean;
  statement_timeout: string;
};

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
