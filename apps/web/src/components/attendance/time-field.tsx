'use client';

import { formatWallClock } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Field } from '@/components/form-kit';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { isTime, normalizeTime } from '@/lib/attendance/time-input';
import { cn } from '@/lib/utils';

/**
 * A time of day on the 24-hour clock, typed with Bangla or ASCII digits ("৯.৩০" reads 09:30). It
 * reads the time back in words ("মানে সকাল ৯:৩০"), so a typed 4:05 is not taken for the afternoon
 * unseen. The value stays as typed; `normalizeTime` tidies it for the API.
 */
export function TimeField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
}) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const reading = isTime(value)
    ? t('timeReading', { time: formatWallClock(normalizeTime(value), locale) })
    : t('timeHint');
  return (
    <Field
      id={id}
      label={label}
      hint={hint ? `${reading} · ${hint}` : reading}
      error={error}
      required={required}
      className={className}
    >
      <Input
        id={id}
        // Digits and a separator on phone keyboards.
        inputMode="decimal"
        autoComplete="off"
        placeholder={locale === 'bn' ? '০৮:০০' : '08:00'}
        className={cn('font-numeric w-full sm:max-w-40')}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      />
    </Field>
  );
}
