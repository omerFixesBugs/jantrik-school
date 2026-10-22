import { describe, expect, it } from 'vitest';
import type { AttendanceCounts, SectionRef } from './attendance.js';
import { recentMonths } from './format.js';
import { absenceStreak, buildTrend, STREAK_CAP, trendFrom, trendQuerySchema } from './reports.js';

const section = (id: string, name: string): SectionRef => ({
  id,
  name,
  classLevel: { id: 'c6', nameBn: 'ষষ্ঠ', nameEn: 'Six' },
});
const counts = (present: number, absent: number, late = 0, leave = 0): AttendanceCounts => ({
  present,
  absent,
  late,
  leave,
});

describe('absenceStreak', () => {
  it('counts absent days back from the newest, ending at the first day present or late', () => {
    expect(absenceStreak(['ABSENT', 'ABSENT', 'PRESENT', 'ABSENT'], false)).toBe(2);
    expect(absenceStreak(['ABSENT', 'LATE', 'ABSENT'], false)).toBe(1);
    expect(absenceStreak(['PRESENT', 'ABSENT'], false)).toBe(0);
    expect(absenceStreak([], false)).toBe(0);
  });

  it('counts leave only when the institute counts leave as absent', () => {
    const days = ['ABSENT', 'LEAVE', 'ABSENT', 'PRESENT'] as const;
    expect(absenceStreak(days, false)).toBe(1);
    expect(absenceStreak(days, true)).toBe(3);
  });

  it('stops at the cap', () => {
    expect(absenceStreak(Array(45).fill('ABSENT'), false)).toBe(STREAK_CAP);
  });
});

describe('trendFrom', () => {
  it('goes back `days` calendar days, today included', () => {
    expect(trendFrom('2026-10-21', 30, '2026-01-01')).toBe('2026-09-22');
    expect(trendFrom('2026-10-21', 30, null)).toBe('2026-09-22');
  });

  it('never before the year started, and never after today', () => {
    expect(trendFrom('2026-01-10', 30, '2026-01-01')).toBe('2026-01-01');
    expect(trendFrom('2026-01-10', 30, '2026-02-01')).toBe('2026-01-10');
  });
});

describe('buildTrend', () => {
  const a = section('a', 'A');
  const b = section('b', 'B');
  const input = {
    dates: ['2026-10-19', '2026-10-20', '2026-10-21'],
    nonWorking: { '2026-10-20': { reason: 'OFF_DAY' as const } },
    sections: [
      {
        section: a,
        byDate: new Map([
          ['2026-10-19', counts(9, 1)],
          ['2026-10-21', counts(8, 1, 1)],
        ]),
      },
      { section: b, byDate: new Map([['2026-10-21', counts(4, 0, 0, 1)]]) },
    ],
    leaveCountsAsAbsent: false,
  };

  it('adds the sections up per day; a day without any register has no percent', () => {
    const { days, sections } = buildTrend({ ...input, bySection: false });
    expect(days).toEqual([
      {
        date: '2026-10-19',
        counts: counts(9, 1),
        percent: 90,
        nonWorkingDay: null,
        sectionsTaken: 1,
      },
      {
        date: '2026-10-20',
        counts: null,
        percent: null,
        nonWorkingDay: { reason: 'OFF_DAY' },
        sectionsTaken: 0,
      },
      {
        date: '2026-10-21',
        counts: counts(12, 1, 1, 1),
        // Leave not counted: (12 + 1) / (12 + 1 + 1)
        percent: (13 / 14) * 100,
        nonWorkingDay: null,
        sectionsTaken: 2,
      },
    ]);
    expect(sections).toEqual([]);
  });

  it('with bySection, each section has its own line over the same dates', () => {
    const { sections } = buildTrend({ ...input, leaveCountsAsAbsent: true, bySection: true });
    expect(sections.map((s) => s.section.name)).toEqual(['A', 'B']);
    expect(sections[1]!.days.map((d) => d.percent)).toEqual([null, null, 80]);
    expect(sections[0]!.days.map((d) => d.date)).toEqual(input.dates);
  });
});

describe('trendQuerySchema', () => {
  it('defaults to 30 days; bySection reads 1/0 and true/false', () => {
    expect(trendQuerySchema.parse({})).toEqual({ days: 30 });
    expect(trendQuerySchema.parse({ days: '14', bySection: '1' })).toEqual({
      days: 14,
      bySection: true,
    });
    expect(trendQuerySchema.parse({ bySection: 'false' }).bySection).toBe(false);
  });

  it('a week to 90 days', () => {
    expect(trendQuerySchema.safeParse({ days: '6' }).success).toBe(false);
    expect(trendQuerySchema.safeParse({ days: '91' }).success).toBe(false);
  });
});

describe('recentMonths', () => {
  it('the last n months, oldest first, across a year end', () => {
    expect(recentMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(recentMonths('2026-10', 12)).toHaveLength(12);
    expect(recentMonths('2026-10', 12).at(-1)).toBe('2026-10');
  });
});
