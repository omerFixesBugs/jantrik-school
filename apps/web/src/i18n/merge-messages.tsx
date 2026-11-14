'use client';

import { NextIntlClientProvider, useLocale, useMessages, useTimeZone } from 'next-intl';
import { useMemo, type ReactNode } from 'react';
import { mergeMessages } from './route-messages';

/**
 * Adds a route's messages to the ones its layouts already sent (route-messages.ts), in the
 * browser, so the shell's texts are not sent again with every area.
 */
export function MergeMessages({
  messages,
  children,
}: {
  messages: Record<string, unknown>;
  children: ReactNode;
}) {
  const parent = useMessages();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const merged = useMemo(() => mergeMessages(parent, messages), [parent, messages]);
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={merged}>
      {children}
    </NextIntlClientProvider>
  );
}
