'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  daysBetween,
  formatCount,
  formatDate,
  formatTaka,
  isIsoDate,
  type OnlinePaymentsReport,
  type OnlinePaymentsReportRow,
} from '@jantrik/shared';
import { DownloadIcon, GlobeIcon, PrinterIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { DataTable, type DataColumn } from '@/components/data-table';
import { TextField } from '@/components/form-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';
import { downloadFile, EmptyState, LoadError } from './kit';

/*
 * Online payments (sprint 1 P7b, docs/payments.md → Reports): every payment started in a period,
 * by the day it was started and where it stands now, with the money SSLCommerz confirmed and
 * its charges (S24). This month is the default; the period lives in the URL.
 */

type Row = OnlinePaymentsReportRow;
type Column = DataColumn<Row> & { foot?: string };

const isDate = (v: string | null): v is string => v !== null && isIsoDate(v);

export function OnlineReport() {
  const t = useTranslations('fees.reports.online');
  const tc = useTranslations('fees.reports.common');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const roomy = useMediaQuery('(min-width: 1024px)');
  const id = useId();
  const { params, set } = useUrlParams();
  const today = context?.today ?? '';
  const monthStart = today ? `${today.slice(0, 7)}-01` : '';
  const from = isDate(params.get('from')) ? params.get('from')! : monthStart;
  const to = isDate(params.get('to')) ? params.get('to')! : today;
  const problem =
    !from || !to
      ? null
      : to < from
        ? t('rangeBackwards')
        : daysBetween(from, to) > 366
          ? t('rangeTooLong')
          : null;
  const ready = Boolean(from && to) && !problem;

  const apiQuery = new URLSearchParams({ from, to, locale });
  const report = useQuery({
    queryKey: ['fees', 'online', session?.tenant?.id, 'report', apiQuery.toString()],
    queryFn: () => client.api<OnlinePaymentsReport>(`/fees/reports/online-payments?${apiQuery}`),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const [csvFailed, setCsvFailed] = useState(false);
  const downloadCsv = async () => {
    setCsvFailed(false);
    try {
      await downloadFile(
        client,
        `/fees/reports/online-payments/csv?${apiQuery}`,
        `online-payments-${from}-${to}.csv`,
      );
    } catch {
      setCsvFailed(true);
    }
  };

  const f = (n: number) => formatCount(n, locale);
  const taka = (p: number) => formatTaka(p, locale);
  const total = report.data?.total;
  const columns: Column[] = [
    {
      id: 'day',
      header: t('day'),
      cell: (r) => <span className="font-medium">{formatDate(r.day, locale, 'medium')}</span>,
      foot: t('totalRow'),
    },
    {
      id: 'started',
      header: t('started'),
      align: 'end',
      cell: (r) => f(r.initiated.count),
      foot: total ? f(total.initiated.count) : '',
    },
    {
      id: 'paid',
      header: t('paid'),
      align: 'end',
      cell: (r) => `${f(r.paid.count)} · ${taka(r.paid.amountPaisa)}`,
      foot: total ? `${f(total.paid.count)} · ${taka(total.paid.amountPaisa)}` : '',
    },
    {
      id: 'review',
      header: t('review'),
      align: 'end',
      cell: (r) => `${f(r.review.count)} · ${taka(r.review.amountPaisa)}`,
      foot: total ? `${f(total.review.count)} · ${taka(total.review.amountPaisa)}` : '',
    },
    {
      id: 'unpaid',
      header: t('unpaid'),
      align: 'end',
      cell: (r) => f(r.failed.count + r.expired.count + r.dismissed.count + r.open.count),
      foot: total
        ? f(total.failed.count + total.expired.count + total.dismissed.count + total.open.count)
        : '',
    },
    {
      id: 'refunded',
      header: t('refunded'),
      align: 'end',
      cell: (r) => taka(r.refundedOutside.amountPaisa),
      foot: total ? taka(total.refundedOutside.amountPaisa) : '',
    },
    {
      id: 'charges',
      header: t('charges'),
      align: 'end',
      className: 'font-semibold',
      cell: (r) => taka(r.received.chargesPaisa),
      foot: total ? taka(total.received.chargesPaisa) : '',
    },
  ];
  const hidden = roomy ? [] : ['unpaid', 'refunded'];
  const shownColumns = columns.filter((c) => !hidden.includes(c.id));
  const rows = report.data?.rows ?? [];

  return (
    <div className="print-area flex flex-col gap-(--section-gap)" data-testid="report-online">
      <div className="flex flex-col gap-3 print:hidden">
        <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid grid-cols-2 gap-3 lg:flex lg:items-start">
            <TextField
              id={`${id}-from`}
              type="date"
              label={t('from')}
              className="lg:w-44"
              value={from}
              max={today || undefined}
              onChange={(v) => set({ from: v && v !== monthStart ? v : null })}
            />
            <TextField
              id={`${id}-to`}
              type="date"
              label={t('to')}
              className="lg:w-44"
              value={to}
              max={today || undefined}
              error={problem}
              onChange={(v) => set({ to: v && v !== today ? v : null })}
            />
          </div>
          <div className="flex flex-wrap gap-2 lg:ms-auto">
            <Button
              variant="outline"
              onClick={() => void downloadCsv()}
              disabled={!report.data || !ready}
              data-testid="report-csv"
            >
              <DownloadIcon aria-hidden />
              {tc('csv')}
            </Button>
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={!report.data || !ready}
              data-testid="report-print"
            >
              <PrinterIcon aria-hidden />
              {tc('print')}
            </Button>
          </div>
        </div>
        {csvFailed && (
          <Alert variant="destructive">
            <AlertDescription>{tc('csvFailed')}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="hidden print:block">
        <p className="text-lg font-semibold">{context?.tenant.name}</p>
        <p>
          {t('printTitle', {
            from: formatDate(from || today, locale, 'long'),
            to: formatDate(to || today, locale, 'long'),
          })}
        </p>
      </div>

      {!ready ? null : report.isPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-(--row-h) w-full rounded-md" />
          ))}
        </div>
      ) : report.isError && !report.data ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GlobeIcon}
          title={t('empty')}
          hint={t('emptyHint')}
          testId="report-empty"
        />
      ) : (
        <div className={cn('flex flex-col gap-2', report.isPlaceholderData && 'opacity-70')}>
          <DataTable
            className="print-unbound print:rounded-none print:border-0 print:shadow-none"
            testId="report-table"
            caption={t('printTitle', {
              from: formatDate(from, locale, 'long'),
              to: formatDate(to, locale, 'long'),
            })}
            columns={columns}
            hidden={hidden}
            rows={rows}
            rowKey={(r) => r.day}
            rowLabel={(r) => formatDate(r.day, locale, 'medium')}
            footer={
              <tr>
                {shownColumns.map((c) => (
                  <td
                    key={c.id}
                    className={cn(
                      'h-(--row-h) px-(--cell-px) py-(--cell-py) align-middle first:ps-4',
                      c.align === 'end' && 'num',
                      c.className,
                    )}
                  >
                    {c.foot}
                  </td>
                ))}
              </tr>
            }
          />
          {total && (
            <p className="text-muted-foreground text-sm" data-testid="report-online-received">
              {t('received', {
                amount: taka(total.received.amountPaisa),
                store: taka(total.received.storeAmountPaisa),
                charges: taka(total.received.chargesPaisa),
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
