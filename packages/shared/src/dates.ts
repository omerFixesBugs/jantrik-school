import { z } from 'zod';

/**
 * Calendar dates as `YYYY-MM-DD` strings. "Today" always comes from the server in the tenant's
 * timezone (tenants.timezone): phones often have the wrong date, so clients never compute it.
 */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date (rejects 2026-02-30). */
export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'Expected YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a calendar date');

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Tests only: `JANTRIK_TEST_TODAY=YYYY-MM-DD` fixes "today" in a Node process (the end-to-end
 * suite runs on one known working day, so no test depends on the real date). Never in production
 * or a browser; the API also refuses to start with it unless NODE_ENV=test.
 */
function fixedToday(): IsoDate | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.['JANTRIK_TEST_TODAY'];
  if (!value || env['NODE_ENV'] === 'production') return null;
  if (!isoDateSchema.safeParse(value).success) {
    throw new Error(`JANTRIK_TEST_TODAY must be a calendar date (YYYY-MM-DD), not "${value}"`);
  }
  return value;
}

/**
 * Today's date in a timezone, e.g. `todayIn('Asia/Dhaka')` → '2026-10-18'; or any instant's date
 * there. One formatter per timezone, kept (building one costs far more than formatting).
 */
export function todayIn(timeZone: string, now?: Date): IsoDate {
  if (!now) {
    const fixed = fixedToday();
    if (fixed) return fixed;
  }
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone });
    dayFormats.set(timeZone, format);
  }
  return format.format(now ?? new Date());
}

/** ISO weekday of a date: 1 = Monday … 7 = Sunday (Friday = 5). */
export function isoWeekday(date: IsoDate): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** `date` moved by `days` (may be negative). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A `@db.Date` value for Prisma (midnight UTC of that calendar date). */
export const dateToDb = (date: IsoDate): Date => new Date(`${date}T00:00:00Z`);

/** A `@db.Date` value from Prisma back to `YYYY-MM-DD`. */
export const dateFromDb = (value: Date): IsoDate => value.toISOString().slice(0, 10);
