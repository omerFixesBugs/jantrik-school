import { attendancePercent, type AttendanceCounts } from './attendance.js';
import { addDays, type IsoDate } from './dates.js';
import type { TrendPoint } from './reports.js';

/*
 * The principal's dashboard, as data (docs/design.md → Dashboards): what today's one-line insight
 * says, what needs attention first, how this period compares with the last, and where the year
 * stands. Pure functions over the reports the dashboard already loads; the web app words them.
 */

/** School days absent in a row from which a student is someone to call. */
export const LONG_ABSENCE_DAYS = 3;
/** The present % an institute aims for (the trend's target line). */
export const ATTENDANCE_TARGET = 90;

const ZERO: AttendanceCounts = { present: 0, absent: 0, late: 0, leave: 0 };

/** Present % over some days, weighted by students (a full day counts more than a thin one). */
export function periodPercent(
  days: readonly TrendPoint[],
  leaveCountsAsAbsent: boolean,
): number | null {
  const sum = days.reduce(
    (s, d) =>
      d.counts
        ? {
            present: s.present + d.counts.present,
            absent: s.absent + d.counts.absent,
            late: s.late + d.counts.late,
            leave: s.leave + d.counts.leave,
          }
        : s,
    ZERO,
  );
  return attendancePercent(sum, leaveCountsAsAbsent);
}

/**
 * The last `length` days up to `today` and the `length` days before them, from a trend (oldest
 * first). Either may be shorter near the start of the year.
 */
export function splitPeriods<T extends { date: IsoDate }>(
  days: readonly T[],
  today: IsoDate,
  length: number,
): { current: T[]; previous: T[] } {
  const start = addDays(today, -(length - 1));
  const before = addDays(start, -length);
  return {
    current: days.filter((d) => d.date >= start && d.date <= today),
    previous: days.filter((d) => d.date >= before && d.date < start),
  };
}

/** The change between two percentages in points, rounded to one decimal; null without both. */
export function pointChange(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  return Math.round((now - before) * 10) / 10;
}

// ───────────────────────────── The insight ─────────────────────────────

export type InsightFact =
  /** Registers still to come today. */
  | { kind: 'coverage'; taken: number; total: number }
  /** Every register is in. */
  | { kind: 'allTaken'; total: number }
  /** Present of those counted today. */
  | { kind: 'present'; present: number; counted: number }
  /** Students absent LONG_ABSENCE_DAYS or more in a row: call their guardians. */
  | { kind: 'call'; count: number }
  /** This week against last week, in points (only when it moved at least a point). */
  | { kind: 'week'; change: number }
  /** A holiday or weekly off day: nothing is expected today. */
  | { kind: 'dayOff'; name: string | null }
  /** No sections yet: setting up comes first. */
  | { kind: 'setup' };

export interface InsightInput {
  sectionsTotal: number;
  sectionsTaken: number;
  counts: AttendanceCounts | null;
  longAbsent: number;
  /** This week's and last week's present %, when known. */
  week: { now: number | null; before: number | null };
  /** Today is not a school day (the holiday's name, or null for the weekly off day). */
  dayOff?: { name: string | null } | null;
}

/**
 * Today in one line (at most three facts, most useful first): how many registers are in, how
 * many are present, who to call; on a quiet day, how the week moved. Always true and never
 * empty: before anything is set up it says so.
 */
export function dashboardInsight(i: InsightInput): InsightFact[] {
  if (i.sectionsTotal === 0) return [{ kind: 'setup' }];
  if (i.dayOff && i.sectionsTaken === 0) return [{ kind: 'dayOff', name: i.dayOff.name }];
  const facts: InsightFact[] = [
    i.sectionsTaken < i.sectionsTotal
      ? { kind: 'coverage', taken: i.sectionsTaken, total: i.sectionsTotal }
      : { kind: 'allTaken', total: i.sectionsTotal },
  ];
  const c = i.counts ?? ZERO;
  const counted = c.present + c.absent + c.late + c.leave;
  if (counted > 0) facts.push({ kind: 'present', present: c.present + c.late, counted });
  if (i.longAbsent > 0) facts.push({ kind: 'call', count: i.longAbsent });
  const change = pointChange(i.week.now, i.week.before);
  if (facts.length < 3 && change !== null && Math.abs(change) >= 1) {
    facts.push({ kind: 'week', change });
  }
  return facts.slice(0, 3);
}

// ───────────────────────────── Needs attention ─────────────────────────────

export type AttentionItem =
  | {
      kind: 'longAbsence';
      severity: 3;
      students: { id: string; sectionId: string; streak: number }[];
    }
  | { kind: 'heldSms'; severity: 2; count: number }
  | { kind: 'notTaken'; severity: 2; sectionIds: string[] }
  | { kind: 'belowTarget'; severity: 1; sections: { sectionId: string; percent: number }[] }
  | { kind: 'setup'; severity: 0; step: string };

export interface AttentionInput {
  /** Today's absentees with their streak, by section. */
  absent: { id: string; sectionId: string; streak: number }[];
  /** Sections without today's register (on a school day). */
  notTaken: string[];
  heldSms: number;
  /** Each section's present % this week. */
  week: { sectionId: string; percent: number | null }[];
  /** The next setup step still to do, if any. */
  nextSetupStep: string | null;
}

/**
 * What needs the principal first, most urgent first: students away for days (call them), SMS
 * held back by the cap, registers not in yet, sections under the target this week, and the next
 * setup step. Empty when all is well.
 */
export function attentionItems(i: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const away = i.absent
    .filter((s) => s.streak >= LONG_ABSENCE_DAYS)
    .sort((a, b) => b.streak - a.streak);
  if (away.length) items.push({ kind: 'longAbsence', severity: 3, students: away });
  if (i.heldSms > 0) items.push({ kind: 'heldSms', severity: 2, count: i.heldSms });
  if (i.notTaken.length) items.push({ kind: 'notTaken', severity: 2, sectionIds: i.notTaken });
  const low = i.week
    .filter((s): s is { sectionId: string; percent: number } => s.percent !== null)
    .filter((s) => s.percent < ATTENDANCE_TARGET)
    .sort((a, b) => a.percent - b.percent);
  if (low.length) items.push({ kind: 'belowTarget', severity: 1, sections: low });
  if (i.nextSetupStep) items.push({ kind: 'setup', severity: 0, step: i.nextSetupStep });
  return items;
}

// ───────────────────────────── The term timeline ─────────────────────────────

export interface YearProgress {
  /** 0 … 100, through the academic year. */
  percent: number;
  /** The week of the year we are in (1 …) and how many weeks it has. */
  week: number;
  weeks: number;
  daysLeft: number;
}

const DAY = 86_400_000;
const days = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Where `today` stands in the academic year (clamped to its start and end). */
export function yearProgress(start: IsoDate, end: IsoDate, today: IsoDate): YearProgress {
  const length = Math.max(1, days(start, end) + 1);
  const done = Math.min(length, Math.max(0, days(start, today) + 1));
  return {
    percent: Math.round((done / length) * 1000) / 10,
    week: Math.max(1, Math.ceil(done / 7)),
    weeks: Math.ceil(length / 7),
    daysLeft: length - done,
  };
}

/** A typical exam of an institute type: its usual month, until the exams module schedules it. */
export interface TypicalExam {
  key: 'halfYearly' | 'annual' | 'preTest' | 'test';
  /** 1 … 12. */
  month: number;
}

/**
 * The exams an institute of each type usually holds (NCTB schools: half-yearly in June, annual
 * in November). Data, so a new type brings its own; types with no fixed exams have none.
 */
export const TYPICAL_EXAMS: Record<string, readonly TypicalExam[]> = {
  NCTB_SCHOOL_BN: [
    { key: 'halfYearly', month: 6 },
    { key: 'annual', month: 11 },
  ],
  NCTB_SCHOOL_EN: [
    { key: 'halfYearly', month: 6 },
    { key: 'annual', month: 11 },
  ],
};

/**
 * Typical exams placed on the year: the middle of their month in the year's span, as a
 * percentage along it; those outside the year are left out.
 */
export function typicalExamMarks(
  typeKey: string,
  start: IsoDate,
  end: IsoDate,
): (TypicalExam & { date: IsoDate; percent: number })[] {
  const length = Math.max(1, days(start, end) + 1);
  const out: (TypicalExam & { date: IsoDate; percent: number })[] = [];
  for (const exam of TYPICAL_EXAMS[typeKey] ?? []) {
    for (const year of new Set([start.slice(0, 4), end.slice(0, 4)])) {
      const date = `${year}-${String(exam.month).padStart(2, '0')}-15`;
      if (date < start || date > end) continue;
      out.push({ ...exam, date, percent: Math.round((days(start, date) / length) * 1000) / 10 });
      break;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
