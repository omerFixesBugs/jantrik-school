import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { validateSmsTemplate } from './sms.js';

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export type AttendanceMode = 'DAILY' | 'PER_SESSION';

/** 0 = the whole day (DAILY mode); 1..MAX_PERIOD = a period (PER_SESSION mode). */
export const MAX_PERIOD = 20;
const periodSchema = z.coerce.number().int().min(0).max(MAX_PERIOD);

// ─────────────────────────── Requests ───────────────────────────

/** PUT /attendance/sessions — submit (create or replace) one register. Idempotent per submissionId. */
export const submitAttendanceSchema = z.object({
  sectionId: z.uuid(),
  date: isoDateSchema,
  periodNo: periodSchema.default(0),
  subjectId: z.uuid().nullish(),
  /** Client-generated per draft revision; a retried request with the same id is answered, not re-applied. */
  submissionId: z.uuid(),
  /** The version the draft was based on; 0 for a register that did not exist yet. */
  baseVersion: z.number().int().min(0),
  /** OWNER/ADMIN only: take attendance on a weekly off day or holiday. */
  allowNonWorkingDay: z.boolean().optional(),
  records: z
    .array(
      z.object({
        studentId: z.uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        note: z.string().trim().max(200).nullish(),
      }),
    )
    .min(1)
    .max(500)
    .refine((r) => new Set(r.map((x) => x.studentId)).size === r.length, 'Duplicate student'),
});
export type SubmitAttendanceInput = z.input<typeof submitAttendanceSchema>;

/** GET /attendance/sessions and GET /attendance/my-sections. */
export const attendanceSheetQuerySchema = z.object({
  sectionId: z.uuid(),
  date: isoDateSchema.optional(),
  periodNo: periodSchema.default(0),
});
export const mySectionsQuerySchema = z.object({ date: isoDateSchema.optional() });

/** PUT /attendance/settings (OWNER/ADMIN). */
export const attendanceSettingsSchema = z.object({
  mode: z.enum(['DAILY', 'PER_SESSION']),
  weeklyOffDays: z
    .array(z.number().int().min(1).max(7))
    .max(6)
    .refine((d) => new Set(d).size === d.length, 'Duplicate day'),
  editWindowDays: z.number().int().min(0).max(30),
  leaveCountsAsAbsent: z.boolean(),
  absentSmsEnabled: z.boolean(),
  /** Null or empty = the built-in template. */
  absentSmsTemplate: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform((t) => (t ? t : null))
    .superRefine((t, ctx) => {
      for (const message of t ? validateSmsTemplate(t) : [])
        ctx.addIssue({ code: 'custom', message });
    }),
  absentSmsDelayMinutes: z.number().int().min(0).max(240),
  /** Null = 2 × active students. */
  dailySmsCap: z.number().int().min(0).max(1_000_000).nullable(),
});
export type AttendanceSettingsInput = z.input<typeof attendanceSettingsSchema>;

/** POST/PUT /attendance/holidays (OWNER/ADMIN). */
export const holidaySchema = z
  .object({
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    nameBn: z.string().trim().min(1).max(120),
    nameEn: z.string().trim().min(1).max(120),
  })
  .refine((h) => h.endDate >= h.startDate, { message: 'End before start', path: ['endDate'] });

/** PUT /attendance/sections/:id/teachers (OWNER/ADMIN): the full list for the section. */
export const sectionTeachersSchema = z.object({
  teachers: z
    .array(z.object({ userId: z.uuid(), isClassTeacher: z.boolean().default(false) }))
    .max(30)
    .refine((t) => new Set(t.map((x) => x.userId)).size === t.length, 'Duplicate teacher')
    .refine((t) => t.filter((x) => x.isClassTeacher).length <= 1, 'Only one class teacher'),
});

// ─────────────────────────── Responses ───────────────────────────

export interface AttendanceSettings {
  mode: AttendanceMode;
  weeklyOffDays: number[];
  editWindowDays: number;
  leaveCountsAsAbsent: boolean;
  absentSmsEnabled: boolean;
  /** The tenant's own template, or null for the built-in one. */
  absentSmsTemplate: string | null;
  /** What is actually sent. */
  effectiveAbsentSmsTemplate: string;
  absentSmsDelayMinutes: number;
  dailySmsCap: number | null;
  /** The automatic cap: 2 × active students (used when dailySmsCap is null). */
  automaticSmsCap: number;
  /** A ceiling set by Jantrik (the plan); null when there is none. */
  platformSmsCap: number | null;
  /** The cap in force today: dailySmsCap (or 2 × active students), at most platformSmsCap. */
  effectiveDailySmsCap: number;
}

/** Why a date has no attendance by default. */
export type NonWorkingDay =
  { reason: 'OFF_DAY' } | { reason: 'HOLIDAY'; nameBn: string; nameEn: string };

export interface PersonRef {
  id: string;
  name: string;
  nameBn: string | null;
}

export interface SectionRef {
  id: string;
  name: string;
  classLevel: { id: string; nameBn: string; nameEn: string };
}

export interface MySectionsResponse {
  /** Server's today in the tenant timezone. Clients never use the device date. */
  today: IsoDate;
  date: IsoDate;
  mode: AttendanceMode;
  nonWorkingDay: NonWorkingDay | null;
  sections: (SectionRef & {
    isClassTeacher: boolean;
    studentCount: number;
    /** Registers already submitted for `date`. */
    sessions: { periodNo: number; version: number; submittedAt: string }[];
  })[];
}

/** One student on a register. Only what the take-attendance screen needs (no contact data). */
export interface RosterStudent {
  id: string;
  studentCode: string;
  roll: number | null;
  nameBn: string | null;
  nameEn: string | null;
}

export interface AttendanceSessionState {
  id: string;
  version: number;
  submittedAt: string;
  updatedBy: PersonRef;
  records: { studentId: string; status: AttendanceStatus; note: string | null }[];
}

/** GET /attendance/sessions: everything needed to take or edit one register. */
export interface AttendanceSheet {
  today: IsoDate;
  date: IsoDate;
  periodNo: number;
  mode: AttendanceMode;
  section: SectionRef;
  nonWorkingDay: NonWorkingDay | null;
  /** Whether the caller may submit for this date (edit window, role). */
  canSubmit: boolean;
  /** Why not, when canSubmit is false. */
  blockedReason: 'FUTURE_DATE' | 'EDIT_WINDOW_CLOSED' | 'NON_WORKING_DAY' | null;
  students: RosterStudent[];
  /** Null when attendance has not been taken yet. */
  session: AttendanceSessionState | null;
}

export interface SubmitAttendanceResponse {
  today: IsoDate;
  session: AttendanceSessionState;
  /** True when this was a retry of an already accepted submit (nothing changed). */
  replayed: boolean;
}

/** Error codes in 4xx bodies (`{ statusCode, code, message, … }`). */
export type AttendanceErrorCode =
  | 'NOT_ASSIGNED'
  | 'FUTURE_DATE'
  | 'EDIT_WINDOW_CLOSED'
  | 'NON_WORKING_DAY'
  | 'WRONG_PERIOD_FOR_MODE'
  | 'SECTION_NOT_CURRENT'
  | 'UNKNOWN_SUBJECT'
  | 'UNKNOWN_STUDENT'
  /** 409: the roster changed since the draft; body has `students` (the current roster). */
  | 'ROSTER_CHANGED'
  /** 409: someone else saved first; body has `session` (the current state). */
  | 'VERSION_CONFLICT';

export interface Holiday {
  id: string;
  startDate: IsoDate;
  endDate: IsoDate;
  nameBn: string;
  nameEn: string;
}

export interface SectionTeacherEntry {
  user: PersonRef;
  isClassTeacher: boolean;
}

/**
 * GET /attendance/summary/today: the dashboard "present today" card. Caller's sections (teacher)
 * or all (admin). In PER_SESSION mode each section's first period of the day is the roll call.
 */
export interface AttendanceTodaySummary {
  today: IsoDate;
  sectionsTotal: number;
  sectionsTaken: number;
  /** Students on the counted registers. */
  students: number;
  counts: AttendanceCounts;
  /** Present % with the tenant's LEAVE rule; null when nothing is taken yet. */
  percent: number | null;
  /** Whether this institute has ever taken attendance (getting-started checklist). */
  everTaken: boolean;
}

/** GET /attendance/sms/today (OWNER/ADMIN): for the dashboard over-limit warning. */
export interface SmsDailyStatus {
  date: IsoDate;
  cap: number;
  /** Queued or sent today. */
  used: number;
  /** Held back today because the cap was reached. */
  held: number;
  /** SMS segments those held messages take (what releasing them costs). */
  heldSegments: number;
}

// ─────────────────────────── Calculations ───────────────────────────

export interface AttendanceCounts {
  present: number;
  absent: number;
  late: number;
  leave: number;
}

/**
 * Present % (0–100) or null when nothing counts. LATE counts as present. LEAVE is left out of
 * the total, unless the tenant counts LEAVE as absent (attendance_settings).
 */
export function attendancePercent(
  c: AttendanceCounts,
  leaveCountsAsAbsent: boolean,
): number | null {
  const attended = c.present + c.late;
  const total = c.present + c.absent + c.late + (leaveCountsAsAbsent ? c.leave : 0);
  return total === 0 ? null : (attended / total) * 100;
}
