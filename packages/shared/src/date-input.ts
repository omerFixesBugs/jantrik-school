import type { IsoDate } from './dates.js';
import { toAsciiDigits, toBanglaDigits } from './digits.js';

/**
 * The date field (docs/design.md → Layout): people type dates the way Bangladeshi forms write
 * them, day first, in Bangla or ASCII digits. ISO (YYYY-MM-DD) is accepted too (pasted values,
 * tests). Returns a real calendar date as ISO, or null.
 */
export function parseDateInput(text: string): IsoDate | null {
  const value = toAsciiDigits(text).trim();
  if (!value) return null;
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const dmy = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(value);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy) {
    [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  } else {
    return null;
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return null;
  const result = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${result}T00:00:00Z`);
  return check.getUTCDate() === day ? result : null;
}

/** ISO → DD/MM/YYYY, with Bangla digits in the Bangla UI. */
export function formatDateInput(date: IsoDate, locale: 'bn' | 'en'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date; // not ISO: show it as it is
  const [y, m, d] = date.split('-');
  const text = `${d}/${m}/${y}`;
  return locale === 'bn' ? toBanglaDigits(text) : text;
}
