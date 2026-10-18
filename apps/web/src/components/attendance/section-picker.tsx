'use client';

import { useQuery } from '@tanstack/react-query';
import {
  dateToDb,
  formatCount,
  formatDate,
  formatTime,
  type MySectionsResponse,
} from '@jantrik/shared';
import {
  CalendarOffIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudOffIcon,
  UsersRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { listDrafts } from '@/lib/attendance/drafts';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

export const registerHref = (sectionId: string, periodNo = 0, date?: string) => {
  const q = new URLSearchParams({ section: sectionId });
  if (periodNo) q.set('period', String(periodNo));
  if (date) q.set('date', date);
  return `/attendance?${q}`;
};

/** Which register to open: the caller's sections for today (server date), unsent drafts first. */
export function SectionPicker() {
  const t = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const tenantId = session?.tenant?.id ?? '';
  const userId = session?.user.id ?? '';
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;

  const mine = useQuery({
    queryKey: ['attendance-my-sections', tenantId],
    queryFn: () => client.api<MySectionsResponse>('/attendance/my-sections'),
  });
  const drafts = useMemo(() => (userId ? listDrafts(userId, tenantId) : []), [userId, tenantId]);
  const section = label('section', 'Section', { inText: true });

  // A teacher with a single section and nothing else pending goes straight to it.
  const only =
    !isAdmin && mine.data?.sections.length === 1 && drafts.length === 0
      ? mine.data.sections[0]
      : null;
  useEffect(() => {
    if (only && mine.data?.mode === 'DAILY') router.replace(registerHref(only.id));
  }, [only, mine.data?.mode, router]);

  return (
    <div className="flex flex-col gap-5">
      {drafts.length > 0 && (
        <section
          className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-xl border p-4"
          data-testid="unsent-drafts"
        >
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CloudOffIcon aria-hidden className="text-warning size-5" />
            {t('unsentTitle')}
          </h2>
          <ul className="flex flex-col gap-2">
            {drafts.map((d) => (
              <li
                key={`${d.sectionId}:${d.date}:${d.periodNo}`}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm">
                  {t('unsentItem', {
                    section: d.sectionName,
                    date: formatDate(dateToDb(d.date), locale, 'long'),
                  })}
                </span>
                <ButtonLink
                  size="sm"
                  variant="outline"
                  href={registerHref(
                    d.sectionId,
                    d.periodNo,
                    d.date === mine.data?.today ? undefined : d.date,
                  )}
                >
                  {t('open')}
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold sm:text-2xl">{t('pickTitle', { section })}</h2>
        {mine.data && (
          <p className="text-muted-foreground">
            {t('today', { date: formatDate(dateToDb(mine.data.today), locale, 'full') })}
          </p>
        )}
      </div>

      {mine.data?.nonWorkingDay && (
        <Alert>
          <CalendarOffIcon aria-hidden />
          <AlertDescription>
            {mine.data.nonWorkingDay.reason === 'HOLIDAY'
              ? t('holiday', {
                  name:
                    locale === 'bn'
                      ? mine.data.nonWorkingDay.nameBn
                      : mine.data.nonWorkingDay.nameEn,
                })
              : t('offDay')}
          </AlertDescription>
        </Alert>
      )}

      {mine.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label={tCommon('loading')}>
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : mine.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {describe(mine.error)}
            <Button size="sm" variant="outline" onClick={() => void mine.refetch()}>
              {tCommon('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : mine.data.sections.length === 0 ? (
        <div className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-12 text-center">
          <span className="bg-primary-soft text-primary flex size-14 items-center justify-center rounded-2xl">
            <UsersRoundIcon aria-hidden className="size-7" />
          </span>
          <p className="font-medium">{t('noSections', { section })}</p>
          <p className="text-muted-foreground text-sm">{t('noSectionsHint', { section })}</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="section-list">
          {mine.data.sections.map((s) => {
            const taken = s.sessions[0];
            return (
              <li key={s.id}>
                <Link
                  href={registerHref(s.id, mine.data.mode === 'PER_SESSION' ? 1 : 0)}
                  className={cn(
                    'bg-card flex min-h-24 items-center gap-4 rounded-xl border p-4 shadow-xs transition-colors',
                    'hover:border-primary/40 focus-visible:ring-ring/40 outline-none focus-visible:ring-3',
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-heading truncate text-lg font-semibold">
                      {displayName(s.classLevel.nameBn, s.classLevel.nameEn, locale)}
                      <span className="text-muted-foreground font-sans font-medium">
                        , {s.name}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {t('students', { count: formatCount(s.studentCount, locale) })}
                      </span>
                      {s.isClassTeacher && (
                        <span className="bg-primary-soft text-accent-foreground rounded-md px-1.5 text-xs">
                          {t('classTeacher')}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
                        taken ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning',
                      )}
                    >
                      {taken ? (
                        <>
                          <CheckIcon aria-hidden className="size-3.5" />
                          {t('taken', { time: formatTime(taken.submittedAt, locale) })}
                        </>
                      ) : (
                        <>
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                          {t('notTaken')}
                        </>
                      )}
                    </span>
                  </span>
                  <ChevronRightIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
