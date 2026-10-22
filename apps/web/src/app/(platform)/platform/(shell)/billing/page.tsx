'use client';

import {
  INVOICE_STATUS_VALUES,
  addMonths,
  formatCount,
  formatMonth,
  type PlatformGenerateResult,
  type PlatformInvoicePage,
} from '@jantrik/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, ReceiptTextIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, SectionCard, SelectField } from '@/components/form-kit';
import { InvoiceDialog, InvoiceList } from '@/components/platform/billing-kit';
import { usePlatformError } from '@/components/platform/institute-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DateInput } from '@/components/date-input';
import type { Locale } from '@/i18n/config';
import { usePlatformToday } from '@/lib/platform/hooks';
import { platformApi } from '@/lib/platform/platform-api';

const PAGE_SIZE = 25;
const SKIP_REASONS = [
  'trial',
  'suspended',
  'noPlan',
  'notStarted',
  'exists',
  'free',
  'tooLarge',
] as const;

/** Billing: issue a month's invoices, then follow them up (payments, overdue, void). */
export default function PlatformBillingPage() {
  const t = useTranslations('platformBilling');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground max-w-prose">{t('hint')}</p>
      </div>
      <Generate />
      <Invoices />
    </div>
  );
}

function Generate() {
  const today = usePlatformToday();
  const t = useTranslations('platformBilling');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const queryClient = useQueryClient();
  const thisMonth = today.slice(0, 7);
  const months = [-3, -2, -1, 0, 1].map((d) => addMonths(thisMonth, d));
  const [month, setMonth] = useState(thisMonth);
  const [issuedOn, setIssuedOn] = useState('');
  const [result, setResult] = useState<{ month: string; r: PlatformGenerateResult } | null>(null);
  const generate = useMutation({
    mutationFn: () =>
      platformApi<PlatformGenerateResult>('/platform/invoices/generate', {
        method: 'POST',
        json: { month, issuedOn: issuedOn || null },
      }),
    onSuccess: (r) => {
      setResult({ month, r });
      toast.success(t('generated', { count: formatCount(r.created, locale), n: r.created }));
      for (const key of ['platform-invoices', 'platform-institutes', 'platform-institute']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(explain(e)),
  });
  const skipped = result ? SKIP_REASONS.filter((k) => (result.r.skipped[k] ?? 0) > 0) : [];
  return (
    <SectionCard id="billing-generate" title={t('generateTitle')} hint={t('generateHint')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          generate.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <SelectField
            id="generate-month"
            label={t('month')}
            value={month}
            onChange={setMonth}
            options={months.map((m) => ({ value: m, label: formatMonth(m, locale) }))}
          />
          <Field id="generate-issued" label={t('issuedOn')} hint={t('issuedOnHint')}>
            <DateInput
              id="generate-issued"
              value={issuedOn}
              max={today}
              onValueChange={setIssuedOn}
            />
          </Field>
        </div>
        <Button
          type="submit"
          className="w-fit"
          disabled={generate.isPending}
          data-testid="generate"
        >
          <ReceiptTextIcon aria-hidden />
          {t('generate', { month: formatMonth(month, locale) })}
        </Button>
      </form>
      {result && (
        <div
          className="bg-muted/40 flex flex-col gap-2 rounded-lg px-4 py-3"
          data-testid="generate-result"
        >
          <p className="font-medium">
            {t('generatedFor', {
              month: formatMonth(result.month, locale),
              count: formatCount(result.r.created, locale),
              n: result.r.created,
            })}
          </p>
          {skipped.length > 0 && (
            <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
              {skipped.map((k) => (
                <li key={k}>
                  {t(`skipped_${k}`, { count: formatCount(result.r.skipped[k]!, locale) })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Invoices() {
  const today = usePlatformToday();
  const t = useTranslations('platformBilling');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const thisMonth = today.slice(0, 7);
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [month, setMonth] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filterKey = JSON.stringify([status, overdue, month]);
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) params.set('status', status);
  if (overdue) params.set('overdue', 'true');
  if (month) params.set('month', month);
  const list = useQuery({
    queryKey: ['platform-invoices', params.toString()],
    queryFn: () => platformApi<PlatformInvoicePage>(`/platform/invoices?${params}`),
    placeholderData: keepPreviousData,
  });
  const last = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <SectionCard id="billing-invoices" title={t('invoicesTitle')}>
      <div className="grid gap-3 sm:grid-cols-3 lg:max-w-3xl lg:items-end">
        <SelectField
          id="invoice-status"
          label={t('status')}
          value={status}
          onChange={setStatus}
          placeholder={t('anyStatus')}
          options={INVOICE_STATUS_VALUES.map((s) => ({ value: s, label: t(`status_${s}`) }))}
        />
        <SelectField
          id="invoice-month"
          label={t('month')}
          value={month}
          onChange={setMonth}
          placeholder={t('anyMonth')}
          options={[-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1].reverse().map((d) => {
            const m = addMonths(thisMonth, d);
            return { value: m, label: formatMonth(m, locale) };
          })}
        />
        <label className="flex h-11 items-center gap-2 text-sm font-medium md:h-10">
          <input
            type="checkbox"
            className="accent-primary size-5"
            checked={overdue}
            onChange={(e) => setOverdue(e.target.checked)}
            data-testid="filter-overdue"
          />
          {t('overdueOnly')}
        </label>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{explain(list.error)}</AlertDescription>
        </Alert>
      ) : list.data.items.length === 0 ? (
        <p className="text-muted-foreground" data-testid="invoices-empty">
          {t('empty')}
        </p>
      ) : (
        <>
          <InvoiceList items={list.data.items} showInstitute onOpen={setOpen} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {t('count', { count: formatCount(list.data.total, locale), n: list.data.total })}
            </p>
            {last > 1 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPaging({ key: filterKey, page: page - 1 })}
                >
                  <ChevronLeftIcon aria-hidden />
                  {t('previous')}
                </Button>
                <Button
                  variant="outline"
                  disabled={page >= last}
                  onClick={() => setPaging({ key: filterKey, page: page + 1 })}
                >
                  {t('next')}
                  <ChevronRightIcon aria-hidden />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </SectionCard>
  );
}
