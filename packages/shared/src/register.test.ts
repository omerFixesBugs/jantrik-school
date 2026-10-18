import { describe, expect, it } from 'vitest';
import { buildRegister, monthDates, registerCsv } from './register.js';

const S = (id: string, roll: number, nameBn: string) => ({
  id,
  roll,
  studentCode: `C-${id}`,
  nameBn,
  nameEn: `Name ${id}`,
});

const input = {
  month: '2026-10',
  students: [S('a', 1, 'আরিফ'), S('b', 2, 'বিথী'), S('c', 3, 'চয়ন')],
  takenDates: ['2026-10-01', '2026-10-04', '2026-10-05'],
  records: [
    { studentId: 'a', date: '2026-10-01', status: 'PRESENT' as const },
    { studentId: 'a', date: '2026-10-04', status: 'LATE' as const },
    { studentId: 'a', date: '2026-10-05', status: 'ABSENT' as const },
    { studentId: 'b', date: '2026-10-01', status: 'LEAVE' as const },
    { studentId: 'b', date: '2026-10-04', status: 'PRESENT' as const },
    { studentId: 'b', date: '2026-10-05', status: 'PRESENT' as const },
    // c joined on the 4th: no record on the 1st
    { studentId: 'c', date: '2026-10-04', status: 'ABSENT' as const },
    { studentId: 'c', date: '2026-10-05', status: 'PRESENT' as const },
    // a record on a date without a register is ignored
    { studentId: 'c', date: '2026-10-06', status: 'ABSENT' as const },
  ],
  nonWorking: {
    '2026-10-02': { reason: 'OFF_DAY' as const },
    '2026-10-09': { reason: 'OFF_DAY' as const },
  },
  leaveCountsAsAbsent: false,
};

describe('monthDates', () => {
  it('lists every day, including February and leap years', () => {
    expect(monthDates('2026-10')).toHaveLength(31);
    expect(monthDates('2026-02')).toHaveLength(28);
    expect(monthDates('2028-02').at(-1)).toBe('2028-02-29');
  });
});

describe('buildRegister', () => {
  const reg = buildRegister(input);

  it('marks days: weekday, off days, taken', () => {
    expect(reg.days).toHaveLength(31);
    expect(reg.days[1]).toMatchObject({
      date: '2026-10-02',
      weekday: 5,
      nonWorkingDay: { reason: 'OFF_DAY' },
      taken: false,
    });
    expect(reg.daysTaken).toBe(3);
  });

  it('per-student totals and present % (LATE present, LEAVE left out)', () => {
    const [a, b, c] = reg.rows;
    expect(a!.counts).toEqual({ present: 1, absent: 1, late: 1, leave: 0 });
    expect(a!.percent).toBeCloseTo((2 / 3) * 100);
    expect(b!.counts).toEqual({ present: 2, absent: 0, late: 0, leave: 1 });
    expect(b!.percent).toBeCloseTo(100); // leave not counted
    expect(c!.cells).toEqual({ '2026-10-04': 'ABSENT', '2026-10-05': 'PRESENT' });
    expect(c!.percent).toBeCloseTo(50);
  });

  it('per-day and overall totals add up', () => {
    expect(reg.dayTotals['2026-10-01']).toEqual({ present: 1, absent: 0, late: 0, leave: 1 });
    expect(reg.dayTotals['2026-10-04']).toEqual({ present: 1, absent: 1, late: 1, leave: 0 });
    expect(reg.dayTotals['2026-10-05']).toEqual({ present: 2, absent: 1, late: 0, leave: 0 });
    expect(reg.totals.counts).toEqual({ present: 4, absent: 2, late: 1, leave: 1 });
    expect(reg.totals.percent).toBeCloseTo((5 / 7) * 100);
  });

  it('with "count LEAVE as absent"', () => {
    const r = buildRegister({ ...input, leaveCountsAsAbsent: true });
    expect(r.rows[1]!.percent).toBeCloseTo((2 / 3) * 100);
  });
});

describe('registerCsv', () => {
  const labels = {
    roll: 'Roll',
    id: 'ID',
    name: 'Name',
    present: 'P',
    absent: 'A',
    late: 'L',
    leave: 'LV',
    percent: '%',
  };

  it('UTF-8 BOM, ASCII digits, Bangla codes and names, CRLF', () => {
    const csv = registerCsv(buildRegister(input), 'bn', { ...labels, name: 'নাম' });
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Roll,ID,নাম,1,4,5,P,A,L,LV,%');
    expect(lines[1]).toBe('1,C-a,আরিফ,উ,দে,অ,1,1,1,0,66.7');
    expect(lines[3]).toBe('3,C-c,চয়ন,,অ,উ,1,1,0,0,50.0');
    expect(csv).not.toMatch(/[০-৯]/); // never Bangla digits in a CSV
  });

  it('quotes values with commas or quotes', () => {
    const r = buildRegister({ ...input, students: [S('a', 1, 'আরিফ, "রনি"')] });
    expect(registerCsv(r, 'bn', labels).split('\r\n')[1]).toContain('"আরিফ, ""রনি"""');
  });
});
