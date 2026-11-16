import type { IsoDate } from '@jantrik/shared';
import { dateToDb } from '@jantrik/shared';

/**
 * Who is on a section's register for `date` (P5-C, review SF4): every student not deactivated
 * who has not left by then. `left_on` is the last day a leaver is on the register (review
 * round 2: a graduate leaving on the old year's last day is still marked that day); from the day
 * after they are gone, and past registers keep them. A student not ACTIVE without a date (set
 * before P5) stays on as before: written absent, never sent an SMS.
 */
export function onRegisterOn(date: IsoDate) {
  return {
    deletedAt: null,
    OR: [{ leftOn: null }, { leftOn: { gte: dateToDb(date) } }],
  };
}
