'use client';

import { formatCount, formatTaka } from '@jantrik/shared';
import { ChevronRightIcon, CircleCheckIcon, HourglassIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/hooks';
import { OverduePill } from './status-pills';
import { useChildFees, useGuardianFeesOn } from './use-child-fees';

/**
 * A child's fees in a line, for the dashboard's child card: what is owed now (or "all paid"),
 * the overdue part, payments still being checked, and the way to the fees page. Renders nothing
 * while the institute does not run FEES.
 */
export function ChildFeesSummary({ childId }: { childId: string }) {
  const t = useTranslations('fees.guardian.summary');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const on = useGuardianFeesOn();
  const q = useChildFees(childId, on === true);
  if (!on) return null;
  // Not this guardian's child any more (or never): nothing to say here.
  if (q.error instanceof ApiError && q.error.status === 404) return null;

  const ledger = q.data?.ledger;
  const owed = ledger?.totals.balance ?? 0;
  const overdue = ledger?.totals.overdue ?? 0;
  const pending = q.data?.submissions.filter((s) => s.status === 'PENDING').length ?? 0;
  const titleId = `child-fees-${childId}`;

  return (
    <section
      className="flex flex-col gap-3 border-t px-4 py-4 sm:px-5"
      aria-labelledby={titleId}
      data-testid="child-fees-summary"
    >
      <h4 id={titleId} className="font-semibold">
        {t('title')}
      </h4>
      {q.isPending ? (
        <Skeleton className="h-16" aria-label={tCommon('loading')} />
      ) : q.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-destructive text-sm">{describe(q.error)}</p>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          {owed > 0 ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-muted-foreground text-sm">{t('owedNow')}</span>
              <span
                className="font-numeric text-3xl leading-none font-light"
                data-testid="child-fees-owed"
              >
                {formatTaka(owed, locale)}
              </span>
              {overdue > 0 && (
                <span>
                  <OverduePill amount={formatTaka(overdue, locale)} />
                </span>
              )}
            </div>
          ) : (
            <p className="text-success flex items-center gap-2 font-medium">
              <CircleCheckIcon aria-hidden className="size-5 shrink-0" />
              <span className="text-foreground">{t('allPaid')}</span>
            </p>
          )}
          <ButtonLink
            variant="outline"
            href={`/children/${childId}/fees`}
            data-testid="child-fees-open"
          >
            {t('view')}
            <ChevronRightIcon aria-hidden data-icon="inline-end" />
          </ButtonLink>
          {pending > 0 && (
            <p className="text-muted-foreground flex w-full items-center gap-2 text-sm">
              <HourglassIcon aria-hidden className="text-info size-4 shrink-0" />
              {t('pending', { count: formatCount(pending, locale), n: pending })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
