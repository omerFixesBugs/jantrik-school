'use client';

import { formatCount, formatDate, type ReportCards } from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, GraduationCapIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { GuardianNotice } from '@/components/fees/guardian/guardian-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useChildResults, useGuardianExamsOn, useHeadline } from './child-results-summary';
import { LoadError, useExamLine, useName } from './kit';
import { ReportCardsPrint } from './report-card';

export function GuardianExamsGate({ children }: { children: ReactNode }) {
  const t = useTranslations('notAvailable');
  const on = useGuardianExamsOn();
  if (on === undefined) return null;
  if (!on)
    return (
      <GuardianNotice title={t('title')} text={t('text')} testId="guardian-exams-unavailable" />
    );
  return <>{children}</>;
}

function BackToDashboard() {
  const t = useTranslations('exams.guardian');
  return (
    <Link
      href="/dashboard"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) w-fit items-center gap-1 text-sm print:hidden"
    >
      <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('back')}
    </Link>
  );
}

/** All of a child's published results, newest first. */
export function ChildResultsList({ childId }: { childId: string }) {
  const t = useTranslations('exams.guardian');
  const locale = useLocale() as Locale;
  const name = useName();
  const line = useExamLine();
  const headline = useHeadline();
  const q = useChildResults(childId);
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <BackToDashboard />
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {q.isPending ? (
        <Skeleton className="rounded-card h-40" />
      ) : q.error instanceof ApiError && q.error.status === 404 ? (
        <GuardianNotice
          title={t('notFoundTitle')}
          text={t('notFoundText')}
          testId="child-results-not-found"
        />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <GuardianNotice
          icon={GraduationCapIcon}
          title={t('noneTitle')}
          text={t('none')}
          testId="child-results-empty"
        />
      ) : (
        <ul
          className="bg-card rounded-card shadow-card divide-y border"
          data-testid="child-results"
        >
          {q.data.map((r) => (
            <li key={r.examClassId}>
              <Link
                href={`/children/${childId}/results/${r.examClassId}`}
                className="hover:bg-muted/50 flex items-center gap-3 p-4"
                data-testid="child-result"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{name(r.exam)}</span>
                  <span className="text-muted-foreground block text-sm">{line(r.exam)}</span>
                  <span className="block text-sm">
                    <span className="font-numeric font-semibold">{headline(r)}</span>
                    {' · '}
                    {r.passed ? t('passed') : t('failed')}
                    {r.classPosition != null &&
                      ` · ${t('position', { position: formatCount(r.classPosition, locale), size: formatCount(r.classSize, locale) })}`}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className="text-muted-foreground size-5 shrink-0 rtl:rotate-180"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One published report card, printable (A4 portrait). */
export function ChildReportCard({
  childId,
  examClassId,
}: {
  childId: string;
  examClassId: string;
}) {
  const t = useTranslations('exams.guardian');
  const tPrint = useTranslations('exams.print');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const q = useQuery({
    queryKey: ['child-results', session?.tenant?.id, childId, examClassId],
    queryFn: () => client.api<ReportCards>(`/me/children/${childId}/results/${examClassId}`),
  });
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link
          href={`/children/${childId}/results`}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) items-center gap-1 text-sm"
        >
          <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
          {t('allResults')}
        </Link>
        <span className="flex-1" />
        {q.data && (
          <Button onClick={() => window.print()} data-testid="print">
            <PrinterIcon aria-hidden />
            {tPrint('print')}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className="rounded-card h-[60vh]" />
      ) : q.error instanceof ApiError && q.error.status === 404 ? (
        <GuardianNotice
          title={t('notFoundTitle')}
          text={t('notFoundText')}
          testId="child-results-not-found"
        />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <p className="text-muted-foreground text-sm print:hidden">
            {t('publishedOn', { date: formatDate(q.data.publishedAt, locale) })}
          </p>
          <ReportCardsPrint data={q.data} />
        </>
      )}
    </div>
  );
}
