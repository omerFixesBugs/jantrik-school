export const locales = ['bn', 'en'] as const;
export type Locale = (typeof locales)[number];

/** Bangla unless the user (or the login page toggle) chose English. */
export const defaultLocale: Locale = 'bn';

/** Cookie holding the UI language; set by the language toggle and after login (users.locale). */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

// Dates are stored in UTC and always displayed in Bangladesh time.
export const timeZone = 'Asia/Dhaka';

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (locales as readonly string[]).includes(value);
