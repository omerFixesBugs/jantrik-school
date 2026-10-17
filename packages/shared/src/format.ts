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

/** A date (shown in Asia/Dhaka): "১৭ অক্টোবর ২০২৬" / "17 Oct 2026". */
export function formatDate(
  value: Date | string,
  locale: UiLocale,
  style: 'medium' | 'long' = 'medium',
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  }).format(new Date(value));
}

/** A time of day (Asia/Dhaka): "সকাল ৭:০০" / "07:00". */
export function formatTime(value: Date | string, locale: UiLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

/**
 * Identifiers (student code, roll, birth registration no., IDs): always ASCII, whatever the
 * UI language, and whatever digits the value was typed with.
 */
export function formatIdentifier(value: string | number): string {
  return toAsciiDigits(String(value));
}
