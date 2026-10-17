import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, timeZone } from './config';

export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    timeZone,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
