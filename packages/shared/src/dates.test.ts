import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localDateOf,
  localTimeOf,
  timeZoneOffsetMinutes,
  todayIn,
  wallClockToUtc,
} from './dates.js';

describe('todayIn with a fixed test date (JANTRIK_TEST_TODAY)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fixes "today" in any timezone; an instant still gives its own date', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-10-21');
    vi.stubEnv('NODE_ENV', 'test');
    expect(todayIn('Asia/Dhaka')).toBe('2026-10-21');
    expect(todayIn('UTC')).toBe('2026-10-21');
    expect(todayIn('Asia/Dhaka', new Date('2026-10-17T20:30:00Z'))).toBe('2026-10-18');
  });

  it('is never used in production', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2020-01-01');
    vi.stubEnv('NODE_ENV', 'production');
    expect(todayIn('Asia/Dhaka')).not.toBe('2020-01-01');
  });

  it('refuses a value that is not a calendar date, instead of using the real one', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-02-30');
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => todayIn('Asia/Dhaka')).toThrow(/JANTRIK_TEST_TODAY/);
  });
});

describe('wall-clock time zones', () => {
  it('reads Dhaka wall-clock time as UTC and back, across midnight', () => {
    const d = wallClockToUtc('2026-10-24 08:00:00', 'Asia/Dhaka');
    expect(d.toISOString()).toBe('2026-10-24T02:00:00.000Z');
    expect(wallClockToUtc('2026-10-24 00:30:15', 'Asia/Dhaka').toISOString()).toBe(
      '2026-10-23T18:30:15.000Z',
    );
    const late = new Date('2026-10-23T18:30:15Z');
    expect(localDateOf(late, 'Asia/Dhaka')).toBe('2026-10-24');
    expect(localTimeOf(late, 'Asia/Dhaka')).toBe('00:30:15');
    expect(localDateOf(new Date('2026-10-23T17:59:59Z'), 'Asia/Dhaka')).toBe('2026-10-23');
    expect(localTimeOf(new Date('2026-10-23T17:59:59Z'), 'Asia/Dhaka')).toBe('23:59:59');
  });

  it('handles a DST zone on both sides of a change', () => {
    // London springs forward on 2026-03-29 (01:00 UTC) and falls back on 2026-10-25.
    expect(wallClockToUtc('2026-03-29 00:30:00', 'Europe/London').toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(wallClockToUtc('2026-03-29 02:30:00', 'Europe/London').toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(wallClockToUtc('2026-10-25 00:30:00', 'Europe/London').toISOString()).toBe(
      '2026-10-24T23:30:00.000Z',
    );
    expect(wallClockToUtc('2026-10-25 03:00:00', 'Europe/London').toISOString()).toBe(
      '2026-10-25T03:00:00.000Z',
    );
    expect(localTimeOf(new Date('2026-03-29T01:30:00Z'), 'Europe/London')).toBe('02:30:00');
  });

  it('reports the offset in minutes at an instant', () => {
    expect(timeZoneOffsetMinutes('Asia/Dhaka', new Date('2026-10-24T00:00:00Z'))).toBe(360);
    expect(timeZoneOffsetMinutes('Asia/Kolkata', new Date('2026-10-24T00:00:00Z'))).toBe(330);
    expect(timeZoneOffsetMinutes('Europe/London', new Date('2026-07-01T00:00:00Z'))).toBe(60);
    expect(timeZoneOffsetMinutes('Europe/London', new Date('2026-12-01T00:00:00Z'))).toBe(0);
    expect(timeZoneOffsetMinutes('America/New_York', new Date('2026-12-01T00:00:00Z'))).toBe(-300);
  });
});
