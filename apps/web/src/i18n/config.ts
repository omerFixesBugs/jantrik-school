export const locales = ['bn', 'en'] as const;
export type Locale = (typeof locales)[number];

// Locale selection (user preference / tenant default) comes later; for now everyone gets Bangla.
export const defaultLocale: Locale = 'bn';

// Dates are stored in UTC and always displayed in Bangladesh time.
export const timeZone = 'Asia/Dhaka';
