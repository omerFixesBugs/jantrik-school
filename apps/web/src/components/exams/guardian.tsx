'use client';

import {
  formatCount,
  formatDate,
  formatGpa,
  formatPercentH,
  type ChildResultItem,
  type ReportCards,
} from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, GraduationCapIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { GuardianNotice } from '@/components/fees/guardian/guardian-gate';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { LoadError, useExamLine, useName } from './kit';
import { ReportCardsPrint } from './report-card';

/** Guardian result screens show only to a guardian whose institute runs EXAMS (the API checks too). */
export function useGuardianExamsOn(): boolean | undefined {
  const { data } = useMeContext();
  if (!data) return undefined;
  return data.roles.includes('GUARDIAN') && data.modules.includes('EXAMS');
}

/** GET /me/children/:id/results: published results only, newest first (404: not this guardian's child). */
export function useChildResults(childId: string, enabled = true) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['child-results', session?.tenant?.id, childId],
    queryFn: () => client.api<ChildResultItem[]>(`/me/children/${childId}/results`),
    enabled: enabled && Boolean(childId),
  });
}

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

/** "GPA 4.50 (A)" or "78.50%", whichever the exam reports. */
function useHeadline() {
  const t = useTranslations('exams.guardian');
  const locale = useLocale() as Locale;
  return (r: ChildResultItem) =>
    r.exam.resultMode === 'GPA' && r.gpaH != null
      ? t('gpa', { gpa: formatGpa(r.gpaH, r.gpaDecimals, locale), letter: r.letter ?? '' })
      : t('percent', { percent: formatPercentH(r.percentH, locale) });
}

/** The child card's results line: the latest published exam and the way to all results. */
export function ChildResultsSummary({ childId }: { childId: string }) {
  const t = useTranslations('exams.guardian');
  const locale = useLocale() as Locale;
  const name = useName();
  const headline = useHeadline();
  const on = useGuardianExamsOn();
  const q = useChildResults(childId, on === true);
  if (!on) return null;
  if (q.error instanceof ApiError && q.error.status === 404) return null;
  const latest = q.data?.[0];
  const titleId = `child-results-${childId}`;
  return (
    <section
      className="flex flex-col gap-3 border-t px-4 py-4 sm:px-5"
      aria-labelledby={titleId}
      data-testid="child-results-summary"
    >
      <h4 id={titleId} className="font-semibold">
        {t('title')}
      </h4>
      {q.isPending ? (
        <Skeleton className="h-14" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !latest ? (
        <p className="text-muted-foreground text-sm" data-testid="child-results-none">
          {t('none')}
        </p>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-muted-foreground text-sm">{name(latest.exam)}</span>
            <span
              className="font-numeric text-2xl leading-none font-light"
              data-testid="child-results-headline"
            >
              {headline(latest)}
            </span>
            <span className="text-sm">
              {latest.passed ? t('passed') : t('failed')}
              {latest.classPosition != null &&
                ` · ${t('position', { position: formatCount(latest.classPosition, locale), size: formatCount(latest.classSize, locale) })}`}
            </span>
          </div>
          <ButtonLink
            variant="outline"
            href={`/children/${childId}/results`}
            data-testid="child-results-open"
          >
            {t('open')}
            <ChevronRightIcon aria-hidden className="rtl:rotate-180" />
          </ButtonLink>
        </div>
      )}
    </section>
  );
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
