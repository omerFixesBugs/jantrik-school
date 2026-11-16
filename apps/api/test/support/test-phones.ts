import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Phone numbers for test users that no other test user of the same database has (decisions-pending
 * P0-8). Random numbers repeated now and then: a full run makes thousands of users, the test
 * database keeps every run's users, and a repeated phone joins an existing user, which then has
 * two memberships (a new owner got 403 on /me/context once).
 *
 * Each database has one counter, in a file under the OS temp folder, shared by every test process
 * and every run against it. A process takes a block of numbers under a lock, then hands them out
 * one by one. The counter never goes back behind the clock (`floorAt`), so a lost counter file
 * does not restart at numbers earlier runs gave out. The numbers sit where nothing else is:
 * `<prefix>` + 50 000 000–98 999 999 (the seeds' fixed numbers are below; the old random phones
 * used other operators). They never wrap: when the range is used up (the clock alone reaches its
 * end in about May 2028), drawing stops with a message instead of repeating old numbers.
 *
 * Kept identical in packages/db/test/test-phones.ts and apps/api/test/support/test-phones.ts (a
 * test of the db copy pins how it behaves).
 */

/** Numbers per block a process takes at once. */
const BLOCK = 200;
const LOW = 50_000_000;
const SPAN = 49_000_000;
/** The counter's floor grows 1 a second from this day, so it is always ahead of older runs. */
const EPOCH_MS = Date.UTC(2026, 10, 1);
const PER_SECOND = 1;
/** A lock older than this was left by a process that died (the locked work takes microseconds). */
const STALE_MS = 10_000;
/** What `mkdir` answers while the lock exists, or (Windows) while it is being removed. */
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export const floorAt = (nowMs: number): number =>
  Math.max(0, Math.floor(((nowMs - EPOCH_MS) / 1000) * PER_SECOND));

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const ownerOf = (f: typeof fs, lockDir: string): string | null => {
  try {
    return f.readFileSync(path.join(lockDir, 'owner'), 'utf8');
  } catch {
    return null;
  }
};

/**
 * Removes the lock if it is stale. It is first moved aside (a rename: only one process can), and
 * removed only if its owner is still the one seen as stale; a fresh lock that another process made
 * meanwhile is put back.
 */
function takeOverIfStale(f: typeof fs, lockDir: string): void {
  const seen = ownerOf(f, lockDir);
  try {
    if (Date.now() - f.statSync(lockDir).mtimeMs <= STALE_MS) return;
  } catch {
    return; // released meanwhile
  }
  const aside = `${lockDir}.stale-${randomUUID()}`;
  try {
    f.renameSync(lockDir, aside);
  } catch {
    return; // another process moved or released it first
  }
  if (ownerOf(f, aside) === seen) {
    f.rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    f.renameSync(aside, lockDir);
  } catch {
    // Its owner has finished and a newer lock exists; nothing refers to this copy any more.
    f.rmSync(aside, { recursive: true, force: true });
  }
}

/** Runs `fn` while holding the lock directory `lockDir`, taking over a stale one. */
export function withLock<T>(lockDir: string, fn: () => T, f: typeof fs = fs): T {
  const token = randomUUID();
  for (let tries = 0; ; tries++) {
    try {
      f.mkdirSync(lockDir);
      f.writeFileSync(path.join(lockDir, 'owner'), token);
      break;
    } catch (error) {
      if (!BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      takeOverIfStale(f, lockDir);
      if (tries > 3_000) throw new Error(`test-phones: lock ${lockDir} stays taken`);
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    if (ownerOf(f, lockDir) === token) f.rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * A source of phones `<prefix>NNNNNNNN` (prefix e.g. `+88013`) unique among all users of the
 * database `databaseUrl` names (server, port and name; never the login).
 */
export function phoneSource(
  prefix: string,
  databaseUrl: string,
  options: { dir?: string; now?: () => number } = {},
): () => string {
  const url = new URL(databaseUrl);
  const key = `${url.hostname}_${url.port || '5432'}_${url.pathname.slice(1)}_${prefix}`.replace(
    /[^\w.-]/g,
    '_',
  );
  const dir = options.dir ?? path.join(os.tmpdir(), 'jantrik-test-phones');
  const now = options.now ?? Date.now;
  const counterFile = path.join(dir, `${key}.txt`);
  let next = 0;
  let end = 0;

  const takeBlock = (): void => {
    fs.mkdirSync(dir, { recursive: true });
    withLock(`${counterFile}.lock`, () => {
      let stored = 0;
      try {
        stored = Number.parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
      } catch {
        // No counter yet: start from the clock.
      }
      next = Math.max(stored, floorAt(now()));
      end = next + BLOCK;
      fs.writeFileSync(counterFile, String(end));
    });
  };

  return () => {
    if (next >= end) takeBlock();
    const n = next++;
    if (n >= SPAN) {
      throw new Error(
        `The test phone range of ${url.pathname.slice(1)} is used up: recreate the test database, ` +
          `delete ${counterFile} and move EPOCH_MS in test-phones.ts (both copies) to today`,
      );
    }
    return `${prefix}${LOW + n}`;
  };
}
