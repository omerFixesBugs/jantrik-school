'use client';

import { formatCount, formatDate } from '@jantrik/shared';
import { ClipboardListIcon, PencilLineIcon, PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { CYCLE_TONE, useCycles } from '@/components/admission/admission-kit';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { displayName } from '@/lib/names';

/** Admission (OWNER/ADMIN): the cycles, each with its window, classes and counts. */
export default function AdmissionPage() {
  return (
    <PageGate page="admission">
      <Cycles />
    </PageGate>
  );
}

function Cycles() {
  const t = useTranslations('admissions.staff');
  const locale = useLocale() as Locale;
  const cycles = useCycles();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-prose">{t('subtitle')}</p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink variant="outline" href="/admission/applications">
            <ClipboardListIcon aria-hidden />
            {t('applicationsLink')}
          </ButtonLink>
          <ButtonLink variant="outline" href="/admission/applications/new">
            <PencilLineIcon aria-hidden />
            {t('enterApplication')}
          </ButtonLink>
          <ButtonLink href="/admission/cycles/new" data-testid="new-cycle">
            <PlusIcon aria-hidden />
            {t('newCycle')}
          </ButtonLink>
        </div>
      </div>

      {cycles.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (cycles.data ?? []).length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border p-6 text-center">
          {t('noCycles')}
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {(cycles.data ?? []).map((c) => {
            const total = Object.entries(c.counts)
              .filter(([s]) => s !== 'WITHDRAWN')
              .reduce((n, [, v]) => n + v, 0);
            return (
              <li
                key={c.id}
                className="bg-card rounded-card shadow-card flex flex-col gap-3 border p-(--panel-p)"
                data-testid="cycle-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <a
                      href={`/admission/cycles/${c.id}`}
                      className="text-base font-semibold break-words hover:underline"
                    >
                      {displayName(c.nameBn, c.nameEn, locale)}
                    </a>
                    <p className="text-muted-foreground text-sm">
                      {t('forYear', { year: c.academicYear.name })} ·{' '}
                      {t('window', {
                        opens: formatDate(c.opensAt, locale),
                        closes: formatDate(c.closesAt, locale),
                      })}
                    </p>
                  </div>
                  <Pill tone={CYCLE_TONE[c.status]}>{t(`status.${c.status}`)}</Pill>
                </div>
                <p className="text-sm">
                  {c.takingApplications ? t('takingNow') : t('notTakingNow')}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('counts', {
                    total,
                    admitted: formatCount(c.counts.ADMITTED, locale),
                  })}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {c.classes.map((cc) => (
                    <li key={cc.id}>
                      <a
                        href={`/admission/applications?cycleId=${c.id}&cycleClassId=${cc.id}`}
                        className="bg-muted hover:bg-accent inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm"
                      >
                        {displayName(cc.classLevel.nameBn, cc.classLevel.nameEn, locale)}
                        {cc.studyGroup &&
                          ` · ${displayName(cc.studyGroup.nameBn, cc.studyGroup.nameEn, locale)}`}
                        <span className="text-muted-foreground">
                          {cc.seats
                            ? t('seatsOf', {
                                applications: formatCount(cc.applications, locale),
                                seats: formatCount(cc.seats, locale),
                              })
                            : t('seatsOpen', {
                                applications: formatCount(cc.applications, locale),
                              })}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
