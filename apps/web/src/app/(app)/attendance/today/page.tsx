'use client';

import { useQuery } from '@tanstack/react-query';
import {
  dateToDb,
  formatCount,
  formatDate,
  formatIdentifier,
  formatTime,
  type AttendanceTodayReport,
} from '@jantrik/shared';
import { CalendarOffIcon, CheckIcon, ChevronRightIcon, PhoneIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AttendanceTabs } from '@/components/attendance/attendance-tabs';
import { CountChips } from '@/components/attendance/count-chips';
import { registerHref } from '@/components/attendance/section-picker';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName, displayUserName } from '@/lib/names';

export default function AttendanceTodayPage() {
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="today" />
        <TodayReport />
      </div>
    </PageGate>
  );
}

function TodayReport() {
  const t = useTranslations('reports');
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const section = label('section', 'Section', { inText: true });

  const report = useQuery({
    queryKey: ['attendance-report-today', session?.tenant?.id],
    queryFn: () => client.api<AttendanceTodayReport>('/attendance/reports/today'),
  });

  if (report.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={tCommon('loading')}>
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }
  if (report.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          {describe(report.error)}
          <Button size="sm" variant="outline" onClick={() => void report.refetch()}>
            {tCommon('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const r = report.data;
  return (
    <div className="flex flex-col gap-5" data-testid="today-report">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold sm:text-2xl">{t('todayTitle')}</h2>
        <p className="text-muted-foreground">{formatDate(dateToDb(r.today), locale, 'full')}</p>
      </div>

      {r.nonWorkingDay && (
        <Alert>
          <CalendarOffIcon aria-hidden />
          <AlertDescription>
            {r.nonWorkingDay.reason === 'HOLIDAY'
              ? tAtt('holiday', {
                  name: locale === 'bn' ? r.nonWorkingDay.nameBn : r.nonWorkingDay.nameEn,
                })
              : tAtt('offDay')}
          </AlertDescription>
        </Alert>
      )}

      <section className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-medium">
            {t('totalsTaken', {
              taken: formatCount(r.totals.sectionsTaken, locale),
              total: formatCount(r.totals.sectionsTotal, locale),
              section,
            })}
          </p>
          {r.totals.percent !== null && (
            <p className="font-numeric text-primary text-2xl font-semibold">
              {t('percentPresent', { percent: formatCount(Math.round(r.totals.percent), locale) })}
            </p>
          )}
        </div>
        <CountChips counts={r.totals.counts} />
      </section>

      {r.sections.length === 0 ? (
        <p className="text-muted-foreground">{tAtt('noSections', { section })}</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {r.sections.map(({ section: s, studentCount, register }) => (
            <li
              key={s.id}
              className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs"
              data-testid="today-section"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <h3 className="font-heading text-lg font-semibold break-words">
                    {displayName(s.classLevel.nameBn, s.classLevel.nameEn, locale)}, {s.name}
                  </h3>
                  <span className="text-muted-foreground text-sm">
                    {tAtt('students', { count: formatCount(studentCount, locale) })}
                  </span>
                </div>
                {register?.percent != null && (
                  <span className="font-numeric text-xl font-semibold">
                    {formatCount(Math.round(register.percent), locale)}%
                  </span>
                )}
              </div>
              {register ? (
                <>
                  <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                    <CheckIcon aria-hidden className="text-success size-4 shrink-0" />
                    <span className="min-w-0">
                      {t('takenBy', {
                        name: displayUserName(register.updatedBy, locale),
                        time: formatTime(register.submittedAt, locale).replace(' ', ' '),
                      })}
                    </span>
                  </p>
                  <CountChips counts={register.counts} />
                  {register.absent.length === 0 ? (
                    <p className="text-success text-sm font-medium">{t('noneAbsent')}</p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <h4 className="text-sm font-medium">{t('absentTitle')}</h4>
                      <ul className="flex flex-col divide-y rounded-lg border">
                        {register.absent.map((st) => {
                          const name = displayName(st.nameBn, st.nameEn, locale);
                          return (
                            <li key={st.id} className="flex items-center" data-testid="absent-row">
                              <Link
                                href={`/attendance/students/${st.id}`}
                                aria-label={t('openStudent', { name })}
                                className="hover:bg-muted/60 flex min-h-11 min-w-0 flex-1 items-center gap-3 px-3 py-1.5"
                              >
                                <span className="text-muted-foreground w-8 shrink-0 text-sm tabular-nums">
                                  {st.roll != null ? formatIdentifier(st.roll) : '—'}
                                </span>
                                <span className="min-w-0 flex-1 break-words">{name}</span>
                                <ChevronRightIcon
                                  aria-hidden
                                  className="text-muted-foreground size-4 shrink-0"
                                />
                              </Link>
                              {/* Only for admins and this section's teachers (the API decides). */}
                              {st.guardianPhone && (
                                <a
                                  href={`tel:${st.guardianPhone}`}
                                  className={buttonVariants({
                                    variant: 'ghost',
                                    size: 'icon',
                                    className: 'mr-1 shrink-0',
                                  })}
                                  aria-label={t('callGuardian', { name })}
                                >
                                  <PhoneIcon aria-hidden />
                                </a>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="bg-warning-soft text-warning inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium">
                    <span aria-hidden className="size-1.5 rounded-full bg-current" />
                    {tAtt('notTaken')}
                  </span>
                  <ButtonLink
                    size="sm"
                    variant="outline"
                    href={registerHref(s.id, r.mode === 'PER_SESSION' ? 1 : 0)}
                  >
                    {t('takeNow')}
                  </ButtonLink>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
