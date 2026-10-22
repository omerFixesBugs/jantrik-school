'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  addDays,
  addMonths,
  daysBetween,
  FEE_COLLECTION_GROUPS,
  formatCount,
  formatDate,
  formatMonth,
  formatTaka,
  isoDateSchema,
  type FeeCollectionRow,
  type FeeCollections,
} from '@jantrik/shared';
import { DownloadIcon, PrinterIcon, WalletIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { DataTable, type DataColumn } from '@/components/data-table';
import { TextField } from '@/components/form-kit';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useMeContext } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';
import { downloadFile, EmptyState, LoadError } from './kit';

/*
 * Money kept in a period (void receipts left out), by day, month, fee, method or collector.
 * The period and the grouping live in the URL; this month is the default. Three narrow columns
 * fit a phone, so it is a table everywhere (the share bar joins from 640 px).
 */

type Group = (typeof FEE_COLLECTION_GROUPS)[number];
type Column = DataColumn<FeeCollectionRow> & { foot?: string };

const isDate = (v: string | null): v is string => v !== null && isoDateSchema.safeParse(v).success;

export function CollectionsReport() {
  const t = useTranslations('fees.reports.collections');
  const tc = useTranslations('fees.reports.common');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const { data: context } = useMeContext();
  const roomy = useMediaQuery('(min-width: 640px)');
  const id = useId();
  const { params, set } = useUrlParams();

  const today = context?.today ?? '';
  const monthStart = today ? `${today.slice(0, 7)}-01` : '';
  const urlFrom = params.get('from');
  const urlTo = params.get('to');
  const from = isDate(urlFrom) ? urlFrom : monthStart;
  const to = isDate(urlTo) ? urlTo : today;
  const groupParam = params.get('group');
  const group: Group = (FEE_COLLECTION_GROUPS as readonly string[]).includes(groupParam ?? '')
    ? (groupParam as Group)
    : 'day';

  // The fields type ahead of the URL: a period reaches it only once both ends are whole dates
  // that make a period (the report on screen stays meanwhile).
  const [fromDraft, setFromDraft] = useState(from);
  const [toDraft, setToDraft] = useState(to);
  const problem = (f: string, tt: string) =>
    !f || !tt
      ? null
      : tt < f
        ? t('rangeBackwards')
        : daysBetween(f, tt) > 366
          ? t('rangeTooLong')
          : null;
  const writeRange = (f: string, tt: string) => {
    if (!f || !tt || problem(f, tt)) return;
    set({ from: f !== monthStart ? f : null, to: tt !== today ? tt : null });
  };
  const preset = (which: 'this' | 'last') => {
    if (!today) return;
    const f = which === 'this' ? monthStart : `${addMonths(today.slice(0, 7), -1)}-01`;
    const tt = which === 'this' ? today : addDays(monthStart, -1);
    setFromDraft(f);
    setToDraft(tt);
    writeRange(f, tt);
  };
  const rangeError = problem(fromDraft, toDraft);
  const ready = Boolean(from && to) && !problem(from, to) && !rangeError;

  const apiQuery = new URLSearchParams({ from, to, groupBy: group, locale });
  const report = useQuery({
    queryKey: ['fee-collections', tenantId, apiQuery.toString()],
    queryFn: () => client.api<FeeCollections>(`/fees/reports/collections?${apiQuery}`),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const rows = report.data?.rows ?? [];
  const total = report.data?.total ?? { count: 0, amountPaisa: 0 };

  const [csvFailed, setCsvFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadCsv = async () => {
    setCsvFailed(false);
    setDownloading(true);
    try {
      await downloadFile(
        client,
        `/fees/reports/collections/csv?${apiQuery}`,
        `collections-${from}-${to}-${group}.csv`,
      );
    } catch {
      setCsvFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  const f = (n: number) => formatCount(n, locale);
  const taka = (p: number) => formatTaka(p, locale);
  const rowName = (r: FeeCollectionRow): string => {
    switch (group) {
      case 'day':
        return formatDate(r.key, locale, 'medium');
      case 'month':
        return formatMonth(r.key, locale);
      case 'method':
        return r.key === 'CASH' || r.key === 'BKASH' || r.key === 'NAGAD' ? tMethod(r.key) : r.key;
      case 'head':
        return pick(locale, r) || '—';
      case 'collector':
        return pick(locale, r) || t('unknownCollector');
    }
  };
  const share = (p: number) => (total.amountPaisa > 0 ? (p / total.amountPaisa) * 100 : 0);

  const columns: Column[] = [
    {
      id: 'name',
      header: t(`column.${group}`),
      cell: (r) => <span className="font-medium">{rowName(r)}</span>,
      foot: t('totalRow'),
    },
    {
      id: 'receipts',
      header: t('receipts'),
      align: 'end',
      cell: (r) => t('receiptsValue', { count: f(r.count) }),
      foot: t('receiptsValue', { count: f(total.count) }),
    },
    {
      id: 'amount',
      header: t('amount'),
      align: 'end',
      className: 'font-semibold',
      cell: (r) => taka(r.amountPaisa),
      foot: taka(total.amountPaisa),
    },
    {
      id: 'share',
      header: t('share'),
      className: 'w-48',
      cell: (r) => {
        const pct = share(r.amountPaisa);
        return (
          <span className="flex items-center gap-2">
            <span aria-hidden className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
              <span
                className="bg-primary-ink block h-full rounded-full print:[print-color-adjust:exact]"
                style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
              />
            </span>
            <span className="font-numeric w-12 text-end text-sm">{f(Math.round(pct))}%</span>
          </span>
        );
      },
    },
  ];
  const hidden = roomy ? [] : ['share'];
  const shownColumns = columns.filter((c) => !hidden.includes(c.id));
  const groupLabel = t(`group.${group}`);

  return (
    <div className="print-area flex flex-col gap-(--section-gap)" data-testid="report-collections">
      <div className="flex flex-col gap-3 print:hidden">
        <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="grid grid-cols-2 gap-3 lg:flex lg:items-start">
            <TextField
              id={`${id}-from`}
              type="date"
              label={t('from')}
              className="lg:w-44"
              value={fromDraft}
              max={today || undefined}
              onChange={(v) => {
                setFromDraft(v);
                writeRange(v, toDraft);
              }}
            />
            <TextField
              id={`${id}-to`}
              type="date"
              label={t('to')}
              className="lg:w-44"
              value={toDraft}
              max={today || undefined}
              error={rangeError}
              onChange={(v) => {
                setToDraft(v);
                writeRange(fromDraft, v);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('presets')}>
            <Button variant="outline" onClick={() => preset('this')}>
              {t('thisMonth')}
            </Button>
            <Button variant="outline" onClick={() => preset('last')}>
              {t('lastMonth')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 lg:ms-auto">
            <Button
              variant="outline"
              onClick={() => void downloadCsv()}
              disabled={!report.data || !ready || downloading}
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
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" aria-hidden>
            {t('groupBy')}
          </span>
          {/* Five choices may not fit a 360 px phone in Bangla: the track scrolls, never the page. */}
          <div className="-mx-1 max-w-full overflow-x-auto px-1 py-0.5">
            <SegmentedControl
              label={t('groupBy')}
              value={group}
              onChange={(g) => set({ group: g === 'day' ? null : g })}
              options={FEE_COLLECTION_GROUPS.map((g) => ({ value: g, label: t(`group.${g}`) }))}
              testId="collections-group"
            />
          </div>
        </div>
        {csvFailed && (
          <Alert variant="destructive">
            <AlertDescription>{tc('csvFailed')}</AlertDescription>
          </Alert>
        )}
      </div>

      {/* The paper's title block. */}
      <div className="hidden print:block">
        <p className="text-lg font-semibold">{context?.tenant.name}</p>
        <p>
          {t('printTitle', {
            from: formatDate(from || today, locale, 'long'),
            to: formatDate(to || today, locale, 'long'),
          })}
          {` · ${t('groupBy')}: ${groupLabel}`}
        </p>
        {today && (
          <p className="text-sm">{tc('generated', { date: formatDate(today, locale, 'long') })}</p>
        )}
      </div>

      {!ready ? null : report.isPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-(--row-h) w-full rounded-md" />
          ))}
        </div>
      ) : report.isError && !report.data ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={WalletIcon}
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
            rowKey={(r) => r.key}
            rowLabel={rowName}
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
          {group === 'head' && <p className="text-muted-foreground text-sm">{t('headNote')}</p>}
        </div>
      )}
    </div>
  );
}
