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

const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    clockFormats.set(timeZone, format);
  }
  return format;
}

function clockParts(timeZone: string, at: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of clockFormat(timeZone).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** The zone's offset from UTC at an instant, in minutes (Dhaka 360, Kolkata 330). */
export function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const p = clockParts(timeZone, at);
  const local = Date.UTC(
    p['year']!,
    p['month']! - 1,
    p['day']!,
    p['hour']!,
    p['minute']!,
    p['second']!,
  );
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * A wall-clock `YYYY-MM-DD HH:MM:SS` read in a timezone, as the real instant. Devices send local
 * time with no zone. Around a DST change a time that happens twice takes the first, one that
 * never happens is moved forward.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(wallClock);
  if (!m) throw new Error(`Not a wall-clock time: "${wallClock}"`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc - timeZoneOffsetMinutes(timeZone, new Date(asUtc)) * 60000;
  const second = asUtc - timeZoneOffsetMinutes(timeZone, new Date(guess)) * 60000;
  if (second !== guess) {
    // the offset changed between the two guesses: take the earlier valid reading
    const other = asUtc - timeZoneOffsetMinutes(timeZone, new Date(second)) * 60000;
    guess = other === second ? Math.min(guess, second) : Math.max(guess, second);
  }
  return new Date(guess);
}

/** The calendar date of an instant in a timezone. */
export function localDateOf(instant: Date, timeZone: string): IsoDate {
  return todayIn(timeZone, instant);
}

/** The wall-clock time of an instant in a timezone, `HH:MM:SS`. */
export function localTimeOf(instant: Date, timeZone: string): string {
  const p = clockParts(timeZone, instant);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(p['hour']!)}:${two(p['minute']!)}:${two(p['second']!)}`;
}
