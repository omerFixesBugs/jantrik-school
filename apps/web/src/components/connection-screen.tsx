'use client';

import { formatCount } from '@jantrik/shared';
import { RefreshCwIcon, WifiOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { countAllDrafts } from '@/lib/attendance/drafts';

/**
 * Shown when the API can't be reached while the app starts. Nobody is signed out; the caller
 * keeps retrying. Unsent attendance on the phone is shown as a number only: without a session
 * we don't know whose drafts they are.
 */
export function ConnectionScreen({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('connection');
  const locale = useLocale() as Locale;
  const [drafts] = useState(() => countAllDrafts());

  // Keep trying on our own: every 10 s and as soon as the browser is back online.
  useEffect(() => {
    const timer = setInterval(onRetry, 10_000);
    window.addEventListener('online', onRetry);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onRetry);
    };
  }, [onRetry]);

  return (
    <main
      className="bg-canvas flex min-h-svh flex-1 flex-col"
      data-testid="connection-screen"
      aria-live="polite"
    >
      <div className="bg-linear-to-br from-hero-from to-hero-to text-hero-foreground flex items-center px-4 py-3 sm:px-8">
        <Logo inverted />
      </div>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <span className="bg-warning-soft text-warning flex size-16 items-center justify-center rounded-2xl">
          <WifiOffIcon aria-hidden className="size-8" />
        </span>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('body')}</p>
        {drafts > 0 && (
          <p
            className="bg-card w-full rounded-xl border px-4 py-3 text-left text-sm"
            data-testid="connection-drafts"
          >
            {t('drafts', { count: formatCount(drafts, locale) })}
          </p>
        )}
        <Button size="lg" className="mt-2 w-full" onClick={onRetry}>
          <RefreshCwIcon aria-hidden />
          {t('retry')}
        </Button>
        <Link
          href="/login"
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          {t('login')}
        </Link>
      </div>
    </main>
  );
}
