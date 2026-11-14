import type { NonWorkingDay, PersonRef } from './attendance.js';
import type { IsoDate } from './dates.js';
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
