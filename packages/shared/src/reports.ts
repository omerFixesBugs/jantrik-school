import { z } from 'zod';
import {
  MAX_PERIOD,
  type AttendanceCounts,
  type AttendanceMode,
  type AttendanceStatus,
  type NonWorkingDay,
  type PersonRef,
  type RosterStudent,
  type SectionRef,
} from './attendance.js';
import { isoDateSchema, type IsoDate } from './dates.js';
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

// ─────────────────────────── Responses ───────────────────────────

/** GET /attendance/reports/today: every section's roll call today (teachers: their own). */
export interface AttendanceTodayReport {
  today: IsoDate;
  mode: AttendanceMode;
  nonWorkingDay: NonWorkingDay | null;
  leaveCountsAsAbsent: boolean;
  sections: {
    section: SectionRef;
    studentCount: number;
    /** Null until the day's first register is submitted. */
    register: {
      periodNo: number;
      submittedAt: string;
      updatedBy: PersonRef;
      counts: AttendanceCounts;
      percent: number | null;
      /** Absent on that register, by roll. */
      absent: RosterStudent[];
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
  /** Only days with a record, newest first. */
  days: (StudentDay & { status: AttendanceStatus })[];
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
}
