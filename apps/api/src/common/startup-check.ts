/**
 * The start-up check every database login gets (the API's, the platform module's, the device
 * receiver's): asked again with backoff while it fails (the database may not be reachable or
 * migrated yet), refused at once when it answers wrongly, and never waited on forever.
 */

/** How long one start-up check, or opening one connection, may take. */
export const STARTUP_CHECK_TIMEOUT_MS = 10_000;

/** Waits between failed checks: 1, 2, 4 and 8 s, then 15 s eleven times, about 3 minutes. */
export const STARTUP_RETRY_DELAYS_MS: readonly number[] = [
  1000,
  2000,
  4000,
  8000,
  ...Array<number>(11).fill(15000),
];

export interface StartupCheck<T> {
  /** One check: a query that answers what the login can do. */
  run: () => Promise<T>;
  /** `true` to start; a string refuses the start at once with that message (never asked again). */
  verdict: (answer: T) => true | string;
  retryDelaysMs: readonly number[];
  /** How long one check may take before it counts as failed (and is asked again). */
  checkTimeoutMs: number;
  logger: { warn(message: string): void; log(message: string): void };
  /** The login checked, e.g. "the device receiver's database login (DATABASE_INGEST_URL)". */
  what: string;
  /** Ends the refusal when the check never succeeds, e.g. "The receiver does not start unchecked." */
  unchecked: string;
  /** What may be logged about a failure: names and codes, never a message (startupErrorLabel). */
  label: (error: unknown) => string;
}

export async function runStartupCheck<T>(check: StartupCheck<T>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let answer: T;
    try {
      answer = await withTimeout(check.run, check.checkTimeoutMs);
    } catch (error) {
      const label = check.label(error);
      const delay = check.retryDelaysMs[attempt];
      if (delay === undefined) {
        throw new Error(`Could not check ${check.what}: ${label}. ${check.unchecked}`);
      }
      check.logger.warn(
        `Start-up check failed (${label}): the database may not be ready yet; ` +
          `checking again in ${delay / 1000} s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const verdict = check.verdict(answer);
    if (verdict !== true) throw new Error(verdict);
    if (attempt > 0) check.logger.log('Start-up check passed');
    return;
  }
}

/**
 * One check, failed with a `StartupCheckTimeout` error when it has no answer within `ms`. A check
 * that answers after that is ignored (its late failure too).
 */
async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  const query = (async () => run())();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('No answer in time'), { name: 'StartupCheckTimeout' }));
    }, ms);
  });
  try {
    // The race handles the query's rejection too: one that fails after the timeout is not an
    // unhandled rejection (tested).
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the driver says about a failed query: the database's error code (e.g. P0001 for RAISE,
 * 23514 for a CHECK) and message, or the kind of failure (e.g. DatabaseNotReachable).
 */
export function databaseError(
  error: unknown,
): { code?: unknown; message?: unknown; kind?: unknown } | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: unknown } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause as
    { originalCode?: unknown; originalMessage?: unknown; kind?: unknown } | undefined;
  return cause && { code: cause.originalCode, message: cause.originalMessage, kind: cause.kind };
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

/** A failed start-up check's label: `errorLabel` plus the adapter's kind of failure. */
export function startupErrorLabel(error: unknown): string {
  const raw = databaseError(error)?.kind;
  const kind = typeof raw === 'string' && /^[A-Za-z]{1,60}$/.test(raw) ? raw : undefined;
  return [errorLabel(error), kind].filter(Boolean).join(' ');
}
