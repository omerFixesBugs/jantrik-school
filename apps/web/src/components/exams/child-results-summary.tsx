'use client';

import { formatCount, formatGpa, formatPercentH, type ChildResultItem } from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { LoadError, useName } from './kit';

// The dashboard's part of the guardian results: kept apart from guardian.tsx so the dashboard
// does not load the report card and its print layout.

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

/** "GPA 4.50 (A)" or "78.50%", whichever the exam reports. */
export function useHeadline() {
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
