'use client';

import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Root error boundary: a render error anywhere below the root layout shows this (in Bangla or
 * English) instead of a blank or frozen page. Errors in the root layout itself go to
 * global-error.tsx.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errorPage');
  useEffect(() => {
    console.error('[jantrik] render error', error);
  }, [error]);
  return (
    <main
      className="bg-canvas flex min-h-svh flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"
      role="alert"
      data-testid="error-page"
    >
      <span className="bg-destructive-soft text-destructive flex size-16 items-center justify-center rounded-2xl">
        <TriangleAlertIcon aria-hidden className="size-8" />
      </span>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground max-w-md">{t('body')}</p>
      <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row">
        <Button size="lg" className="flex-1" onClick={reset}>
          <RotateCcwIcon aria-hidden />
          {t('retry')}
        </Button>
        <Button size="lg" variant="outline" className="flex-1" onClick={() => location.reload()}>
          {t('reload')}
        </Button>
      </div>
      {error.digest && (
        <p className="text-muted-foreground text-xs">{t('code', { code: error.digest })}</p>
      )}
    </main>
  );
}
