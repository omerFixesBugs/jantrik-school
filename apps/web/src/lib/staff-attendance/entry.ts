import {
  localTimeOf,
  STAFF_REASON_MAX,
  STAFF_REASON_MIN,
  type StaffDayEntryInput,
  type StaffDayRecord,
  type StaffDayStatus,
} from '@jantrik/shared';
import type { Locale } from '@/i18n/config';
import { inputDigits, isTime, normalizeTime } from '@/lib/attendance/time-input';

/*
 * The "enter manually" dialog's rules: what it starts from, what it checks before sending (the
 * API checks the same and answers with codes), and the body it sends.
 */

const TIME_ZONE = 'Asia/Dhaka';

export interface EntryForm {
  status: StaffDayStatus;
  /** As typed ("০৯:১৫"); only a present day keeps times. */
  inAt: string;
  outAt: string;
  reason: string;
}

export type EntryProblem =
  'IN_REQUIRED' | 'TIME_INVALID' | 'OUT_BEFORE_IN' | 'REASON_SHORT' | 'REASON_LONG';

/** The reason's length as the database counts it: characters (code points), trimmed. */
export const reasonLength = (reason: string): number => [...reason.trim()].length;

export function entryProblems(
  f: EntryForm,
): Partial<Record<'inAt' | 'outAt' | 'reason', EntryProblem>> {
  const out: Partial<Record<'inAt' | 'outAt' | 'reason', EntryProblem>> = {};
  if (f.status === 'PRESENT') {
    if (!f.inAt.trim()) out.inAt = 'IN_REQUIRED';
    else if (!isTime(f.inAt)) out.inAt = 'TIME_INVALID';
    if (f.outAt.trim()) {
      if (!isTime(f.outAt)) out.outAt = 'TIME_INVALID';
      else if (!out.inAt && normalizeTime(f.outAt) < normalizeTime(f.inAt)) {
        out.outAt = 'OUT_BEFORE_IN';
      }
    }
  }
  const length = reasonLength(f.reason);
  if (length < STAFF_REASON_MIN) out.reason = 'REASON_SHORT';
  else if (length > STAFF_REASON_MAX) out.reason = 'REASON_LONG';
  return out;
}

/** PUT /staff-attendance/:userId/:date, based on the version the admin saw (0: no row). */
export function entryBody(f: EntryForm, baseVersion: number): StaffDayEntryInput {
  const present = f.status === 'PRESENT';
  return {
    status: f.status,
    inAt: present ? normalizeTime(f.inAt) : null,
    outAt: present && f.outAt.trim() ? normalizeTime(f.outAt) : null,
    reason: f.reason.trim(),
    baseVersion,
  };
}

/** The dialog starts from the stored day (its local times, a manual day's reason), else empty. */
export function entryForm(day: StaffDayRecord | null, locale: Locale): EntryForm {
  const time = (iso: string | null) =>
    iso ? inputDigits(localTimeOf(new Date(iso), TIME_ZONE).slice(0, 5), locale) : '';
  if (!day) return { status: 'PRESENT', inAt: '', outAt: '', reason: '' };
  return {
    status: day.status,
    inAt: time(day.inAt),
    outAt: time(day.outAt),
    reason: day.source === 'MANUAL' ? (day.reason ?? '') : '',
  };
}
