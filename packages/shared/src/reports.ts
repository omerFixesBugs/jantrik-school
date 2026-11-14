import { z } from 'zod';
import {
  attendancePercent,
  MAX_PERIOD,
  type AttendanceCounts,
  type AttendanceMode,
  type AttendanceSource,
  type AttendanceStatus,
  type NonWorkingDay,
  type PersonRef,
  type RosterStudent,
  type SectionRef,
} from './attendance.js';
import { addDays, type IsoDate } from './dates.js';
import { isoDateSchema } from './dates-schema.js';
import type { DeviceRegisterState } from './devices.js';
import type { MonthRegister } from './register.js';

// ─────────────────────────── Requests ───────────────────────────

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

/** GET /attendance/reports/register and …/register/csv */
export const registerQuerySchema = z.object({
  sectionId: z.uuid(),
  month: monthSchema,
  /** Which register in PER_SESSION mode; ignored (0) in DAILY mode. Omitted = first of the day. */
  periodNo: z.coerce.number().int().min(0).max(MAX_PERIOD).optional(),
  locale: z.enum(['bn', 'en']).default('bn'),
});
export type RegisterQuery = z.infer<typeof registerQuerySchema>;

/** GET /attendance/reports/students/:id — at most a year. */
export const studentReportQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.to >= q.from, { message: 'End before start', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    message: 'At most one year',
    path: ['to'],
  });

/** GET /me/children/:id/attendance */
export const childAttendanceQuerySchema = z.object({ month: monthSchema.optional() });

export const TREND_MAX_DAYS = 90;

/** GET /attendance/reports/trend */
export const trendQuerySchema = z.object({
  /** Calendar days back from today, today included; never before the year's start. */
  days: z.coerce.number().int().min(7).max(TREND_MAX_DAYS).default(30),
  /** One section only (it must be the caller's); omitted = all the caller's sections. */
  sectionId: z.uuid().optional(),
  /** Also each section's own line. */
  bySection: z.stringbool().optional(),
});
export type TrendQuery = z.input<typeof trendQuerySchema>;

// ─────────────────────────── Responses ───────────────────────────

/**
 * A section's day by device, live: students arrived so far (late among them) of those enrolled,
 * the shift's cutoff, and where the register stands: CLOSED once the day's register exists, else
 * BEFORE_CUTOFF or why the cutoff held it back (an admin can close it from the device then):
 * DEVICE_OFFLINE, NOT_ON_DEVICE, TOO_MANY_MISSING, or AUTO_CLOSE_ENDED (an hour after the cutoff
 * it no longer closes by itself and waits for a person). The counts are of ACTIVE enrolled
 * students only (inactive ones are never sent to a device; the register still lists them).
 */
export interface SectionDeviceToday {
  arrived: number;
  late: number;
  enrolled: number;
  /**
   * ACTIVE enrolled students who cannot punch: no device ID, or not confirmed on any active device
   * (inactive ones are never sent to a device, so they are not counted).
   */
  notOnDevice: number;
  /** HH:MM */
  cutoffAt: string;
  state: DeviceRegisterState;
}

/** GET /attendance/reports/today: every section's roll call today (teachers: their own). */
export interface AttendanceTodayReport {
  today: IsoDate;
  mode: AttendanceMode;
  nonWorkingDay: NonWorkingDay | null;
  leaveCountsAsAbsent: boolean;
  sections: {
    section: SectionRef;
    studentCount: number;
    /** DAILY mode with device auto-mark on; null otherwise and for a section with no students. */
    device: SectionDeviceToday | null;
    /** Null until the day's first register is submitted. */
    register: {
      periodNo: number;
      submittedAt: string;
      source: AttendanceSource;
      /**
       * The person who last changed it: on a DEVICE register the one who edited it, still named
       * when the device changes a record later. Unnamed while no person has (`updatedByDevice`).
       */
      updatedBy: PersonRef;
      /** True while no person has changed it: taken by the device and not edited. */
      updatedByDevice: boolean;
      counts: AttendanceCounts;
      percent: number | null;
      /**
       * Absent on that register, by roll, with the primary guardian's phone for calling. The
       * phone is set only for OWNER/ADMIN and the section's own teachers (null otherwise).
       * `streak`: school days absent in a row, today included (absenceStreak).
       */
      absent: (RosterStudent & { guardianPhone: string | null; streak: number })[];
    } | null;
  }[];
  totals: {
    sectionsTotal: number;
    sectionsTaken: number;
    counts: AttendanceCounts;
    percent: number | null;
  };
}

/** GET /attendance/reports/register */
export interface AttendanceRegisterReport extends MonthRegister {
  today: IsoDate;
  mode: AttendanceMode;
  /** The register shown (0 in DAILY mode). Null in PER_SESSION mode = each day's first. */
  periodNo: number | null;
  section: SectionRef;
  leaveCountsAsAbsent: boolean;
}

/** One day for one student: their status on the day's first register. */
export interface StudentDay {
  date: IsoDate;
  status: AttendanceStatus | null;
  nonWorkingDay: NonWorkingDay | null;
}

/** GET /attendance/reports/students/:id */
export interface StudentAttendanceReport {
  student: RosterStudent & { section: SectionRef | null };
  from: IsoDate;
  to: IsoDate;
  leaveCountsAsAbsent: boolean;
  /** Days with a register for the student's section. */
  daysTaken: number;
  counts: AttendanceCounts;
  percent: number | null;
  /** Only days with a record, newest first; `source` says who set it (a person or the device). */
  days: (StudentDay & { status: AttendanceStatus; source: AttendanceSource })[];
}

/** GET /me/children/:id/attendance: the guardian's month calendar. */
export interface ChildAttendanceMonth {
  today: IsoDate;
  /** YYYY-MM */
  month: string;
  leaveCountsAsAbsent: boolean;
  /** Every date of the month (future dates included, status null). */
  days: StudentDay[];
  counts: AttendanceCounts;
  percent: number | null;
}

/** One day of a trend: the day's first registers together. Null when none was taken. */
export interface TrendPoint {
  date: IsoDate;
  counts: AttendanceCounts | null;
  percent: number | null;
}

/** GET /attendance/reports/trend: present % per day (teachers: their sections). */
export interface AttendanceTrendReport {
  today: IsoDate;
  /** First and last date (today), inclusive. */
  from: IsoDate;
  to: IsoDate;
  leaveCountsAsAbsent: boolean;
  /** Every date from `from` to `to`, oldest first, all sections in scope together. */
  days: (TrendPoint & { nonWorkingDay: NonWorkingDay | null; sectionsTaken: number })[];
  /** With `bySection`: each section's own line over the same dates (in class order); else []. */
  sections: { section: SectionRef; days: TrendPoint[] }[];
}

/** The trend's first date: `days` back from today (today included), never before the year's start. */
export function trendFrom(today: IsoDate, days: number, yearStart: IsoDate | null): IsoDate {
  const from = addDays(today, -(days - 1));
  if (!yearStart || yearStart <= from) return from;
  return yearStart > today ? today : yearStart;
}

/** The day's first register of each section, as counts by date. */
export interface TrendInput {
  dates: readonly IsoDate[];
  nonWorking: Record<IsoDate, NonWorkingDay>;
  sections: readonly { section: SectionRef; byDate: ReadonlyMap<IsoDate, AttendanceCounts> }[];
  leaveCountsAsAbsent: boolean;
  bySection: boolean;
}

export function buildTrend(input: TrendInput): Pick<AttendanceTrendReport, 'days' | 'sections'> {
  const point = (date: IsoDate, counts: AttendanceCounts | null): TrendPoint => ({
    date,
    counts,
    percent: counts ? attendancePercent(counts, input.leaveCountsAsAbsent) : null,
  });
  const days = input.dates.map((date) => {
    const taken = input.sections.flatMap((s) => s.byDate.get(date) ?? []);
    const counts = taken.length === 0 ? null : sumCounts(taken);
    return {
      ...point(date, counts),
      nonWorkingDay: input.nonWorking[date] ?? null,
      sectionsTaken: taken.length,
    };
  });
  const sections = input.bySection
    ? input.sections.map((s) => ({
        section: s.section,
        days: input.dates.map((date) => point(date, s.byDate.get(date) ?? null)),
      }))
    : [];
  return { days, sections };
}

function sumCounts(all: readonly AttendanceCounts[]): AttendanceCounts {
  const c: AttendanceCounts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const x of all) {
    c.present += x.present;
    c.absent += x.absent;
    c.late += x.late;
    c.leave += x.leave;
  }
  return c;
}

/** The longest absence streak reported; and how far back the API looks for it. */
export const STREAK_CAP = 30;
export const STREAK_LOOKBACK_DAYS = 60;

/**
 * School days absent in a row, counting back from the newest day. `statuses` are the student's
 * status on each day that had a register, newest first, so a day without one never breaks the
 * run. ABSENT counts, and LEAVE too when the institute counts leave as absent; PRESENT, LATE or a
 * leave that does not count ends it. At most STREAK_CAP.
 */
export function absenceStreak(
  statuses: readonly AttendanceStatus[],
  leaveCountsAsAbsent: boolean,
): number {
  let n = 0;
  for (const s of statuses) {
    if (s !== 'ABSENT' && !(s === 'LEAVE' && leaveCountsAsAbsent)) break;
    n += 1;
    if (n === STREAK_CAP) break;
  }
  return n;
}

/** GET /attendance/staff (OWNER/ADMIN): who can be given a section. */
export interface AttendanceStaffMember extends PersonRef {
  role: 'OWNER' | 'ADMIN' | 'TEACHER';
}

/** POST /attendance/sms/held/send (OWNER/ADMIN) */
export interface SendHeldSmsResult {
  /** Released to the queue (sent in a moment). */
  queued: number;
  /** Not sent: the student is no longer absent today. */
  cancelled: number;
  /**
   * Still held: Jantrik's daily ceiling for the institute (the plan) is reached. The institute's
   * own cap can be passed by sending held SMS; the platform's cannot.
   */
  stillHeld: number;
  /** That ceiling, when there is one. */
  platformLimit: number | null;
}
