import { z } from 'zod';
import { isoDateSchema } from './dates-schema.js';
import { monthSchema } from './reports.js';
import { timeOfDaySchema } from './setup.js';
import { STAFF_DAY_STATUSES, STAFF_REASON_MAX, STAFF_REASON_MIN } from './staff-attendance-api.js';

// The staff attendance API's request schemas, apart from staff-attendance-api.ts so the browser
// can use its values and types without loading zod (see dates-schema.ts).

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
