import type { IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';

// What the browser uses from institute setup, apart from setup.ts (its request schemas) so it
// never loads zod (see dates-schema.ts).

/** `years` later on the calendar (29 Feb → 28 Feb in a non-leap year). */
export function addYears(date: IsoDate, years: number): IsoDate {
  const y = Number(date.slice(0, 4)) + years;
  const rest = date.slice(4);
  // 29 Feb → 28 Feb in a non-leap year.
  if (rest === '-02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return `${y}-02-28`;
  return `${y}${rest}`;
}

/** The year after `year`: "2026" → "2027", "2025-2026" → "2026-2027", dates + 1 year. */
export function suggestNextYear(year: { name: string; startDate: IsoDate; endDate: IsoDate }): {
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
} {
  const name = toAsciiDigits(year.name.trim());
  const range = /^(\d{4})\s*([-–/])\s*(\d{2}|\d{4})$/.exec(name);
  let next: string;
  if (/^\d{4}$/.test(name)) next = String(Number(name) + 1);
  else if (range) {
    const [, a, sep, b] = range;
    const nb = String(Number(b) + 1).padStart(b!.length, '0');
    next = `${Number(a) + 1}${sep}${nb.slice(-b!.length)}`;
  } else next = `${year.name.trim()} (+1)`;
  return {
    name: next,
    startDate: addYears(year.startDate, 1),
    endDate: addYears(year.endDate, 1),
  };
}

/** The labels an institute can rename (CLAUDE.md: never institute-type checks in code). */
export const LABEL_KEYS = [
  'class_level',
  'section',
  'academic_year',
  'shift',
  'study_group',
  'student',
  'roll',
] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
