import { toAsciiDigits, toBanglaDigits } from '@jantrik/shared';
import type { Locale } from '@/i18n/config';

/*
 * Times of day and whole numbers as people type them (Bangla or ASCII digits), for the settings
 * and the staff entry dialog. The API takes "HH:MM" and whole numbers in either digits; these
 * only tidy what is typed, the API stays the judge.
 */

/**
 * A typed time as the API takes it: "HH:MM", ASCII digits ("৮:০৫" → "08:05", "9.30" → "09:30").
 * Text that is not a time comes back trimmed, for the API to refuse on its field.
 */
export function normalizeTime(raw: string): string {
  const ascii = toAsciiDigits(raw).trim();
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(ascii);
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : ascii;
}

/** Whether it is a time of day (00:00–23:59) once tidied. */
export const isTime = (raw: string): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(normalizeTime(raw));

/** A whole number typed with either digits, or null. */
export function wholeNumber(raw: string): number | null {
  const ascii = toAsciiDigits(raw).trim();
  return /^\d{1,10}$/.test(ascii) ? Number(ascii) : null;
}

/** A stored number or time as an input shows it: Bangla digits in the Bangla UI. */
export const inputDigits = (value: string | number, locale: Locale): string =>
  locale === 'bn' ? toBanglaDigits(String(value)) : String(value);
