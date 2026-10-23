'use client';

import { formatIdentifier, toAsciiDigits, type FeeStudentHit } from '@jantrik/shared';
import { CheckIcon, SearchIcon, SearchXIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Pill } from '@/components/kit/pill';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { pick } from '@/lib/fees';
import { useDebounced } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useFeeQuery } from './kit';

/** A student's class, section and roll in one line (the roll stays ASCII: an identifier). */
export function useStudentPlace() {
  const t = useTranslations('fees.setup.picker');
  const locale = useLocale() as Locale;
  return (hit: Pick<FeeStudentHit, 'enrolment'>): string => {
    const e = hit.enrolment;
    if (!e) return t('notEnrolled');
    return [
      pick(locale, e.classLevel),
      e.section?.name,
      e.roll !== null ? t('roll', { roll: formatIdentifier(e.roll) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
}

/**
 * Find a student by name, ID, roll or guardian phone (GET /fees/students). Bangla digits are
 * accepted and sent as ASCII. `chosen` marks the picked ones (several when building a family).
 */
export function StudentPicker({
  id,
  label,
  chosen = [],
  onPick,
  testId = 'fee-student-search',
}: {
  id: string;
  label: string;
  chosen?: string[];
  onPick: (hit: FeeStudentHit) => void;
  testId?: string;
}) {
  const t = useTranslations('fees.setup.picker');
  const tStatus = useTranslations('studentStatus');
  const locale = useLocale() as Locale;
  const place = useStudentPlace();
  const [q, setQ] = useState('');
  const query = toAsciiDigits(useDebounced(q.trim(), 300));
  const hits = useFeeQuery<FeeStudentHit[]>(
    query.length >= 2 ? `/fees/students?q=${encodeURIComponent(query)}` : null,
  );
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4"
        />
        <Input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('placeholder')}
          autoComplete="off"
          className="ps-9"
          aria-describedby={`${id}-hint`}
          data-testid={testId}
        />
      </div>
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {t('hint')}
      </p>
      {query.length >= 2 &&
        (hits.isPending ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : hits.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t('error')}
          </p>
        ) : hits.data.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <SearchXIcon aria-hidden className="size-4" />
            {t('none')}
          </p>
        ) : (
          <ul
            className="flex flex-col gap-1.5"
            aria-label={t('results')}
            data-testid="fee-student-results"
          >
            {hits.data.map((hit) => {
              const picked = chosen.includes(hit.id);
              return (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => onPick(hit)}
                    aria-pressed={picked}
                    className={cn(
                      'flex min-h-(--control-h) w-full items-center gap-3 rounded-xl border px-3 py-2 text-start transition-colors',
                      'focus-visible:ring-ring outline-none focus-visible:ring-2',
                      picked ? 'border-primary-ink bg-primary-soft' : 'bg-card hover:bg-muted',
                    )}
                    data-testid="fee-student-hit"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium wrap-break-word">
                        {pick(locale, hit) || formatIdentifier(hit.studentCode)}
                      </span>
                      <span className="text-muted-foreground text-sm">
                        <span dir="ltr">{formatIdentifier(hit.studentCode)}</span> · {place(hit)}
                      </span>
                    </span>
                    {hit.status !== 'ACTIVE' && <Pill tone="warning">{tStatus(hit.status)}</Pill>}
                    {picked && (
                      <CheckIcon aria-hidden className="text-primary-ink size-5 shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
