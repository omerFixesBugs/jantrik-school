import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';
import { timeOfDaySchema } from './setup.js';
import { validateSmsTemplate } from './sms.js';

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export type AttendanceMode = 'DAILY' | 'PER_SESSION';

/** Who set a register or a record: a person (MANUAL) or the device job at the cutoff (DEVICE). */
export const ATTENDANCE_SOURCES = ['MANUAL', 'DEVICE'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** 0 = the whole day (DAILY mode); 1..MAX_PERIOD = a period (PER_SESSION mode). */
export const MAX_PERIOD = 20;
const periodSchema = z.coerce.number().int().min(0).max(MAX_PERIOD);

/**
 * The submission id a change by the device leaves on a register (`last_submission_id`), so the
 * register says the device changed it last while it keeps the person who edited it. Never a
 * client's.
 */
export const DEVICE_SUBMISSION_ID = '00000000-0000-0000-0000-000000000000';

// ─────────────────────────── Requests ───────────────────────────

/** PUT /attendance/sessions — submit (create or replace) one register. Idempotent per submissionId. */
export const submitAttendanceSchema = z.object({
  sectionId: z.uuid(),
  date: isoDateSchema,
  periodNo: periodSchema.default(0),
  subjectId: z.uuid().nullish(),
  /** Client-generated per draft revision; a retried request with the same id is answered, not re-applied. */
  submissionId: z.uuid().refine((id) => id !== DEVICE_SUBMISSION_ID, 'Reserved for the device'),
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

/** A whole number in a range; Bangla digits accepted when it is sent as text. */
const settingNumber = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => {
      if (typeof v === 'number') return v;
      const digits = toAsciiDigits(v).trim();
      return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
    })
    .pipe(z.number().int().min(min).max(max));

/** Devices and staff attendance (step 11). Times are local wall-clock "HH:MM". */
export interface DeviceAttendanceSettings {
  /** Device punches write the register at the cutoff (DAILY mode). */
  deviceAutoMark: boolean;
  /** A first IN punch after shift start + grace is LATE. */
  deviceGraceMinutes: number;
  /** The register is written at shift start + cutoff. */
  deviceCutoffMinutes: number;
  /** "School starts at", for sections without a shift. */
  deviceDefaultStart: string;
  entrySmsEnabled: boolean;
  exitSmsEnabled: boolean;
  staffOfficeStart: string;
  staffOfficeEnd: string;
  staffLateGraceMinutes: number;
  staffEarlyGraceMinutes: number;
  /** Punches outside these hours are flagged OUTSIDE_HOURS. */
  deviceHoursStart: string;
  deviceHoursEnd: string;
  /** Per device and minute: punches over it are held (BURST), beyond 5 × it dropped. */
  deviceMaxPunchesPerMinute: number;
  /** Staff default device IDs are taken from here up. */
  staffDeviceIdStart: number;
  /** Raw punches older than this are deleted. */
  punchRetentionDays: number;
}

/** The database defaults (attendance_settings), also used for institutes without a row. */
export const DEVICE_SETTINGS_DEFAULTS: DeviceAttendanceSettings = {
  deviceAutoMark: false,
  deviceGraceMinutes: 10,
  deviceCutoffMinutes: 60,
  deviceDefaultStart: '08:00',
  entrySmsEnabled: false,
  exitSmsEnabled: false,
  staffOfficeStart: '08:00',
  staffOfficeEnd: '16:00',
  staffLateGraceMinutes: 10,
  staffEarlyGraceMinutes: 10,
  deviceHoursStart: '05:00',
  deviceHoursEnd: '20:00',
  deviceMaxPunchesPerMinute: 60,
  staffDeviceIdStart: 9001,
  punchRetentionDays: 730,
};

/** PUT /attendance/settings (OWNER/ADMIN): the whole object. */
export const attendanceSettingsSchema = z
  .object({
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
    deviceAutoMark: z.boolean(),
    deviceGraceMinutes: settingNumber(0, 120),
    deviceCutoffMinutes: settingNumber(15, 300),
    deviceDefaultStart: timeOfDaySchema,
    entrySmsEnabled: z.boolean(),
    exitSmsEnabled: z.boolean(),
    staffOfficeStart: timeOfDaySchema,
    staffOfficeEnd: timeOfDaySchema,
    staffLateGraceMinutes: settingNumber(0, 120),
    staffEarlyGraceMinutes: settingNumber(0, 120),
    deviceHoursStart: timeOfDaySchema,
    deviceHoursEnd: timeOfDaySchema,
    deviceMaxPunchesPerMinute: settingNumber(10, 240),
    staffDeviceIdStart: settingNumber(100, 999_999_999),
    punchRetentionDays: settingNumber(30, 3650),
  })
  .refine((s) => s.staffOfficeEnd > s.staffOfficeStart, {
    message: 'End must be after start',
    path: ['staffOfficeEnd'],
  })
  .refine((s) => s.deviceHoursEnd > s.deviceHoursStart, {
    message: 'End must be after start',
    path: ['deviceHoursEnd'],
  });
export type AttendanceSettingsInput = z.input<typeof attendanceSettingsSchema>;
/** What the API gets after validation (numbers and times normalised). */
export type AttendanceSettingsUpdate = z.output<typeof attendanceSettingsSchema>;

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

export interface AttendanceSettings extends DeviceAttendanceSettings {
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
  /** DEVICE: written at the cutoff; it stays DEVICE when a person edits it. */
  source: AttendanceSource;
  /** Unnamed (empty id and name) when the device changed it last, even after a person's edit. */
  updatedBy: PersonRef;
  /**
   * True when the device changed it last ("ডিভাইস changed this at 09:30"): it wrote the register,
   * or changed a record after a person's edit.
   */
  updatedByDevice: boolean;
  records: {
    studentId: string;
    status: AttendanceStatus;
    note: string | null;
    /** MANUAL once a person changed the status; the device never changes it then. */
    source: AttendanceSource;
  }[];
}

/** A student's first IN punch of the day that counts, judged by the shift start and the grace. */
export interface StudentArrival {
  /** The punch time (ISO). */
  at: string;
  status: 'PRESENT' | 'LATE';
}

/** One student on the take-attendance screen. */
export interface SheetStudent extends RosterStudent {
  /** From the device punches of that date; null when none counts. */
  arrival: StudentArrival | null;
  /**
   * Only while no register exists, in DAILY mode with device auto-mark on: the device's view to
   * start the register from (arrived: PRESENT or LATE; others ABSENT). Null otherwise.
   */
  suggested: AttendanceStatus | null;
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
  students: SheetStudent[];
  /** Null when attendance has not been taken yet. */
  session: AttendanceSessionState | null;
}

/** POST /attendance/sections/:id/close-from-device (OWNER/ADMIN): the register written. */
export interface CloseFromDeviceResult {
  sessionId: string;
  submittedAt: string;
  counts: AttendanceCounts;
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
  | 'VERSION_CONFLICT'
  /** 409, close from device: the day's register exists already. */
  | 'REGISTER_EXISTS'
  /** 409, close from device: the shift's cutoff has not passed; body has `cutoffAt` (HH:MM). */
  | 'BEFORE_CUTOFF'
  /** 422, close from device: nobody is enrolled in the section. */
  | 'NO_STUDENTS'
  /** 409 with Retry-After: a lock wait ran out; nothing was changed, try again in a moment. */
  | 'BUSY';

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
