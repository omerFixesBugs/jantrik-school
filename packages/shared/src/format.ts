/**
 * Digit display rule (see CLAUDE.md "Conventions"):
 *
 * - **Bangla digits in the bn UI** for quantities: dates, times, counts, amounts, percentages.
 * - **ASCII digits always** for identifiers people copy into other apps: phone numbers,
 *   student codes, roll numbers, birth registration numbers, any ID.
 *
 * Use these formatters instead of calling Intl / toLocaleString directly.
 */
import { toAsciiDigits } from './digits.js';

export type UiLocale = 'bn' | 'en';

const TIME_ZONE = 'Asia/Dhaka';

/** Intl locale for quantities. `bn-BD` produces Bangla digits. */
const intlLocale = (locale: UiLocale) => (locale === 'bn' ? 'bn-BD' : 'en-GB');

/** Counts and plain numbers: ১২৩ / 123. */
export function formatCount(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

/** Money stored as integer paisa → "৳১,২৫০.৫০" / "৳1,250.50". */
export function formatTaka(paisa: number, locale: UiLocale): string {
  const formatted = new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: paisa % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paisa / 100);
  return `৳${formatted}`;
}

/**
 * A date (shown in Asia/Dhaka): "১৭ অক্টোবর ২০২৬" / "17 Oct 2026".
 * `full` adds the weekday: "শনিবার, ১৭ অক্টোবর, ২০২৬" / "Saturday 17 October 2026".
 */
export function formatDate(
  value: Date | string,
  locale: UiLocale,
  style: 'medium' | 'long' | 'full' = 'medium',
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: TIME_ZONE,
    ...(style === 'full' ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: style === 'medium' ? 'short' : 'long',
    year: 'numeric',
  }).format(new Date(value));
}

/** Hour of the day (0–23) in Asia/Dhaka, e.g. for "Good morning". */
export function dhakaHour(value: Date | string = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date(value));
  return Number(hour);
}

export type DayPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

/**
 * Part of the day for greetings, from an hour 0–23 (use `dhakaHour`): morning 05:00–11:59,
 * afternoon 12:00–16:59, evening 17:00–20:59, night 21:00–04:59 ("শুভ রাত্রি").
 */
export function dayPeriod(hour: number): DayPeriod {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const BANGLA_MONTHS = {
  bn: [
    'বৈশাখ',
    'জ্যৈষ্ঠ',
    'আষাঢ়',
    'শ্রাবণ',
    'ভাদ্র',
    'আশ্বিন',
    'কার্তিক',
    'অগ্রহায়ণ',
    'পৌষ',
    'মাঘ',
    'ফাল্গুন',
    'চৈত্র',
  ],
  en: [
    'Boishakh',
    'Jyoishtho',
    'Asharh',
    'Srabon',
    'Bhadro',
    'Ashshin',
    'Kartik',
    'Ogrohayon',
    'Poush',
    'Magh',
    'Falgun',
    'Choitro',
  ],
} as const;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Day, month (0-based) and year in the Bangladesh national calendar (বঙ্গাব্দ, 2019 revision):
 * 1 Boishakh = 14 April; Boishakh–Ashshin have 31 days, Falgun 29 (30 when that February is a
 * leap February), the rest 30. So 16 December is always 1 Poush and 21 February 8 Falgun.
 */
export function banglaCalendarDate(value: Date | string): {
  day: number;
  month: number;
  year: number;
} {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE })
    .format(new Date(value))
    .split('-')
    .map(Number) as [number, number, number];
  const today = Date.UTC(y, m - 1, d);
  const startYear = today >= Date.UTC(y, 3, 14) ? y : y - 1;
  let offset = Math.round((today - Date.UTC(startYear, 3, 14)) / 86_400_000);
  const lengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, isLeap(startYear + 1) ? 30 : 29, 30];
  let month = 0;
  while (offset >= lengths[month]!) offset -= lengths[month++]!;
  return { day: offset + 1, month, year: startYear - 593 };
}

/** "১ কার্তিক ১৪৩৩" / "1 Kartik 1433" (বঙ্গাব্দ). */
export function formatBanglaCalendarDate(value: Date | string, locale: UiLocale): string {
  const { day, month, year } = banglaCalendarDate(value);
  return `${formatCount(day, locale)} ${BANGLA_MONTHS[locale][month]} ${new Intl.NumberFormat(
    intlLocale(locale),
    { useGrouping: false },
  ).format(year)}`;
}

/**
 * A time of day (Asia/Dhaka): "দুপুর ২:১৫" / "14:15". Bangla puts the part of the day (ভোর,
 * সকাল, দুপুর, বিকেল, সন্ধ্যা, রাত্রি) first, as people say it, instead of a Latin "PM".
 */
export function formatTime(value: Date | string, locale: UiLocale): string {
  const date = new Date(value);
  if (locale === 'en') {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }
  const parts = new Intl.DateTimeFormat('bn-BD', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    dayPeriod: 'short',
  }).formatToParts(date);
  const period = parts.find((p) => p.type === 'dayPeriod')?.value;
  const time = parts
    .filter(
      (p) => p.type === 'hour' || p.type === 'minute' || (p.type === 'literal' && p.value === ':'),
    )
    .map((p) => p.value)
    .join('');
  return period ? `${period} ${time}` : time;
}

/**
 * Identifiers (student code, roll, birth registration no., IDs): always ASCII, whatever the
 * UI language, and whatever digits the value was typed with.
 */
export function formatIdentifier(value: string | number): string {
  return toAsciiDigits(String(value));
}
