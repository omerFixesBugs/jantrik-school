import { describe, expect, it } from 'vitest';
import {
  staffAttendanceTracked,
  staffDay,
  staffMonth,
  STAFF_CELL_CODES,
} from './staff-attendance.js';

const base = {
  timeZone: 'Asia/Dhaka',
  officeStart: '09:00',
  officeEnd: '17:00',
  lateGraceMin: 10,
  earlyGraceMin: 10,
};
// Dhaka is UTC+6: 09:00 local = 03:00Z
const at = (hhmmss: string) => new Date(`2026-10-24T${hhmmss}Z`);

describe('staffDay', () => {
  it('a single punch is an in with no out', () => {
    expect(staffDay({ ...base, punches: [at('03:00:00')] })).toEqual({
      inAt: at('03:00:00'),
      outAt: null,
      lateMinutes: 0,
      earlyMinutes: 0,
    });
  });
  it('takes earliest as in and latest as out, whatever the order', () => {
    const r = staffDay({ ...base, punches: [at('11:00:00'), at('02:55:00'), at('08:00:00')] });
    expect(r.inAt).toEqual(at('02:55:00'));
    expect(r.outAt).toEqual(at('11:00:00'));
  });
  it('out 29 minutes after in is no out; 30 is an out', () => {
    const in_ = at('03:00:00');
    expect(staffDay({ ...base, punches: [in_, at('03:29:00')] }).outAt).toBeNull();
    expect(staffDay({ ...base, punches: [in_, at('03:29:59')] }).outAt).toBeNull();
    expect(staffDay({ ...base, punches: [in_, at('03:30:00')] }).outAt).toEqual(at('03:30:00'));
    expect(staffDay({ ...base, punches: [in_, at('03:20:00')], minGapMin: 15 }).outAt).toEqual(
      at('03:20:00'),
    );
  });
  it('late only strictly after start + grace, at least 1 minute', () => {
    expect(staffDay({ ...base, punches: [at('03:10:00')] }).lateMinutes).toBe(0);
    expect(staffDay({ ...base, punches: [at('03:10:01')] }).lateMinutes).toBe(10);
    expect(staffDay({ ...base, punches: [at('03:11:00')] }).lateMinutes).toBe(11);
    expect(staffDay({ ...base, lateGraceMin: 0, punches: [at('03:00:01')] }).lateMinutes).toBe(1);
  });
  it('early leave only strictly before end - grace', () => {
    const in_ = at('03:00:00');
    expect(staffDay({ ...base, punches: [in_, at('10:50:00')] }).earlyMinutes).toBe(0);
    expect(staffDay({ ...base, punches: [in_, at('10:49:59')] }).earlyMinutes).toBe(10);
    expect(staffDay({ ...base, punches: [in_, at('10:00:00')] }).earlyMinutes).toBe(60);
    expect(
      staffDay({ ...base, earlyGraceMin: 0, punches: [in_, at('10:59:59')] }).earlyMinutes,
    ).toBe(1);
    expect(
      staffDay({ ...base, earlyGraceMin: 0, punches: [in_, at('11:00:00')] }).earlyMinutes,
    ).toBe(0);
  });
  it('no early leave without an out', () => {
    expect(staffDay({ ...base, punches: [at('03:00:00'), at('03:10:00')] }).earlyMinutes).toBe(0);
  });
});

describe('staffAttendanceTracked', () => {
  it('by default everyone with an active staff role except an owner with no other role', () => {
    const tracked = (roles: ('OWNER' | 'ADMIN' | 'TEACHER' | 'STAFF')[]) =>
      staffAttendanceTracked({ tracked: null, activeStaffRoles: roles });
    expect(tracked(['TEACHER'])).toBe(true);
    expect(tracked(['STAFF'])).toBe(true);
    expect(tracked(['OWNER'])).toBe(false);
    expect(tracked(['OWNER', 'TEACHER'])).toBe(true);
    expect(tracked([])).toBe(false);
  });
  it("the person's own switch wins, but never without an active staff role", () => {
    expect(staffAttendanceTracked({ tracked: true, activeStaffRoles: ['OWNER'] })).toBe(true);
    expect(staffAttendanceTracked({ tracked: false, activeStaffRoles: ['TEACHER'] })).toBe(false);
    expect(staffAttendanceTracked({ tracked: true, activeStaffRoles: [] })).toBe(false);
  });
});

describe('staffMonth', () => {
  const days = [
    { date: '2026-10-01', off: false },
    { date: '2026-10-02', off: true },
    { date: '2026-10-03', off: false },
    { date: '2026-10-04', off: false },
    { date: '2026-10-05', off: false },
    { date: '2026-10-06', off: false },
    { date: '2026-10-07', off: false },
  ];
  const row = (
    key: string,
    date: string,
    status: 'PRESENT' | 'ABSENT' | 'LEAVE',
    lateMinutes = 0,
    earlyMinutes = 0,
  ) => ({ key, date, status, lateMinutes, earlyMinutes });

  it('builds cells and totals', () => {
    const r = staffMonth({
      month: '2026-10',
      days,
      today: '2026-10-06',
      officeEndPassedToday: false,
      people: [
        { key: 'a', since: '2026-09-01' },
        { key: 'b', since: '2026-10-04' },
      ],
      rows: [
        row('a', '2026-10-01', 'PRESENT'),
        row('a', '2026-10-03', 'PRESENT', 5, 0),
        row('a', '2026-10-04', 'PRESENT', 0, 20),
        row('a', '2026-10-05', 'PRESENT', 7, 3),
        row('b', '2026-10-05', 'LEAVE'),
        row('b', '2026-10-04', 'ABSENT'),
      ],
    });
    expect(r).toHaveLength(2);
    expect(r[0]!.key).toBe('a');
    expect(r[0]!.cells).toEqual(['PRESENT', 'OFF', 'LATE', 'EARLY', 'LATE_EARLY', 'NONE', 'NONE']);
    expect(r[0]!.totals).toEqual({
      present: 4,
      late: 2,
      early: 2,
      absent: 0,
      leave: 0,
      lateMinutes: 12,
      earlyMinutes: 23,
    });
    expect(r[1]!.cells).toEqual(['NONE', 'OFF', 'NONE', 'ABSENT', 'LEAVE', 'NONE', 'NONE']);
    expect(r[1]!.totals).toMatchObject({ present: 0, absent: 1, leave: 1 });
  });

  it('marks a past day without a row ABSENT, and today once office has ended', () => {
    const input = {
      month: '2026-10',
      days,
      today: '2026-10-06',
      people: [{ key: 'a', since: '2026-09-01' }],
      rows: [],
    };
    const before = staffMonth({ ...input, officeEndPassedToday: false })[0]!;
    expect(before.cells).toEqual(['ABSENT', 'OFF', 'ABSENT', 'ABSENT', 'ABSENT', 'NONE', 'NONE']);
    const after = staffMonth({ ...input, officeEndPassedToday: true })[0]!;
    expect(after.cells[5]).toBe('ABSENT');
    expect(after.cells[6]).toBe('NONE');
    expect(after.totals.absent).toBe(5);
  });

  it('has bn and en cell codes', () => {
    expect(STAFF_CELL_CODES.bn).toEqual({
      PRESENT: 'উ',
      LATE: 'দে',
      EARLY: 'আ',
      LATE_EARLY: 'দেআ',
      ABSENT: 'অ',
      LEAVE: 'ছু',
    });
    expect(STAFF_CELL_CODES.en).toEqual({
      PRESENT: 'P',
      LATE: 'L',
      EARLY: 'E',
      LATE_EARLY: 'LE',
      ABSENT: 'A',
      LEAVE: 'LV',
    });
  });
});
