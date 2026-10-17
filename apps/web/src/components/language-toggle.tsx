'use client';

import { LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useSetLocale } from '@/lib/hooks';

/** bn ⇄ en. Saved in a cookie and, when signed in, on the user (users.locale). */
export function LanguageToggle() {
  const locale = useLocale() as Locale;
  const t = useTranslations('common');
  const setLocale = useSetLocale();
  const [pending, startTransition] = useTransition();
  const next: Locale = locale === 'bn' ? 'en' : 'bn';
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={t('language')}
      data-testid="language-toggle"
      onClick={() => startTransition(() => setLocale(next))}
    >
      <LanguagesIcon aria-hidden />
      <span lang={next}>{next === 'en' ? t('switchToEnglish') : t('switchToBangla')}</span>
    </Button>
  );
}
