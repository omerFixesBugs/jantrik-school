import { z } from 'zod';
import type { NonWorkingDay, PersonRef } from './attendance.js';
import { isoDateSchema, type IsoDate } from './dates.js';
import { monthSchema } from './reports.js';
import { timeOfDaySchema } from './setup.js';
import type { StaffCell, StaffDayState, StaffMonthTotals } from './staff-attendance.js';
import type { StaffRole } from './staff.js';

// Staff attendance (OWNER/ADMIN, module ATTENDANCE): a day's list with manual entries, each
// person's tracked switch, and the month report with its CSVs. "Staff" are people with an active
// staff role and a staff profile; names come from the profiles only.

export const STAFF_DAY_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE'] as const;
export type StaffDayStatus = (typeof STAFF_DAY_STATUSES)[number];

/** A manual day's reason, trimmed, in characters (as the database CHECK counts them). */
export const STAFF_REASON_MIN = 3;
export const STAFF_REASON_MAX = 200;

// ─────────────────────────── Requests ───────────────────────────

/** GET /staff-attendance/day: omitted = today. */
export const staffDayQuerySchema = z.object({ date: isoDateSchema.optional() });

/** PUT /staff-attendance/:userId/:date */
export const staffDayParamsSchema = z.object({ userId: z.uuid(), date: isoDateSchema });

/**
 * PUT /staff-attendance/:userId/:date: the day set by hand (MANUAL from then on; punches never
 * change it). Times are local wall-clock "HH:MM" (Bangla digits accepted); only PRESENT keeps
 * them and needs the in time (422 IN_TIME_REQUIRED).
 */
export const staffDayEntrySchema = z.object({
  status: z.enum(STAFF_DAY_STATUSES),
  inAt: timeOfDaySchema.nullish(),
  outAt: timeOfDaySchema.nullish(),
  reason: z
    .string()
    .trim()
    .refine((r) => {
      const length = [...r].length;
      return length >= STAFF_REASON_MIN && length <= STAFF_REASON_MAX;
    }, `Reason: ${STAFF_REASON_MIN} to ${STAFF_REASON_MAX} characters`),
  /** The version the entry was based on; 0 when the day had no row. */
  baseVersion: z.number().int().min(0),
});
export type StaffDayEntryInput = z.input<typeof staffDayEntrySchema>;
export type StaffDayEntry = z.output<typeof staffDayEntrySchema>;

/** PUT /staff-attendance/:userId/tracked: null = back to the default rule. */
export const staffTrackedSchema = z.object({ tracked: z.boolean().nullable() });

/** GET /staff-attendance/month */
export const staffMonthQuerySchema = z.object({ month: monthSchema });

/** GET /staff-attendance/month/csv: `grid` = a row per person, `days` = a row per stored day. */
export const staffMonthCsvQuerySchema = staffMonthQuerySchema.extend({
  locale: z.enum(['bn', 'en']).default('bn'),
  kind: z.enum(['grid', 'days']).default('grid'),
});
export type StaffMonthCsvQuery = z.output<typeof staffMonthCsvQuerySchema>;

// ─────────────────────────── Responses ───────────────────────────

export type StaffDaySource = 'MANUAL' | 'DEVICE';

/** A stored day. Times are instants (ISO); only PRESENT has them. */
export interface StaffDayRecord {
  status: StaffDayStatus;
  inAt: string | null;
  outAt: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  source: StaffDaySource;
  /** MANUAL only. */
  reason: string | null;
  version: number;
  /** Who set it by hand; a day the device wrote names nobody (empty id). */
  updatedBy: PersonRef;
}

/** A punch of the day that counts, for context. */
export interface StaffDayPunch {
  /** ISO instant. */
  punchedAt: string;
  deviceName: string;
}

export interface StaffOfficeHours {
  /** "HH:MM" */
  start: string;
  end: string;
  lateGraceMinutes: number;
  earlyGraceMinutes: number;
}

export interface StaffDayPerson {
  userId: string;
  name: string;
  nameBn: string | null;
  /** Active staff roles here (none: no longer staff, listed for their stored day). */
  roles: StaffRole[];
  /** Whether their attendance is kept now. */
  tracked: boolean;
  /** Their own switch; null = the default rule (everyone except an owner with no other role). */
  trackedSetting: boolean | null;
  /** The stored day, or null and `state` says what the day is. */
  day: StaffDayRecord | null;
  state: StaffDayState | null;
  punches: StaffDayPunch[];
}

/** GET /staff-attendance/day */
export interface StaffDayReport {
  today: IsoDate;
  date: IsoDate;
  nonWorkingDay: NonWorkingDay | null;
  /** The office hours in the settings now (a stored day keeps those it was judged by). */
  officeHours: StaffOfficeHours;
  people: StaffDayPerson[];
}

/** PUT /staff-attendance/:userId/tracked */
export interface StaffTrackedResult {
  userId: string;
  tracked: boolean;
  trackedSetting: boolean | null;
}

export interface StaffMonthDay {
  date: IsoDate;
  off: boolean;
  /** A holiday's name; a weekly off day has none. */
  holidayName?: { bn: string; en: string };
}

/** A stored day in the month's side panel and the per-day CSV. */
export interface StaffMonthDetail {
  date: IsoDate;
  status: StaffDayStatus;
  inAt: string | null;
  outAt: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  source: StaffDaySource;
  reason: string | null;
}

export interface StaffMonthPerson {
  userId: string;
  name: string;
  nameBn: string | null;
  roles: StaffRole[];
  /** One cell per entry of `days`, in order (`staffMonth`). */
  cells: StaffCell[];
  totals: StaffMonthTotals;
  details: StaffMonthDetail[];
}

/** GET /staff-attendance/month: tracked staff, and anyone with a stored day that month. */
export interface StaffMonthReport {
  month: string;
  days: StaffMonthDay[];
  people: StaffMonthPerson[];
}
