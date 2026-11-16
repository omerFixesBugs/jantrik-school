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
 * used other operators).
 *
 * Kept identical in packages/db/test/test-phones.ts and apps/api/test/support/test-phones.ts (a
 * test of the db copy pins how it behaves).
 */

/** Numbers per block a process takes at once. */
const BLOCK = 200;
const LOW = 50_000_000;
const SPAN = 49_000_000;
/** The counter's floor grows 20 a second from this day, so it is always ahead of older runs. */
const EPOCH_MS = Date.UTC(2026, 10, 1);
const PER_SECOND = 20;

export const floorAt = (nowMs: number): number =>
  Math.max(0, Math.floor(((nowMs - EPOCH_MS) / 1000) * PER_SECOND));

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Runs `fn` while holding a lock directory; a lock older than 10 s is left over and taken. */
function withLock<T>(lockDir: string, fn: () => T): T {
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (tries > 3_000) throw new Error(`test-phones: lock ${lockDir} stays taken`);
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
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
    return `${prefix}${LOW + (n % SPAN)}`;
  };
}
