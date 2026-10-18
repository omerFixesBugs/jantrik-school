import { describe, expect, it } from 'vitest';
import {
  banglaCalendarDate,
  dayPeriod,
  dhakaHour,
  formatBanglaCalendarDate,
  formatDate,
  formatTime,
} from './format.js';

describe('Bangla calendar (বঙ্গাব্দ, 2019 revision)', () => {
  it.each([
    ['2026-04-14T06:00:00Z', { day: 1, month: 0, year: 1433 }], // Pohela Boishakh
    ['2026-04-13T06:00:00Z', { day: 30, month: 11, year: 1432 }], // last day of Choitro
    ['2026-02-21T06:00:00Z', { day: 8, month: 10, year: 1432 }], // Ekushe: 8 Falgun
    ['2026-03-26T06:00:00Z', { day: 12, month: 11, year: 1432 }], // Independence Day: 12 Choitro
    ['2026-12-16T06:00:00Z', { day: 1, month: 8, year: 1433 }], // Victory Day: 1 Poush
    ['2026-10-17T06:00:00Z', { day: 1, month: 6, year: 1433 }], // 1 Kartik
    ['2028-02-21T06:00:00Z', { day: 8, month: 10, year: 1434 }], // leap February
    ['2028-03-14T06:00:00Z', { day: 30, month: 10, year: 1434 }], // Falgun has 30 days
    ['2027-03-14T06:00:00Z', { day: 29, month: 10, year: 1433 }], // ...and 29 otherwise
    ['2027-03-15T06:00:00Z', { day: 1, month: 11, year: 1433 }],
  ])('%s', (iso, expected) => {
    expect(banglaCalendarDate(iso)).toEqual(expected);
  });

  it('uses the date in Dhaka, not UTC', () => {
    // 19:00 UTC on 13 April is already 14 April (01:00) in Dhaka.
    expect(banglaCalendarDate('2026-04-13T19:00:00Z')).toEqual({ day: 1, month: 0, year: 1433 });
  });

  it('formats in both languages', () => {
    expect(formatBanglaCalendarDate('2026-10-17T06:00:00Z', 'bn')).toBe('১ কার্তিক ১৪৩৩');
    expect(formatBanglaCalendarDate('2026-10-17T06:00:00Z', 'en')).toBe('1 Kartik 1433');
  });
});

describe('formatDate full / dhakaHour', () => {
  it('includes the weekday', () => {
    expect(formatDate('2026-10-17T06:00:00Z', 'bn', 'full')).toContain('শনিবার');
    expect(formatDate('2026-10-17T06:00:00Z', 'en', 'full')).toContain('Saturday');
  });

  it('reads the hour in Dhaka', () => {
    expect(dhakaHour('2026-10-17T02:30:00Z')).toBe(8);
    expect(dhakaHour('2026-10-17T18:30:00Z')).toBe(0);
  });
});

describe('dayPeriod', () => {
  it.each([
    [4, 'night'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [16, 'afternoon'],
    [17, 'evening'],
    [20, 'evening'],
    [21, 'night'],
    [0, 'night'],
  ] as const)('%i:00 → %s', (hour, period) => {
    expect(dayPeriod(hour)).toBe(period);
  });
});

describe('formatTime', () => {
  it.each([
    ['2026-10-18T03:15:00Z', 'সকাল ৯:১৫'],
    ['2026-10-18T08:15:00Z', 'দুপুর ২:১৫'],
    ['2026-10-18T12:20:00Z', 'সন্ধ্যা ৬:২০'],
    ['2026-10-18T15:10:00Z', 'রাত্রি ৯:১০'],
  ])('%s → %s (Dhaka, part of day first)', (iso, text) => {
    expect(formatTime(iso, 'bn')).toBe(text);
  });

  it('24-hour in English', () => {
    expect(formatTime('2026-10-18T08:15:00Z', 'en')).toBe('14:15');
  });
});
