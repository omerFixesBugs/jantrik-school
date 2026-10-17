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
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'h-9 rounded-full px-3',
        onBrand &&
          'border-white/30 bg-white/10 text-white shadow-none hover:bg-white/20 hover:text-white',
      )}
      disabled={pending}
      aria-label={t('language')}
      data-testid="language-toggle"
      onClick={() => startTransition(() => setLocale(next))}
    >
      <LanguagesIcon aria-hidden className={onBrand ? undefined : 'text-primary'} />
      <span lang={next} className="hidden sm:inline">
        {next === 'en' ? t('switchToEnglish') : t('switchToBangla')}
      </span>
      <span lang={next} aria-hidden className="sm:hidden">
        {next === 'en' ? 'EN' : 'বাং'}
      </span>
    </Button>
  );
}
