import {
  attendancePercent,
  type AttendanceCounts,
  type AttendanceStatus,
  type NonWorkingDay,
} from './attendance.js';
import { csvCell } from './csv.js';
import { addDays, isoWeekday, type IsoDate } from './dates.js';

/**
 * The monthly register (like the paper one): students × days, with totals per student and per
 * day. Pure, so the API, the CSV export and the tests compute it the same way.
 */

export interface RegisterStudentInput {
  id: string;
  roll: number | null;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
}

export interface RegisterInput {
  /** YYYY-MM */
  month: string;
  students: RegisterStudentInput[];
  /** One status per student per date (the chosen period's register). */
  records: { studentId: string; date: IsoDate; status: AttendanceStatus }[];
  /** Dates that have a register (taken), even if a student has no record on it. */
  takenDates: IsoDate[];
  nonWorking: Record<IsoDate, NonWorkingDay>;
  leaveCountsAsAbsent: boolean;
}

export interface RegisterDay {
  date: IsoDate;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
  nonWorkingDay: NonWorkingDay | null;
  taken: boolean;
}

export interface RegisterRow extends RegisterStudentInput {
  /** Only dates that were taken; absent key = no record. */
  cells: Record<IsoDate, AttendanceStatus>;
  counts: AttendanceCounts;
  percent: number | null;
}

export interface MonthRegister {
  month: string;
  days: RegisterDay[];
  rows: RegisterRow[];
  dayTotals: Record<IsoDate, AttendanceCounts>;
  /** Registers taken this month. */
  daysTaken: number;
  totals: { counts: AttendanceCounts; percent: number | null };
}

const emptyCounts = (): AttendanceCounts => ({ present: 0, absent: 0, late: 0, leave: 0 });
const KEY = { PRESENT: 'present', ABSENT: 'absent', LATE: 'late', LEAVE: 'leave' } as const;

/** Every date of a YYYY-MM month. */
export function monthDates(month: string): IsoDate[] {
  const first = `${month}-01`;
  const out: IsoDate[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

export function buildRegister(input: RegisterInput): MonthRegister {
  const taken = new Set(input.takenDates);
  const days: RegisterDay[] = monthDates(input.month).map((date) => ({
    date,
    weekday: isoWeekday(date),
    nonWorkingDay: input.nonWorking[date] ?? null,
    taken: taken.has(date),
  }));
  const byStudent = new Map<string, Record<IsoDate, AttendanceStatus>>();
  for (const r of input.records) {
    if (!taken.has(r.date)) continue;
    const cells = byStudent.get(r.studentId) ?? {};
    cells[r.date] = r.status;
    byStudent.set(r.studentId, cells);
  }
  const dayTotals: Record<IsoDate, AttendanceCounts> = {};
  for (const d of days) if (d.taken) dayTotals[d.date] = emptyCounts();
  const totals = emptyCounts();

  const rows: RegisterRow[] = input.students.map((s) => {
    const cells = byStudent.get(s.id) ?? {};
    const counts = emptyCounts();
    for (const [date, status] of Object.entries(cells)) {
      counts[KEY[status]] += 1;
      dayTotals[date]![KEY[status]] += 1;
      totals[KEY[status]] += 1;
    }
    return { ...s, cells, counts, percent: attendancePercent(counts, input.leaveCountsAsAbsent) };
  });

  return {
    month: input.month,
    days,
    rows,
    dayTotals,
    daysTaken: days.filter((d) => d.taken).length,
    totals: { counts: totals, percent: attendancePercent(totals, input.leaveCountsAsAbsent) },
  };
}

/** Register cell codes, like the paper register. */
export const REGISTER_CODES = {
  bn: { PRESENT: 'উ', ABSENT: 'অ', LATE: 'দে', LEAVE: 'ছু' },
  en: { PRESENT: 'P', ABSENT: 'A', LATE: 'L', LEAVE: 'LV' },
} as const satisfies Record<'bn' | 'en', Record<AttendanceStatus, string>>;

/**
 * CSV for spreadsheets: UTF-8 with a BOM (so Excel shows Bangla), ASCII digits always (so the
 * numbers are numbers), CRLF line ends, one row per student, totals at the end.
 */
export function registerCsv(
  reg: MonthRegister,
  locale: 'bn' | 'en',
  labels: {
    roll: string;
    id: string;
    name: string;
    present: string;
    absent: string;
    late: string;
    leave: string;
    percent: string;
  },
): string {
  const codes = REGISTER_CODES[locale];
  const taken = reg.days.filter((d) => d.taken);
  // Quoted and formula-safe: names come from user input.
  const esc = (v: string) => csvCell(v);
  const header = [
    labels.roll,
    labels.id,
    labels.name,
    ...taken.map((d) => String(Number(d.date.slice(8)))),
    labels.present,
    labels.absent,
    labels.late,
    labels.leave,
    labels.percent,
  ];
  const lines = [header.map(esc).join(',')];
  for (const r of reg.rows) {
    const name = (locale === 'bn' ? (r.nameBn ?? r.nameEn) : (r.nameEn ?? r.nameBn)) ?? '';
    lines.push(
      [
        r.roll === null ? '' : String(r.roll),
        r.studentCode,
        name,
        ...taken.map((d) => (r.cells[d.date] ? codes[r.cells[d.date]!] : '')),
        String(r.counts.present),
        String(r.counts.absent),
        String(r.counts.late),
        String(r.counts.leave),
        r.percent === null ? '' : r.percent.toFixed(1),
      ]
        .map(esc)
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
