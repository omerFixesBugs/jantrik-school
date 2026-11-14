import { z } from 'zod';
import { ATTENDANCE_STATUSES, DEVICE_SUBMISSION_ID, MAX_PERIOD } from './attendance.js';
import { isoDateSchema } from './dates-schema.js';
import { toAsciiDigits } from './digits.js';
import { timeOfDaySchema } from './setup.js';
import { validateSmsTemplate } from './sms.js';

// The attendance API's request schemas, apart from attendance.ts so the browser can use its
// rules and types without loading zod (see dates-schema.ts).

const periodSchema = z.coerce.number().int().min(0).max(MAX_PERIOD);

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
