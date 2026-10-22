'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDate, type FeeClosing } from '@jantrik/shared';
import { CoinsIcon, PrinterIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { ClosingCollectorCard, ClosingTotals } from '@/components/fees/counter/closing-card';
import { EmptyState, feeKeys, LoadError } from '@/components/fees/counter/kit';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { SelectField, TextField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, useFeeRoles } from '@/lib/fees';
import { useErrorMessage, useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function FeeClosingPage() {
  return (
    <PageGate page="fees">
      <div className="flex flex-col gap-(--section-gap)">
        <FeesTabs />
        {/* The date and the collector live in the URL (useSearchParams). */}
        <Suspense>
          <Closing />
        </Suspense>
      </div>
    </PageGate>
  );
}

/**
 * The day's closing (docs/fees.md → Daily closing): per collector what was collected, the voids
 * made that day, by method, and what should be in hand; the totals; print. An accountant gets
 * only their own (the API decides); OWNER/ADMIN may narrow it to one collector.
 */
function Closing() {
  const t = useTranslations('fees.counter.closing');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const { manages } = useFeeRoles();
  const { params, set } = useUrlParams();
  const today = context?.today ?? '';
  const asked = params.get('date');
  const date = asked && ISO_DATE.test(asked) && (!today || asked <= today) ? asked : today;
  const collectorId = manages ? params.get('collector') : null;

  const closing = useQuery({
    queryKey: [...feeKeys.closing(session?.tenant?.id), date],
    queryFn: () => client.api<FeeClosing>(`/fees/closing?date=${date}`),
    enabled: Boolean(date),
    placeholderData: keepPreviousData,
  });

  const data = closing.data;
  const all = data?.collectors ?? [];
  const chosen = collectorId ? all.find((c) => c.collector.id === collectorId) : undefined;
  const shown = chosen ? [chosen] : all;
  const name = (c: (typeof all)[number]) =>
    pick(locale, { nameBn: c.collector.nameBn, nameEn: c.collector.name }) || '—';

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-closing">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <TextField
          id="closing-date"
          type="date"
          label={t('date')}
          value={date}
          max={today || undefined}
          onChange={(v) => {
            if (v) set({ date: v === today ? null : v });
          }}
          className="w-full sm:w-48"
          data-testid="closing-date"
        />
        {manages && (all.length > 1 || chosen) && (
          <SelectField
            id="closing-collector"
            label={t('collector')}
            value={chosen?.collector.id ?? ''}
            onChange={(v) => set({ collector: v || null })}
            placeholder={t('everyone')}
            options={all.map((c) => ({ value: c.collector.id, label: name(c) }))}
            className="w-full sm:w-60"
          />
        )}
        <Button
          variant="outline"
          onClick={() => window.print()}
          disabled={shown.length === 0}
          className="sm:ms-auto"
          data-testid="closing-print"
        >
          <PrinterIcon aria-hidden />
          {t('print')}
        </Button>
      </div>

      {!date || closing.isPending ? (
        <div className="grid gap-(--gap) lg:grid-cols-2" aria-busy="true">
          <Skeleton className="rounded-card h-64" />
          <Skeleton className="rounded-card hidden h-64 lg:block" />
        </div>
      ) : closing.isError ? (
        <LoadError
          message={
            closing.error instanceof ApiError && closing.error.status === 403
              ? t('ownOnly')
              : `${t('loadFailed')} ${describe(closing.error)}`
          }
          onRetry={() => void closing.refetch()}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={CoinsIcon}
          title={date === today ? t('emptyToday') : t('emptyTitle')}
          text={t('emptyText')}
          testId="fees-closing-empty"
        />
      ) : (
        <div
          className={cn(
            'print-area flex flex-col gap-(--section-gap) transition-opacity',
            closing.isPlaceholderData && 'opacity-70',
          )}
        >
          <h2 className="text-lg font-semibold">
            <span className="hidden print:inline">{context?.tenant.name} · </span>
            {t('heading', { date: formatDate(date, locale, 'long') })}
          </h2>
          <div className="grid items-start gap-(--gap) lg:grid-cols-2 print:grid-cols-2">
            {shown.map((c) => (
              <ClosingCollectorCard key={c.collector.id} entry={c} />
            ))}
          </div>
          {!chosen && all.length > 1 && data && <ClosingTotals total={data.total} />}
        </div>
      )}
    </div>
  );
}
