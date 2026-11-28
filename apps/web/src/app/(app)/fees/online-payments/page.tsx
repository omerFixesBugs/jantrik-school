'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  formatTime,
  isIsoDate,
  toAsciiDigits,
  type OnlinePaymentList,
  type OnlinePaymentListRow,
  type PaymentIntentStatus,
} from '@jantrik/shared';
import { GlobeIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Suspense, useId, useState } from 'react';
import { DataTable, type DataColumn } from '@/components/data-table';
import { CheckButton, Ident, onlineKeys, OnlineStatusPill } from '@/components/fees/online/kit';
import { ReviewLink } from '@/components/fees/online/review';
import { EmptyState, LoadError } from '@/components/fees/counter/kit';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { SelectField, TextField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';

export default function OnlinePaymentsPage() {
  return (
    <PageGate page="fees">
      {/* The filters live in the URL (useSearchParams). */}
      <Suspense>
        <OnlinePayments />
      </Suspense>
    </PageGate>
  );
}

/**
 * The states to filter by, in their order (PAYMENT_INTENT_STATUSES lives in a module with zod
 * schemas, which the browser never loads: browser-imports.test.ts).
 */
const STATUSES = [
  'NEEDS_REVIEW',
  'CREATED',
  'REDIRECTED',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED_OUTSIDE',
  'DISMISSED',
] as const satisfies readonly PaymentIntentStatus[];

const asStatus = (v: string | null): PaymentIntentStatus | null =>
  v !== null && (STATUSES as readonly string[]).includes(v) ? (v as PaymentIntentStatus) : null;

/**
 * Every online payment guardians started (docs/payments.md → The review queue), newest first, 50
 * a page: its state, the child, the amount, the method and our transaction ID; any fee staff may
 * ask SSLCommerz about one again. The review queue is one link away.
 */
function OnlinePayments() {
  const t = useTranslations('fees.online');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const describe = useErrorMessage();
  const tenantId = session?.tenant?.id;
  const roomy = useMediaQuery('(min-width: 768px)');
  const id = useId();
  const { params, set } = useUrlParams();
  const status = asStatus(params.get('status'));
  const from = params.get('from');
  const to = params.get('to');
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(q);

  const apiQuery = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(from && isIsoDate(from) ? { from } : {}),
    ...(to && isIsoDate(to) ? { to } : {}),
    ...(q ? { q } : {}),
    page: String(page),
  });
  const list = useQuery({
    queryKey: onlineKeys.list(tenantId, apiQuery.toString()),
    queryFn: () => client.api<OnlinePaymentList>(`/fees/online-payments?${apiQuery}`),
    placeholderData: keepPreviousData,
  });
  const count = useQuery({
    queryKey: onlineKeys.count(tenantId),
    queryFn: () => client.api<{ count: number }>('/fees/online-payments/review/count'),
  });
  const rows = list.data?.rows ?? [];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  const columns: DataColumn<OnlinePaymentListRow>[] = [
    {
      id: 'created',
      header: t('column.created'),
      cell: (r) => (
        <span className="whitespace-nowrap">
          {formatDate(r.createdAt, locale, 'medium')}, {formatTime(r.createdAt, locale)}
        </span>
      ),
    },
    {
      id: 'student',
      header: t('column.student'),
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">
            {pick(locale, r.student) || formatIdentifier(r.student.studentCode)}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
            {formatIdentifier(r.student.studentCode)}
          </span>
        </span>
      ),
    },
    {
      id: 'amount',
      header: t('column.amount'),
      align: 'end',
      className: 'font-semibold',
      cell: (r) => formatTaka(r.amountPaisa, locale),
    },
    {
      id: 'status',
      header: t('column.status'),
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <OnlineStatusPill status={r.status} />
          {r.receiptNumber && (
            <span className="text-muted-foreground font-mono text-xs" dir="ltr">
              {r.receiptNumber}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'tranId',
      header: t('column.tranId'),
      cell: (r) => <Ident value={r.tranId} className="text-xs" />,
    },
  ];
  const hidden = roomy ? [] : ['created', 'tranId'];

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="online-payments">
      <FeesTabs />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        </div>
        {count.data && <ReviewLink count={count.data.count} />}
      </header>

      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <SelectField
          id={`${id}-status`}
          label={t('statusLabel')}
          value={status ?? ''}
          placeholder={t('allStatuses')}
          onChange={(v) => set({ status: v || null, page: null })}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
          className="w-full lg:w-52"
        />
        <div className="grid grid-cols-2 gap-3 lg:flex">
          <TextField
            id={`${id}-from`}
            type="date"
            label={t('from')}
            value={from ?? ''}
            onChange={(v) => set({ from: v || null, page: null })}
            className="lg:w-44"
          />
          <TextField
            id={`${id}-to`}
            type="date"
            label={t('to')}
            value={to ?? ''}
            onChange={(v) => set({ to: v || null, page: null })}
            className="lg:w-44"
          />
        </div>
        <form
          className="flex items-end gap-2 lg:ms-auto"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: toAsciiDigits(search.trim()) || null, page: null });
          }}
        >
          <TextField
            id={`${id}-q`}
            label={t('search')}
            hint={t('searchHint')}
            value={search}
            onChange={setSearch}
            className="w-full lg:w-72"
          />
          <Button type="submit" variant="outline" className="mb-6">
            {t('searchGo')}
          </Button>
        </form>
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-(--row-h) w-full rounded-md" />
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <LoadError message={describe(list.error)} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GlobeIcon}
          title={t('empty')}
          text={t('emptyHint')}
          testId="online-empty"
        />
      ) : (
        <div className={cn('flex flex-col gap-2', list.isPlaceholderData && 'opacity-70')}>
          <DataTable
            testId="online-table"
            caption={t('title')}
            columns={columns}
            hidden={hidden}
            rows={rows}
            rowKey={(r) => r.id}
            rowLabel={(r) => pick(locale, r.student) || r.student.studentCode}
            actions={(r) =>
              r.status === 'CREATED' || r.status === 'REDIRECTED' || r.status === 'NEEDS_REVIEW' ? (
                <CheckButton intentId={r.id} />
              ) : null
            }
          />
          <nav className="flex items-center justify-between gap-2 text-sm" aria-label={t('pages')}>
            <span className="text-muted-foreground">
              {t('page', {
                page: formatCount(page, locale),
                pages: formatCount(pages, locale),
                total: formatCount(list.data!.total, locale),
              })}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => set({ page: page - 1 > 1 ? String(page - 1) : null })}
              >
                {t('newer')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={() => set({ page: String(page + 1) })}
              >
                {t('older')}
              </Button>
            </span>
          </nav>
          <p className="text-muted-foreground text-xs">
            {t('receiptsHint')}{' '}
            <Link href="/fees/closing" className="text-link">
              {t('closingLink')}
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
