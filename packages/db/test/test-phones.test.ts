import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BD_PHONE_E164 } from '@jantrik/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { floorAt, phoneSource, withLock } from './test-phones.js';

describe('test phones (decisions-pending P0-8)', () => {
  let dir: string;
  const db = 'postgresql://u:p@localhost:5432/jantrik_x_test';
  const t0 = Date.UTC(2026, 10, 16, 9);
  const counterFile = () => path.join(dir, 'localhost_5432_jantrik_x_test__88013.txt');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-phones-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('never repeats across processes sharing a database (two sources, interleaved)', () => {
    const a = phoneSource('+88013', db, { dir, now: () => t0 });
    const b = phoneSource('+88013', db, { dir, now: () => t0 });
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      for (const phone of [a(), b()]) {
        expect(seen.has(phone)).toBe(false);
        seen.add(phone);
      }
    }
    expect(seen.size).toBe(2_000);
  });

  it('never repeats across runs: a later run continues after the earlier one', () => {
    const first = phoneSource('+88013', db, { dir, now: () => t0 });
    const earlier = new Set(Array.from({ length: 500 }, () => first()));
    // The next run starts a second later: its clock floor is behind the counter.
    const second = phoneSource('+88013', db, { dir, now: () => t0 + 1_000 });
    for (let i = 0; i < 500; i++) expect(earlier.has(second())).toBe(false);
  });

  it('starts from the clock when the counter file is lost, ahead of what earlier runs used', () => {
    const first = phoneSource('+88013', db, { dir, now: () => t0 });
    const earlier = new Set(Array.from({ length: 300 }, () => first()));
    fs.rmSync(dir, { recursive: true, force: true });
    const later = phoneSource('+88013', db, { dir, now: () => t0 + 3_600_000 });
    for (let i = 0; i < 300; i++) expect(earlier.has(later())).toBe(false);
  });

  it('lets the clock floor rise one number a second (about a year and a half of range)', () => {
    expect(floorAt(t0 + 1_000) - floorAt(t0)).toBe(1);
    expect(floorAt(Date.UTC(2028, 3, 1))).toBeLessThan(49_000_000);
  });

  it('never wraps: past the end of its range it stops instead of repeating old numbers', () => {
    // The clock alone past the end (about May 2028).
    const late = phoneSource('+88013', db, { dir, now: () => Date.UTC(2028, 6, 1) });
    expect(() => late()).toThrow(/test phone range .* is used up/);
    // A counter at the last number: that one is given, the next one is refused.
    fs.writeFileSync(counterFile(), String(49_000_000 - 1));
    const last = phoneSource('+88013', db, { dir, now: () => t0 });
    expect(last()).toBe('+8801398999999');
    expect(() => last()).toThrow(/is used up/);
  });

  it('keeps a counter per database: another database starts on its own', () => {
    const one = phoneSource('+88013', db, { dir, now: () => t0 });
    const other = phoneSource('+88013', db.replace('jantrik_x_test', 'jantrik_y_test'), {
      dir,
      now: () => t0,
    });
    expect(one()).toBe(other());
  });

  it('gives valid Bangladeshi mobile numbers, clear of the seeds and the old random ranges', () => {
    const next = phoneSource('+88013', db, { dir, now: () => t0 });
    for (let i = 0; i < 50; i++) {
      const phone = next();
      expect(phone).toMatch(BD_PHONE_E164);
      const n = Number(phone.slice(6));
      expect(n).toBeGreaterThanOrEqual(50_000_000);
      expect(n).toBeLessThan(99_000_000);
    }
  });

  it('takes over a lock left behind by a process that died', () => {
    fs.mkdirSync(`${counterFile()}.lock`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${counterFile()}.lock`, old, old);
    const next = phoneSource('+88013', db, { dir, now: () => t0 });
    expect(next()).toMatch(BD_PHONE_E164);
    expect(fs.existsSync(`${counterFile()}.lock`)).toBe(false);
  });

  it('waits when Windows refuses to make the lock (EPERM, EACCES: a lock being removed)', () => {
    const lock = path.join(dir, 'x.lock');
    let refusals = 0;
    const flaky: typeof fs = {
      ...fs,
      mkdirSync: ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
        if (p === lock && refusals < 2) {
          refusals++;
          throw Object.assign(new Error('refused'), { code: refusals === 1 ? 'EPERM' : 'EACCES' });
        }
        return fs.mkdirSync(p, o);
      }) as typeof fs.mkdirSync,
    };
    expect(withLock(lock, () => 'done', flaky)).toBe('done');
    expect(refusals).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('never removes a fresh lock that replaced the stale one it saw', () => {
    const lock = path.join(dir, 'x.lock');
    const owner = (): string | null => {
      try {
        return fs.readFileSync(path.join(lock, 'owner'), 'utf8');
      } catch {
        return null;
      }
    };
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'dead');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    let replaced = false;
    let waits = 0;
    let freshRemoved = 0;
    const racy: typeof fs = {
      ...fs,
      // Right after this process sees the stale lock, another one takes it over first.
      statSync: ((p: fs.PathLike) => {
        const stat = fs.statSync(p);
        if (p === lock && !replaced) {
          replaced = true;
          fs.rmSync(lock, { recursive: true, force: true });
          fs.mkdirSync(lock);
          fs.writeFileSync(path.join(lock, 'owner'), 'fresh');
        }
        return stat;
      }) as typeof fs.statSync,
      // The other process finishes after a few of this one's attempts.
      mkdirSync: ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
        if (p === lock && replaced && owner() === 'fresh' && ++waits === 3) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
        return fs.mkdirSync(p, o);
      }) as typeof fs.mkdirSync,
      rmSync: ((p: fs.PathLike, o?: fs.RmOptions) => {
        if (p === lock && owner() === 'fresh') freshRemoved++;
        return fs.rmSync(p, o);
      }) as typeof fs.rmSync,
    };
    expect(withLock(lock, () => 'done', racy)).toBe('done');
    expect(replaced).toBe(true);
    expect(freshRemoved).toBe(0);
    expect(waits).toBeGreaterThanOrEqual(3);
  });

  it('never repeats when several processes draw at once, a stale lock waiting for them', async () => {
    fs.mkdirSync(`${counterFile()}.lock`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${counterFile()}.lock`, old, old);
    const child = path.join(dir, 'draw.mjs');
    fs.writeFileSync(
      child,
      [
        "import { pathToFileURL } from 'node:url';",
        'const { phoneSource } = await import(pathToFileURL(process.argv[2]).href);',
        "const next = phoneSource('+88013', process.argv[3], { dir: process.argv[4] });",
        'const out = [];',
        'for (let i = 0; i < 1000; i++) out.push(next());',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n'),
    );
    const source = path.join(import.meta.dirname, 'test-phones.ts');
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(process.execPath, [child, source, db, dir], { timeout: 60_000 }),
      ),
    );
    const all = runs.flatMap((r) => JSON.parse(r.stdout) as string[]);
    expect(all).toHaveLength(4_000);
    expect(new Set(all).size).toBe(4_000);
  });
});
