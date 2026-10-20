'use client';

import { percentRampStep, type SectionRef } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Locale } from '@/i18n/config';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/*
 * The section board (docs/design.md → Brand): today's attendance as a class × section chart, like
 * the বর্ণমালা chart, on a small blackboard. Every tile shows its percentage as text and opens
 * that section's register; tiles not taken yet are dashed; the lowest is ringed in chalk pink.
 * Colour is the one fixed ramp (percentRampStep), so 90 % looks the same on every screen.
 */

export interface BoardSection {
  section: SectionRef;
  /** Present % with the institute's leave rule; null when the register is not taken yet. */
  percent: number | null;
  /** The percentage as the reader should see it ("৯৬%"). */
  display: string;
}

const RAMP_TEXT: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'bg-ramp-1 text-white',
  2: 'bg-ramp-2 text-white',
  3: 'bg-ramp-3 text-foreground',
  4: 'bg-ramp-4 text-foreground',
  5: 'bg-ramp-5 text-foreground',
};

export function SectionBoard({
  sections,
  href,
  legend,
  className,
}: {
  sections: readonly BoardSection[];
  /** Where a tile goes (the register, or taking attendance for a section not taken yet). */
  href: (s: BoardSection) => string;
  /** The ramp's ranges as text, already formatted ("৮৫–৮৭"). */
  legend: readonly string[];
  className?: string;
}) {
  const t = useTranslations('board');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const classLevelName = (c: SectionRef['classLevel']) => displayName(c.nameBn, c.nameEn, locale);
  // Rows in the order the API gives (class order), sections in their order within each class.
  const rows: { classLevel: SectionRef['classLevel']; items: BoardSection[] }[] = [];
  for (const s of sections) {
    const row = rows.find((r) => r.classLevel.id === s.section.classLevel.id);
    if (row) row.items.push(s);
    else rows.push({ classLevel: s.section.classLevel, items: [s] });
  }
  const taken = sections.filter((s) => s.percent !== null);
  const lowest =
    taken.length > 1 ? taken.reduce((a, b) => (b.percent! < a.percent! ? b : a)).section.id : null;

  return (
    <div
      className={cn(
        'bg-board text-board-foreground flex flex-col gap-3 rounded-lg p-(--panel-p)',
        className,
      )}
    >
      <ol
        className="flex flex-col gap-2"
        aria-label={t('label', { section: label('section', 'Section', { inText: true }) })}
      >
        {rows.map((row) => (
          <li
            key={row.classLevel.id}
            className="grid grid-cols-[minmax(4.5rem,7rem)_1fr] items-stretch gap-2"
          >
            <span className="flex items-center text-sm font-semibold text-white">
              {classLevelName(row.classLevel)}
            </span>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
              {row.items.map((s) => {
                const isLowest = s.section.id === lowest;
                const step = s.percent === null ? null : percentRampStep(s.percent);
                return (
                  <li key={s.section.id}>
                    <Link
                      href={href(s)}
                      data-testid="board-section"
                      className={cn(
                        'focus-visible:ring-chalk-yellow focus-visible:ring-offset-board flex min-h-16 flex-col justify-between rounded-md px-2.5 py-2 transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-offset-2',
                        step === null
                          ? 'border-board-muted/70 text-board-foreground border border-dashed'
                          : RAMP_TEXT[step],
                        isLowest && 'ring-chalk-pink ring-offset-board ring-2 ring-offset-2',
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-heading truncate text-lg leading-none">
                          {s.section.name}
                        </span>
                        {isLowest && (
                          <span className="bg-chalk-pink text-foreground rounded-full px-1.5 text-xs leading-5">
                            {t('lowest')}
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          'font-numeric text-xl leading-tight font-semibold',
                          step === null && 'text-sm font-normal',
                        )}
                      >
                        {s.percent === null ? t('notTaken') : s.display}
                      </span>
                      <span className="sr-only">
                        {classLevelName(row.classLevel)}, {s.section.name}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      <div
        className="text-board-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        aria-hidden
      >
        <span>{t('legend')}</span>
        {legend.map((range, i) => (
          <span
            key={range}
            className={cn('rounded px-1.5 leading-5', RAMP_TEXT[(i + 1) as 1 | 2 | 3 | 4 | 5])}
          >
            {range}
          </span>
        ))}
        <span className="border-board-muted/70 rounded border border-dashed px-1.5 leading-5">
          {t('notTaken')}
        </span>
      </div>
    </div>
  );
}
