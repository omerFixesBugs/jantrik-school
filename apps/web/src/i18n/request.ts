import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, LOCALE_COOKIE, timeZone } from './config';
import { loadMessages } from './load-messages';

// Server components read every message; the browser gets each route's part (route-messages.ts).
export default getRequestConfig(async () => {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(fromCookie) ? fromCookie : defaultLocale;
  return { locale, timeZone, messages: await loadMessages(locale) };
});
