'use client';

import { LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useSetLocale } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/** bn ⇄ en. Saved in a cookie and, when signed in, on the user (users.locale). */
export function LanguageToggle({ onBrand }: { onBrand?: boolean }) {
  const locale = useLocale() as Locale;
  const t = useTranslations('common');
  const setLocale = useSetLocale();
  const [pending, startTransition] = useTransition();
  const next: Locale = locale === 'bn' ? 'en' : 'bn';
  // The accessible name is the visible text ("English" / "EN"), so a speech-input user can say
  // what they see (WCAG 2.5.3); "ভাষা / Language" is only the tooltip.
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'rounded-full px-2.5',
        onBrand &&
          'border-hero-foreground/30 bg-hero-foreground/10 text-hero-foreground hover:bg-hero-foreground/20 hover:text-hero-foreground',
      )}
      disabled={pending}
      title={t('language')}
      data-testid="language-toggle"
      onClick={() => startTransition(() => setLocale(next))}
    >
      <LanguagesIcon aria-hidden className={onBrand ? undefined : 'text-primary-ink'} />
      <span lang={next} className="hidden sm:inline">
        {next === 'en' ? t('switchToEnglish') : t('switchToBangla')}
      </span>
      <span lang={next} className="sm:hidden">
        {next === 'en' ? 'EN' : 'বাং'}
      </span>
    </Button>
  );
}
