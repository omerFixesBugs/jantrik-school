'use client';

import {
  PAYMENT_METHOD_VALUES,
  addMonths,
  formatCount,
  formatDate,
  formatMonth,
  formatTaka,
  todayIn,
  type InvoiceStatus,
  type PaymentMethod,
  type PlatformInvoiceDetail,
  type PlatformInvoiceListItem,
} from '@jantrik/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, WalletIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ChoiceChip, Field, TextField } from '@/components/form-kit';
import { calendarDate, takaToPaisa, usePlatformError } from '@/components/platform/institute-kit';
import { MoneyField } from '@/components/platform/plan-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { platformApi } from '@/lib/platform/platform-api';
import { cn } from '@/lib/utils';

const STATUS_VARIANT = { ISSUED: 'soft', PAID: 'success', VOID: 'secondary' } as const;

const textareaClass =
  'min-h-20 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

/** Unpaid / paid / void, plus "overdue" when an unpaid invoice is past its due date. */
export function InvoiceStatusBadge({
  status,
  overdue,
}: {
  status: InvoiceStatus;
  overdue: boolean;
}) {
  const t = useTranslations('platformBilling');
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={STATUS_VARIANT[status]} data-testid="invoice-status">
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {t(`status_${status}`)}
      </Badge>
      {overdue && (
        <Badge variant="destructive" data-testid="invoice-overdue">
          {t('overdue')}
        </Badge>
      )}
    </span>
  );
}

/** "October 2026", or "October 2026 – September 2027" for a year. */
export function periodLabel(
  i: Pick<PlatformInvoiceListItem, 'periodStart' | 'cycle'>,
  locale: Locale,
): string {
  const start = i.periodStart.slice(0, 7);
  return i.cycle === 'YEARLY'
    ? `${formatMonth(start, locale)} – ${formatMonth(addMonths(start, 11), locale)}`
    : formatMonth(start, locale);
}

const dateOf = calendarDate;
/** A discount (negative) as "−৳1,234". */
const amount = (paisa: number, locale: Locale) =>
  paisa < 0 ? `−${formatTaka(-paisa, locale)}` : formatTaka(paisa, locale);

/** Invoices: cards on phones, a table on desktop. `onOpen` shows one. */
export function InvoiceList({
  items,
  showInstitute,
  onOpen,
}: {
  items: PlatformInvoiceListItem[];
  showInstitute: boolean;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('platformBilling');
  const locale = useLocale() as Locale;
  const left = (i: PlatformInvoiceListItem) => i.totalPaisa - i.paidPaisa;
  const th =
    'text-muted-foreground h-11 border-b px-4 text-left text-sm font-medium whitespace-nowrap first:pl-5';
  return (
    <>
      <ul className="flex flex-col gap-3 lg:hidden" data-testid="invoice-cards">
        {items.map((i) => (
          <li key={i.id} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                {showInstitute && (
                  <Link
                    href={`/platform/institutes/${i.tenant.id}`}
                    className="font-semibold break-words underline-offset-2 hover:underline"
                  >
                    {i.tenant.name}
                  </Link>
                )}
                <span className={cn(!showInstitute && 'font-semibold')}>
                  {periodLabel(i, locale)}
                </span>
              </div>
              <InvoiceStatusBadge status={i.status} overdue={i.overdue} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('total')}</dt>
              <dd className="font-numeric text-right font-medium">
                {formatTaka(i.totalPaisa, locale)}
              </dd>
              {i.status === 'ISSUED' && (
                <>
                  <dt className="text-muted-foreground">{t('left')}</dt>
                  <dd className="font-numeric text-right font-medium">
                    {formatTaka(left(i), locale)}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('dueOn')}</dt>
              <dd className="text-right">{formatDate(dateOf(i.dueOn), locale, 'medium')}</dd>
            </dl>
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => onOpen(i.id)}
              aria-label={t('openLabel', { name: i.tenant.name, period: periodLabel(i, locale) })}
              data-testid="open-invoice"
            >
              {t('open')}
            </Button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-clip rounded-xl border lg:block">
        <table className="w-full text-sm" data-testid="invoice-table">
          <thead>
            <tr>
              {showInstitute && <th className={th}>{t('institute')}</th>}
              <th className={th}>{t('period')}</th>
              <th className={th}>{t('status')}</th>
              <th className={cn(th, 'text-right')}>{t('total')}</th>
              <th className={cn(th, 'text-right')}>{t('left')}</th>
              <th className={th}>{t('dueOn')}</th>
              <th className={cn(th, 'w-24')}>
                <span className="sr-only">{t('open')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b last:border-b-0">
                {showInstitute && (
                  <td className="py-3 pr-4 pl-5">
                    <Link
                      href={`/platform/institutes/${i.tenant.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {i.tenant.name}
                    </Link>
                  </td>
                )}
                <td className={cn('px-4 py-3', !showInstitute && 'pl-5')}>
                  {periodLabel(i, locale)}
                </td>
                <td className="px-4 py-3">
                  <InvoiceStatusBadge status={i.status} overdue={i.overdue} />
                </td>
                <td className="font-numeric px-4 py-3 text-right">
                  {formatTaka(i.totalPaisa, locale)}
                </td>
                <td className="font-numeric px-4 py-3 text-right">
                  {i.status === 'ISSUED' ? formatTaka(left(i), locale) : '—'}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {formatDate(dateOf(i.dueOn), locale, 'medium')}
                </td>
                <td className="py-3 pr-3 pl-1 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpen(i.id)}
                    aria-label={t('openLabel', {
                      name: i.tenant.name,
                      period: periodLabel(i, locale),
                    })}
                  >
                    {t('open')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One invoice: lines, payments, and the platform's actions (record a payment, void). */
export function InvoiceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('platformBilling');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const [mode, setMode] = useState<'view' | 'pay' | 'void'>('view');
  const q = useQuery({
    queryKey: ['platform-invoice', id],
    queryFn: () => platformApi<PlatformInvoiceDetail>(`/platform/invoices/${id}`),
  });
  const inv = q.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        data-testid="invoice-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {inv ? `${inv.tenant.name} · ${periodLabel(inv, locale)}` : t('invoice')}
          </DialogTitle>
          {inv && (
            <DialogDescription>
              {t('issuedDue', {
                issued: formatDate(dateOf(inv.issuedOn), locale, 'medium'),
                due: formatDate(dateOf(inv.dueOn), locale, 'medium'),
              })}
            </DialogDescription>
          )}
        </DialogHeader>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{explain(q.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-4">
            <InvoiceStatusBadge status={inv!.status} overdue={inv!.overdue} />
            <InvoiceLines invoice={inv!} locale={locale} />
            {inv!.voidReason && (
              <p className="text-muted-foreground text-sm">
                {t('voidedBecause', { reason: inv!.voidReason })}
              </p>
            )}
            <Payments invoice={inv!} locale={locale} />
            {inv!.status === 'ISSUED' && mode === 'view' && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setMode('pay')} data-testid="record-payment">
                  <WalletIcon aria-hidden />
                  {t('recordPayment')}
                </Button>
                {inv!.paidPaisa === 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => setMode('void')}
                    data-testid="void-invoice"
                  >
                    <BanIcon aria-hidden />
                    {t('void')}
                  </Button>
                )}
              </div>
            )}
            {mode === 'pay' && <PaymentForm invoice={inv!} onDone={() => setMode('view')} />}
            {mode === 'void' && <VoidForm invoice={inv!} onDone={() => setMode('view')} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvoiceLines({
  invoice: inv,
  locale,
}: {
  invoice: PlatformInvoiceDetail;
  locale: Locale;
}) {
  const t = useTranslations('platformBilling');
  return (
    <dl className="flex flex-col divide-y rounded-lg border text-sm" data-testid="invoice-lines">
      {inv.lines.map((l, n) => (
        <div key={n} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <dt className="flex min-w-0 flex-col">
            <span className="font-medium">{t(`line_${l.kind}`)}</span>
            {l.activeStudents !== null ? (
              <span className="text-muted-foreground">
                {t('lineDetail', {
                  students: formatCount(l.activeStudents, locale),
                  unit: formatTaka(l.unitPaisa, locale),
                  months: l.months,
                })}
              </span>
            ) : (
              l.kind === 'FLAT' &&
              l.months > 1 && (
                <span className="text-muted-foreground">
                  {t('lineDetailFlat', { unit: formatTaka(l.unitPaisa, locale), months: l.months })}
                </span>
              )
            )}
          </dt>
          <dd className="font-numeric shrink-0">{amount(l.amountPaisa, locale)}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-3 px-3 py-2 font-semibold">
        <dt>{t('total')}</dt>
        <dd className="font-numeric">{formatTaka(inv.totalPaisa, locale)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 px-3 py-2">
        <dt className="text-muted-foreground">{t('paid')}</dt>
        <dd className="font-numeric">{formatTaka(inv.paidPaisa, locale)}</dd>
      </div>
    </dl>
  );
}

function Payments({ invoice: inv, locale }: { invoice: PlatformInvoiceDetail; locale: Locale }) {
  const t = useTranslations('platformBilling');
  if (inv.payments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('payments')}</h3>
      <ul className="flex flex-col gap-2" data-testid="invoice-payments">
        {inv.payments.map((p) => (
          <li key={p.id} className="flex flex-col rounded-lg border px-3 py-2 text-sm">
            <span className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">
                {t(`method_${p.method}`)}
                {p.reference && (
                  <span className="text-muted-foreground font-normal" dir="ltr">
                    {' '}
                    · {p.reference}
                  </span>
                )}
              </span>
              <span className="font-numeric">{formatTaka(p.amountPaisa, locale)}</span>
            </span>
            <span className="text-muted-foreground">
              {t('paidOnBy', {
                date: formatDate(dateOf(p.paidOn), locale, 'medium'),
                name: p.recordedBy ?? '—',
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** After a billing change: the invoice, its institute and the lists show the new state. */
function useBillingRefresh(invoice: PlatformInvoiceDetail) {
  const queryClient = useQueryClient();
  return (next: PlatformInvoiceDetail) => {
    queryClient.setQueryData(['platform-invoice', invoice.id], next);
    for (const key of ['platform-invoices', 'platform-institutes']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    void queryClient.invalidateQueries({ queryKey: ['platform-institute', invoice.tenant.id] });
  };
}

function PaymentForm({
  invoice: inv,
  onDone,
}: {
  invoice: PlatformInvoiceDetail;
  onDone: () => void;
}) {
  const t = useTranslations('platformBilling');
  const explain = usePlatformError();
  const refresh = useBillingRefresh(inv);
  const left = inv.totalPaisa - inv.paidPaisa;
  const [amount, setAmount] = useState((left / 100).toString());
  const [method, setMethod] = useState<PaymentMethod>('BKASH');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState<string>(todayIn('Asia/Dhaka'));
  const [invalid, setInvalid] = useState(false);
  const pay = useMutation({
    mutationFn: (body: {
      amountPaisa: number;
      method: PaymentMethod;
      reference: string | null;
      paidOn: string;
    }) =>
      platformApi<PlatformInvoiceDetail>(`/platform/invoices/${inv.id}/payments`, {
        method: 'POST',
        json: body,
      }),
    onSuccess: (next) => {
      refresh(next);
      toast.success(next.status === 'PAID' ? t('paidInFull') : t('paymentRecorded'));
      onDone();
    },
    onError: (e) => toast.error(explain(e)),
  });
  const submit = () => {
    const paisa = takaToPaisa(amount);
    const ok = paisa !== null && paisa >= 1 && paisa <= left && Boolean(paidOn);
    setInvalid(!ok);
    if (ok)
      pay.mutate({ amountPaisa: paisa!, method, reference: reference.trim() || null, paidOn });
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="payment-form"
    >
      <MoneyField
        id="payment-amount"
        label={t('amount')}
        value={amount}
        onChange={setAmount}
        error={invalid ? t('errorAmount') : null}
        testId="payment-amount"
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t('method')}</legend>
        <div className="flex flex-wrap gap-2">
          {PAYMENT_METHOD_VALUES.map((m) => (
            <ChoiceChip
              key={m}
              type="radio"
              name="payment-method"
              checked={method === m}
              onChange={() => setMethod(m)}
            >
              {t(`method_${m}`)}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="payment-reference"
          label={t('reference')}
          hint={t('referenceHint')}
          value={reference}
          onChange={setReference}
          dir="ltr"
          maxLength={100}
        />
        <Field id="payment-date" label={t('paidOn')}>
          <Input
            id="payment-date"
            type="date"
            value={paidOn}
            max={todayIn('Asia/Dhaka')}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pay.isPending} data-testid="save-payment">
          {t('savePayment')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

function VoidForm({
  invoice: inv,
  onDone,
}: {
  invoice: PlatformInvoiceDetail;
  onDone: () => void;
}) {
  const t = useTranslations('platformBilling');
  const explain = usePlatformError();
  const refresh = useBillingRefresh(inv);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const voidIt = useMutation({
    mutationFn: (body: { reason: string }) =>
      platformApi<PlatformInvoiceDetail>(`/platform/invoices/${inv.id}/void`, {
        method: 'POST',
        json: body,
      }),
    onSuccess: (next) => {
      refresh(next);
      toast.success(t('voided'));
      onDone();
    },
    onError: (e) => toast.error(explain(e)),
  });
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const ok = reason.trim().length >= 3;
        setInvalid(!ok);
        if (ok) voidIt.mutate({ reason: reason.trim() });
      }}
    >
      <p className="text-muted-foreground text-sm">{t('voidHint')}</p>
      <Field
        id="void-reason"
        label={t('reason')}
        error={invalid ? t('errorReason') : null}
        required
      >
        <textarea
          id="void-reason"
          className={textareaClass}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={invalid || undefined}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={voidIt.isPending}>
          {t('void')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
