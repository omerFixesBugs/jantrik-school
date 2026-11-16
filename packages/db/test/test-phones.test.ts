import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BD_PHONE_E164 } from '@jantrik/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { floorAt, phoneSource } from './test-phones.js';

describe('test phones (decisions-pending P0-8)', () => {
  let dir: string;
  const db = 'postgresql://u:p@localhost:5432/jantrik_x_test';
  const t0 = Date.UTC(2026, 10, 16, 9);

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
    const later = phoneSource('+88013', db, { dir, now: () => t0 + 60_000 });
    for (let i = 0; i < 300; i++) expect(earlier.has(later())).toBe(false);
    expect(floorAt(t0 + 60_000) - floorAt(t0)).toBeGreaterThan(300);
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
    const counter = path.join(dir, 'localhost_5432_jantrik_x_test__88013.txt');
    fs.mkdirSync(`${counter}.lock`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${counter}.lock`, old, old);
    const next = phoneSource('+88013', db, { dir, now: () => t0 });
    expect(next()).toMatch(BD_PHONE_E164);
    expect(fs.existsSync(`${counter}.lock`)).toBe(false);
  });
});
