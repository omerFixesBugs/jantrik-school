import type { IsoDate } from '@jantrik/shared';
import { dateToDb } from '@jantrik/shared';

/**
 * Who is on a section's register for `date` (P5-C, review SF4): every student not deactivated
 * who has not left by then. A leaver (a leaving date, P5) stays on the days before they left, so
 * past registers keep them, and is gone from that day on. A student not ACTIVE without a date
 * (set before P5) stays on as before: written absent, never sent an SMS.
 */
export function onRegisterOn(date: IsoDate) {
  return {
    deletedAt: null,
    OR: [{ leftOn: null }, { leftOn: { gt: dateToDb(date) } }],
  };
}
