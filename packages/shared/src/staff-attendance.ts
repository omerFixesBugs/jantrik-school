import { localTimeOf, secondsOfDay } from './dates.js';
import type { IsoDate } from './dates.js';
import type { StaffRole } from './staff.js';

/** Staff attendance from device punches: one day per person, and the month grid with totals. */

/**
 * Whether a person's attendance is kept as staff. Never without an active staff role; then their
 * own switch (`staff_profiles.attendance_tracked`), or by default everyone except people whose
 * only staff role is OWNER.
 */
export function staffAttendanceTracked(input: {
  tracked: boolean | null;
  activeStaffRoles: readonly StaffRole[];
}): boolean {
  if (input.activeStaffRoles.length === 0) return false;
  return input.tracked ?? input.activeStaffRoles.some((r) => r !== 'OWNER');
}

export interface StaffDay {
  inAt: Date;
  outAt: Date | null;
  lateMinutes: number;
  earlyMinutes: number;
}

/**
 * One staff member's day from the punches that count (the caller filters; at least one). Direction
 * is ignored: the first punch is the in, the last is the out if it is at least `minGapMin` later.
 */
export function staffDay(input: {
  punches: Date[];
  timeZone: string;
  officeStart: string;
  officeEnd: string;
  lateGraceMin: number;
  earlyGraceMin: number;
  minGapMin?: number;
}): StaffDay {
  const { timeZone, minGapMin = 30 } = input;
  const times = input.punches.map((p) => p.getTime()).sort((a, b) => a - b);
  const first = times[0];
  if (first === undefined) throw new Error('staffDay needs at least one punch');
  const last = times[times.length - 1]!;
  const inAt = new Date(first);
  const outAt = last - first >= minGapMin * 60_000 ? new Date(last) : null;

  const start = secondsOfDay(input.officeStart);
  const inSec = secondsOfDay(localTimeOf(inAt, timeZone));
  const lateMinutes =
    inSec > start + input.lateGraceMin * 60 ? Math.max(1, Math.floor((inSec - start) / 60)) : 0;

  let earlyMinutes = 0;
  if (outAt) {
    const end = secondsOfDay(input.officeEnd);
    const outSec = secondsOfDay(localTimeOf(outAt, timeZone));
    if (outSec < end - input.earlyGraceMin * 60) {
      earlyMinutes = Math.max(1, Math.floor((end - outSec) / 60));
    }
  }
  return { inAt, outAt, lateMinutes, earlyMinutes };
}

/** A day without a row, as the day view shows it. */
export type StaffDayState = 'ABSENT' | 'NOT_YET' | 'OFF' | 'NONE';

/**
 * One person's day without a row: OFF on a non-working day; NONE when their attendance is not
 * kept, before `since` (they were not staff yet) or after today; NOT_YET today before office end;
 * otherwise ABSENT. Computed, never stored.
 */
export function staffDayState(input: {
  date: IsoDate;
  today: IsoDate;
  since: IsoDate;
  off: boolean;
  tracked: boolean;
  officeEndPassedToday: boolean;
}): StaffDayState {
  if (input.off) return 'OFF';
  if (!input.tracked || input.date < input.since || input.date > input.today) return 'NONE';
  if (input.date === input.today && !input.officeEndPassedToday) return 'NOT_YET';
  return 'ABSENT';
}

export type StaffCell =
  'PRESENT' | 'LATE' | 'EARLY' | 'LATE_EARLY' | 'ABSENT' | 'LEAVE' | 'OFF' | 'NONE';

/** Short codes in the printed grid. */
export const STAFF_CELL_CODES = {
  bn: { PRESENT: 'উ', LATE: 'দে', EARLY: 'আ', LATE_EARLY: 'দেআ', ABSENT: 'অ', LEAVE: 'ছু' },
  en: { PRESENT: 'P', LATE: 'L', EARLY: 'E', LATE_EARLY: 'LE', ABSENT: 'A', LEAVE: 'LV' },
} as const;

export interface StaffMonthTotals {
  present: number;
  late: number;
  early: number;
  absent: number;
  leave: number;
  lateMinutes: number;
  earlyMinutes: number;
}

export interface StaffMonthRow {
  key: string;
  /** One cell per entry of the input `days`, in order. */
  cells: StaffCell[];
  totals: StaffMonthTotals;
}

export function staffMonth(input: {
  month: string;
  days: { date: IsoDate; off: boolean }[];
  today: IsoDate;
  /** `tracked` false (listed for their rows only): days without a row are NONE. Default true. */
  people: { key: string; since: IsoDate; tracked?: boolean }[];
  rows: {
    key: string;
    date: IsoDate;
    status: 'PRESENT' | 'ABSENT' | 'LEAVE';
    lateMinutes: number;
    earlyMinutes: number;
  }[];
  officeEndPassedToday: boolean;
}): StaffMonthRow[] {
  const byPersonDay = new Map<string, (typeof input.rows)[number]>();
  for (const r of input.rows) byPersonDay.set(`${r.key}|${r.date}`, r);

  return input.people.map((person) => {
    const totals: StaffMonthTotals = {
      present: 0,
      late: 0,
      early: 0,
      absent: 0,
      leave: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
    const cells = input.days.map((day): StaffCell => {
      const row = byPersonDay.get(`${person.key}|${day.date}`);
      if (row) {
        if (row.status === 'LEAVE') {
          totals.leave += 1;
          return 'LEAVE';
        }
        if (row.status === 'ABSENT') {
          totals.absent += 1;
          return 'ABSENT';
        }
        totals.present += 1;
        totals.lateMinutes += row.lateMinutes;
        totals.earlyMinutes += row.earlyMinutes;
        if (row.lateMinutes > 0) totals.late += 1;
        if (row.earlyMinutes > 0) totals.early += 1;
        if (row.lateMinutes > 0 && row.earlyMinutes > 0) return 'LATE_EARLY';
        if (row.lateMinutes > 0) return 'LATE';
        return row.earlyMinutes > 0 ? 'EARLY' : 'PRESENT';
      }
      const state = staffDayState({
        date: day.date,
        today: input.today,
        since: person.since,
        off: day.off,
        tracked: person.tracked ?? true,
        officeEndPassedToday: input.officeEndPassedToday,
      });
      if (state === 'ABSENT') {
        totals.absent += 1;
        return 'ABSENT';
      }
      // Today before office end is NOT_YET in the day view, an empty cell here.
      return state === 'OFF' ? 'OFF' : 'NONE';
    });
    return { key: person.key, cells, totals };
  });
}
