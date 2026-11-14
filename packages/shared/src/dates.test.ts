import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localDateOf,
  localTimeOf,
  secondsOfDay,
  timeZoneOffsetMinutes,
  todayAt,
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
    expect(todayAt('Asia/Dhaka', new Date('2026-10-17T20:30:00Z'))).toBe('2026-10-18');
  });

  it("todayAt is the clock's date there, unless a fixed test date wins", () => {
    const now = new Date('2026-10-17T20:30:00Z'); // 02:30 on the 18th in Dhaka
    vi.stubEnv('JANTRIK_TEST_TODAY', '');
    expect(todayAt('Asia/Dhaka', now)).toBe('2026-10-18');
    expect(todayAt('UTC', now)).toBe('2026-10-17');
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-10-21');
    vi.stubEnv('NODE_ENV', 'test');
    expect(todayAt('Asia/Dhaka', now)).toBe('2026-10-21');
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

describe('wallClockToUtc around DST changes in other zones', () => {
  // [zone, wall clock, expected UTC]; ambiguous times take the earlier instant, gap times move forward
  it.each([
    // Berlin: spring forward 2026-03-29 01:00Z, fall back 2026-10-25 01:00Z
    ['Europe/Berlin', '2026-03-29 01:30:00', '2026-03-29T00:30:00Z'],
    ['Europe/Berlin', '2026-03-29 01:59:59', '2026-03-29T00:59:59Z'],
    ['Europe/Berlin', '2026-03-29 02:30:00', '2026-03-29T01:30:00Z'], // gap
    ['Europe/Berlin', '2026-03-29 03:30:00', '2026-03-29T01:30:00Z'],
    ['Europe/Berlin', '2026-10-25 01:59:59', '2026-10-24T23:59:59Z'],
    ['Europe/Berlin', '2026-10-25 02:30:00', '2026-10-25T00:30:00Z'], // ambiguous
    ['Europe/Berlin', '2026-10-25 03:30:00', '2026-10-25T02:30:00Z'],
    // New York: spring forward 2026-03-08 07:00Z, fall back 2026-11-01 06:00Z
    ['America/New_York', '2026-03-08 01:30:00', '2026-03-08T06:30:00Z'],
    ['America/New_York', '2026-03-08 02:30:00', '2026-03-08T07:30:00Z'], // gap
    ['America/New_York', '2026-03-08 03:30:00', '2026-03-08T07:30:00Z'],
    ['America/New_York', '2026-11-01 00:30:00', '2026-11-01T04:30:00Z'],
    ['America/New_York', '2026-11-01 01:30:00', '2026-11-01T05:30:00Z'], // ambiguous
    ['America/New_York', '2026-11-01 02:30:00', '2026-11-01T07:30:00Z'],
    // Lord Howe (30 minute change): DST starts 2026-10-04, ends 2026-04-05
    ['Australia/Lord_Howe', '2026-10-04 01:45:00', '2026-10-03T15:15:00Z'],
    ['Australia/Lord_Howe', '2026-10-04 02:15:00', '2026-10-03T15:45:00Z'], // gap
    ['Australia/Lord_Howe', '2026-10-04 03:00:00', '2026-10-03T16:00:00Z'],
    ['Australia/Lord_Howe', '2026-04-05 01:15:00', '2026-04-04T14:15:00Z'],
    ['Australia/Lord_Howe', '2026-04-05 01:45:00', '2026-04-04T14:45:00Z'], // ambiguous
    ['Australia/Lord_Howe', '2026-04-05 02:15:00', '2026-04-04T15:45:00Z'],
  ])('%s %s', (zone, wallClock, utc) => {
    expect(wallClockToUtc(wallClock, zone).toISOString()).toBe(new Date(utc).toISOString());
  });

  it('London ambiguous hour takes the first occurrence', () => {
    expect(wallClockToUtc('2026-10-25 01:30:00', 'Europe/London').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });
});

describe('wallClockToUtc refuses times that do not exist', () => {
  it.each([
    '2026-02-30 08:00:00',
    '2026-02-29 08:00:00', // not a leap year
    '2026-13-01 08:00:00',
    '2026-00-10 08:00:00',
    '2026-10-00 08:00:00',
    '2026-10-24 24:00:00',
    '2026-10-24 25:00:00',
    '2026-10-24 08:60:00',
    '2026-10-24 08:00:60',
    '0050-10-24 08:00:00',
    '2026-10-24 8:00:00',
    '2026-10-24',
  ])('%s', (wallClock) => {
    expect(() => wallClockToUtc(wallClock, 'Asia/Dhaka')).toThrow(/Not a wall-clock time/);
  });

  it('still reads the last second of a day and a leap day', () => {
    expect(wallClockToUtc('2026-10-24 23:59:59', 'Asia/Dhaka').toISOString()).toBe(
      '2026-10-24T17:59:59.000Z',
    );
    expect(wallClockToUtc('2028-02-29T08:00:00', 'Asia/Dhaka').toISOString()).toBe(
      '2028-02-29T02:00:00.000Z',
    );
  });
});

describe('secondsOfDay', () => {
  it('reads HH:MM and HH:MM:SS as seconds since midnight', () => {
    expect(secondsOfDay('00:00')).toBe(0);
    expect(secondsOfDay('08:10')).toBe(29_400);
    expect(secondsOfDay('08:10:00')).toBe(29_400);
    expect(secondsOfDay('08:10:01')).toBe(29_401);
    expect(secondsOfDay('23:59:59')).toBe(86_399);
  });
});
