'use client';

import { formatCount, type AttendanceCounts } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { STATUS_TONE } from '@/components/attendance/attendance-tabs';
import type { Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';

const ORDER = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'] as const;
const KEY = { PRESENT: 'present', ABSENT: 'absent', LATE: 'late', LEAVE: 'leave' } as const;

/** Four small chips: উপস্থিত ২৫, অনুপস্থিত ২ … */
export function CountChips({ counts }: { counts: AttendanceCounts }) {
  const t = useTranslations('attendance');
  const locale = useLocale() as Locale;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ORDER.map((s) => (
        <li
          key={s}
          className={cn(
            'inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-sm font-medium',
            STATUS_TONE[s],
          )}
        >
          {t(`status${s}`)}{' '}
          <span className="font-numeric">{formatCount(counts[KEY[s]], locale)}</span>
        </li>
      ))}
    </ul>
  );
}
