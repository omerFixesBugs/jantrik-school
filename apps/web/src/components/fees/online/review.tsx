'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  formatTime,
  type FeeLedger,
  type FeeReceipt,
  type OnlineMoneyView,
  type OnlinePaymentStaffView,
  type PaymentReviewReason,
  type PaymentSignalItem,
} from '@jantrik/shared';
import { AlertTriangleIcon, BanknoteIcon, ShieldAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { MoneyField } from '@/components/fees/money-field';
import { LoadError } from '@/components/fees/counter/kit';
import { TextField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { randomId } from '@/lib/uuid';
import { CheckButton, Ident, LastCheck, useDueName, useRefreshOnline } from './kit';

/*
 * The review queue's items and the three decisions (sprint 1 P7b, docs/payments.md → The review
 * queue): apply the money to chosen dues, record it as refunded outside the app, or dismiss what
 * holds no money. The server decides again on the locked row; these screens only explain.
 */

/** The server's codes, in words (anything else: the generic error message). */
const KNOWN_ERRORS = [
  'ALREADY_RESOLVED',
  'DUES_CHANGED',
  'AMOUNT_EXCEEDS_DUE',
  'AMOUNT_EXCEEDS_MONEY',
  'REMAINDER_NEEDS_REFUND',
  'NO_MONEY',
  'HAS_MONEY',
  'CHECK_FIRST',
  'CURRENCY_NOT_APPLICABLE',
  'AMOUNT_UNKNOWN',
  'TRX_ID_UNUSABLE',
  'TRX_ID_USED',
  'ALREADY_REFUNDED',
  'HELD_BY_PAYMENT',
  'PAYMENT_VOIDED',
  'DUE_COLLECTED',
] as const;

function useDecisionError() {
  const t = useTranslations('fees.review.err');
  const describe = useErrorMessage();
  return (error: unknown) =>
    error instanceof ApiError && (KNOWN_ERRORS as readonly string[]).includes(error.code ?? '')
      ? t(error.code as (typeof KNOWN_ERRORS)[number])
      : describe(error);
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** The money SSLCommerz confirmed: amount, method, its transaction ID, when, the risk. */
function MoneyFacts({ money, asked }: { money: OnlineMoneyView | null; asked?: number }) {
  const t = useTranslations('fees.review');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-sm">
      {asked !== undefined && (
        <Fact term={t('asked')}>
          <span className="font-numeric">{formatTaka(asked, locale)}</span>
        </Fact>
      )}
      <Fact term={t('money')}>
        {money ? (
          <span className="font-numeric font-semibold">
            {money.amountPaisa !== null
              ? formatTaka(money.amountPaisa, locale)
              : t('amountUnknown')}
            {money.currency && money.currency !== 'BDT' && (
              <span className="text-destructive" dir="ltr">
                {' '}
                {money.currency}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('noMoney')}</span>
        )}
      </Fact>
      {money && (
        <>
          <Fact term={t('method')}>
            {money.method ? tMethod(money.method) : '—'}
            {money.instrument && (
              <span className="text-muted-foreground" dir="ltr">
                {' '}
                · {money.instrument}
              </span>
            )}
          </Fact>
          <Fact term={t('bankTranId')}>
            <Ident value={money.bankTranId} />
          </Fact>
          {money.paidAt && (
            <Fact term={t('paidAt')}>
              {formatDate(money.paidAt, locale, 'medium')}, {formatTime(money.paidAt, locale)}
            </Fact>
          )}
          {money.storeAmountPaisa !== null && (
            <Fact term={t('storeAmount')}>
              <span className="font-numeric">{formatTaka(money.storeAmountPaisa, locale)}</span>
            </Fact>
          )}
          {money.risk === 'HIGH' && (
            <Fact term={t('riskLabel')}>
              <Pill tone="destructive">
                <ShieldAlertIcon aria-hidden className="size-3.5" />
                {t('riskHigh')}
              </Pill>
            </Fact>
          )}
        </>
      )}
    </dl>
  );
}

function Reasons({ reasons }: { reasons: PaymentReviewReason[] }) {
  const t = useTranslations('fees.review.reason');
  return (
    <ul className="flex flex-col gap-1.5" data-testid="review-reasons">
      {reasons.map((r) => (
        <li key={r} className="flex items-start gap-2 text-sm" data-reason={r}>
          <AlertTriangleIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
          <span>{t(r)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One online payment waiting for a person: why, the money, the child, the dues then and now. */
export function ReviewIntentCard({
  item,
  manages,
  onApply,
  onRefund,
  onDismiss,
}: {
  item: OnlinePaymentStaffView;
  manages: boolean;
  onApply: () => void;
  onRefund: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  const dueName = useDueName();
  const name = pick(locale, item.student) || formatIdentifier(item.student.studentCode);
  return (
    <li
      data-slot="card"
      data-testid="review-intent"
      data-intent-id={item.id}
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col border"
    >
      <div className="flex items-start justify-between gap-3 px-(--panel-p) pt-(--panel-p) pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="min-w-0 truncate py-0.5 leading-normal font-semibold">{name}</span>
          <span className="text-muted-foreground text-sm leading-normal">
            {item.student.classLevel && <>{pick(locale, item.student.classLevel)} · </>}
            <span className="whitespace-nowrap tabular-nums" dir="ltr">
              {formatIdentifier(item.student.studentCode)}
            </span>
          </span>
          {item.payer && (
            <span className="text-muted-foreground text-sm">
              {t('payer', { name: pick(locale, item.payer) })}
            </span>
          )}
        </div>
        <span className="font-numeric shrink-0 text-xl leading-tight font-semibold">
          {item.money?.amountPaisa != null
            ? formatTaka(item.money.amountPaisa, locale)
            : formatTaka(item.amountPaisa, locale)}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t px-(--panel-p) py-3">
        <Reasons reasons={item.reasons} />
        <MoneyFacts money={item.money} asked={item.amountPaisa} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-sm">
          <Fact term={t('tranId')}>
            <Ident value={item.tranId} />
          </Fact>
          <Fact term={t('started')}>
            {formatDate(item.createdAt, locale, 'medium')}, {formatTime(item.createdAt, locale)}
          </Fact>
          {item.status === 'NEEDS_REVIEW' && item.refundedOutside && (
            <Fact term={t('refundedBefore')}>
              <span className="font-numeric" data-testid="review-refunded-before">
                {formatTaka(item.refundedOutside.amountPaisa, locale)}
              </span>
              {item.refundedOutside.reference && (
                <>
                  {' · '}
                  <Ident value={item.refundedOutside.reference} />
                </>
              )}
            </Fact>
          )}
        </dl>
      </div>

      <div className="flex flex-col gap-1.5 border-t px-(--panel-p) py-3 text-sm">
        <p className="font-medium">{t('dues')}</p>
        <ul className="flex flex-col gap-1">
          {item.dues.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0">{dueName(d)}</span>
              <span className="text-muted-foreground font-numeric">
                {t('thenNow', {
                  then: formatTaka(d.principalPaisa + d.finePaisa, locale),
                  now:
                    d.now.totalPaisa > 0 ? formatTaka(d.now.totalPaisa, locale) : t('nothingOwed'),
                })}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-(--panel-p) py-2 text-xs">
        <span className="text-muted-foreground">
          <LastCheck check={item.lastCheck} />
        </span>
        <CheckButton intentId={item.id} />
      </div>

      {manages ? (
        <div className="mt-auto flex flex-col gap-2 border-t p-3">
          <div className="flex flex-wrap gap-2">
            {item.actions.refundOutside && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={onRefund}
                data-testid="review-refund"
              >
                {t('refund')}
              </Button>
            )}
            {item.actions.dismiss && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={onDismiss}
                disabled={!item.actions.dismissReady}
                data-testid="review-dismiss"
              >
                {t('dismiss')}
              </Button>
            )}
            {item.actions.apply && (
              <Button className="flex-1" onClick={onApply} data-testid="review-apply">
                {t('apply')}
              </Button>
            )}
          </div>
          {item.actions.dismiss && !item.actions.dismissReady && (
            <p className="text-muted-foreground text-xs">{t('dismissNeedsCheck')}</p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground mt-auto border-t px-(--panel-p) py-2 text-xs">
          {t('viewOnly')}
        </p>
      )}
    </li>
  );
}

/** Money no payment of ours holds, or that came twice: given back, never applied (P7b-H). */
export function ReviewSignalCard({
  item,
  manages,
  onRefund,
  onDismiss,
}: {
  item: PaymentSignalItem;
  manages: boolean;
  onRefund: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  return (
    <li
      data-slot="card"
      data-testid="review-signal"
      data-event-id={item.eventId}
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col border"
    >
      <div className="flex items-start justify-between gap-3 px-(--panel-p) pt-(--panel-p) pb-3">
        <div className="flex min-w-0 items-start gap-2">
          <BanknoteIcon aria-hidden className="text-warning mt-0.5 size-5 shrink-0" />
          <span className="leading-normal font-semibold">{t(`signal.${item.reason}`)}</span>
        </div>
        <span className="font-numeric shrink-0 text-xl leading-tight font-semibold">
          {item.money.amountPaisa !== null ? formatTaka(item.money.amountPaisa, locale) : '—'}
        </span>
      </div>
      <div className="flex flex-col gap-3 border-t px-(--panel-p) py-3">
        <MoneyFacts money={item.money} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-sm">
          <Fact term={t('tranId')}>
            <Ident value={item.tranId} />
          </Fact>
          <Fact term={t('forPayment')}>
            {item.intent ? (
              <span>
                {pick(locale, item.intent.student) ||
                  formatIdentifier(item.intent.student.studentCode)}{' '}
                · <Ident value={item.intent.tranId} />
              </span>
            ) : (
              t('noIntent')
            )}
          </Fact>
          <Fact term={t('receivedAt')}>
            {formatDate(item.receivedAt, locale, 'medium')}, {formatTime(item.receivedAt, locale)}
          </Fact>
        </dl>
        <p className="text-muted-foreground text-sm">{t('neverApplied')}</p>
      </div>
      {manages ? (
        <div className="mt-auto flex flex-wrap gap-2 border-t p-3">
          {item.canDismiss && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={onDismiss}
              data-testid="review-signal-dismiss"
            >
              {t('dismissRepeat')}
            </Button>
          )}
          <Button className="flex-1" onClick={onRefund} data-testid="review-signal-refund">
            {t('refund')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground mt-auto border-t px-(--panel-p) py-2 text-xs">
          {t('viewOnly')}
        </p>
      )}
    </li>
  );
}

const textareaClass =
  'min-h-20 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-(length:--input-fs) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-destructive';

/** Why (required, 3 to 500 characters): the audit log keeps it. */
function NoteField({
  value,
  onChange,
  tried,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  tried: boolean;
  label?: string;
}) {
  const t = useTranslations('fees.review');
  const id = useId();
  const error = tried && value.trim().length < 3 ? t('noteShort') : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label ?? t('note')}
        <span aria-hidden className="text-destructive">
          *
        </span>
      </Label>
      <textarea
        id={id}
        className={textareaClass}
        value={value}
        maxLength={500}
        required
        placeholder={t('notePlaceholder')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        data-testid="review-note"
      />
      {error && (
        <p id={`${id}-error`} className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const REFERENCE = /^[A-Za-z0-9._/-]{0,100}$/;

const aheadKey = (headId: string, periodKey: string) => `${headId}|${periodKey}`;

/**
 * Apply: the child's open dues and periods ahead (as the counter picks them), the amount to apply
 * (the smaller of the money and what is ticked), and when less than the money, how the rest was
 * given back (P7b-E). The receipt is made on the day SSLCommerz took the money (P7b-F).
 */
export function ApplyDialog({
  item,
  onClose,
}: {
  item: OnlinePaymentStaffView;
  onClose: () => void;
}) {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const refresh = useRefreshOnline();
  const dueName = useDueName();
  const period = usePeriodLabel();
  const describe = useDecisionError();
  const id = useId();
  // The money still to decide: a refund recorded before (kept after a void) stays given back.
  const money = Math.max(
    0,
    (item.money?.amountPaisa ?? 0) - (item.refundedOutside?.amountPaisa ?? 0),
  );
  // One id for this decision: a retry after a lost answer returns the same receipt.
  const [requestId] = useState(randomId);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [ahead, setAhead] = useState<Set<string>>(() => new Set());
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  /** What the server said the ticked dues owe on the payment day (after a 409). */
  const [serverOwed, setServerOwed] = useState<number | null>(null);

  const ledger = useQuery({
    queryKey: ['fees', 'ledger', session?.tenant?.id, item.student.id],
    queryFn: () => client.api<FeeLedger>(`/fees/students/${item.student.id}/ledger`),
  });
  const open = (ledger.data?.dues ?? []).filter((d) => d.status === 'OPEN' && d.balance.total > 0);
  const upcoming = ledger.data?.upcoming ?? [];
  // Until the admin changes it: the payment's own dues that still owe something.
  const chosen =
    picked ?? new Set(open.filter((d) => item.dues.some((x) => x.id === d.id)).map((d) => d.id));
  const pickedSum =
    open.filter((d) => chosen.has(d.id)).reduce((sum, d) => sum + d.balance.total, 0) +
    upcoming
      .filter((u) => ahead.has(aheadKey(u.headId, u.periodKey)))
      .reduce((sum, u) => sum + u.amountPaisa - u.concessionPaisa, 0);
  const owed = serverOwed ?? pickedSum;
  const applying = amount ?? Math.min(money, owed);
  const remainder = money - applying;
  const count = chosen.size + ahead.size;
  const referenceOk = REFERENCE.test(reference.trim());
  const valid =
    count > 0 &&
    applying >= 1 &&
    applying <= money &&
    applying <= owed &&
    referenceOk &&
    note.trim().length >= 3;

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setServerOwed(null);
    setAmount(null);
    return next;
  };

  const apply = useMutation({
    mutationFn: () =>
      client.api<FeeReceipt>(`/fees/online-payments/${item.id}/apply`, {
        method: 'POST',
        json: {
          dueIds: [...chosen],
          advance: [...ahead].map((k) => {
            const [headId, periodKey] = k.split('|') as [string, string];
            return { headId, periodKey };
          }),
          applyPaisa: applying,
          expectedOutstandingPaisa: owed,
          ...(remainder > 0 ? { refundOutside: { reference: reference.trim() || null } } : {}),
          note: note.trim(),
          clientRequestId: requestId,
        },
      }),
    onSuccess: (receipt) => {
      toast.success(t('applied', { number: receipt.receiptNumber }));
      refresh();
      onClose();
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'ALREADY_RESOLVED' || e.code === 'PAYMENT_VOIDED') {
        // Decided elsewhere, or this request's payment voided since: reload the item.
        toast.error(
          e.code === 'PAYMENT_VOIDED' ? t('err.PAYMENT_VOIDED') : t('err.ALREADY_RESOLVED'),
        );
        refresh();
        onClose();
      } else if (e.code === 'DUES_CHANGED') {
        // What they owe on the payment day (its fines): the admin confirms again with it.
        const outstanding = (e.body as { outstandingPaisa?: number } | undefined)?.outstandingPaisa;
        if (typeof outstanding === 'number') setServerOwed(outstanding);
      } else if (e.code === 'DUE_COLLECTED') {
        // Collected meanwhile (at the counter): the dues again as they are now, ticked afresh.
        void ledger.refetch();
        setPicked(null);
        setServerOwed(null);
        setAmount(null);
      }
    },
  });
  const submit = () => {
    setTried(true);
    if (valid) apply.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        data-testid="review-apply-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('applyTitle', { amount: formatTaka(money, locale) })}</DialogTitle>
          <DialogDescription>
            {pick(locale, item.student)} · {t('applyIntro')}
          </DialogDescription>
        </DialogHeader>
        {ledger.isPending ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : ledger.isError ? (
          <LoadError message={describe(ledger.error)} onRetry={() => void ledger.refetch()} />
        ) : (
          <>
            {open.length + upcoming.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('applyNone')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {open.length > 0 && (
                  <PickList
                    title={t('applyDues')}
                    items={open.map((d) => ({
                      key: d.id,
                      label: dueName(d),
                      amount: d.balance.total,
                    }))}
                    checked={(k) => chosen.has(k)}
                    onToggle={(k) => setPicked(toggle(chosen, k))}
                  />
                )}
                {upcoming.length > 0 && (
                  <PickList
                    title={t('applyAhead')}
                    items={upcoming.map((u) => ({
                      key: aheadKey(u.headId, u.periodKey),
                      label: `${pick(locale, u.head)} · ${period(u)}`,
                      amount: u.amountPaisa - u.concessionPaisa,
                    }))}
                    checked={(k) => ahead.has(k)}
                    onToggle={(k) => setAhead(toggle(ahead, k))}
                  />
                )}
              </div>
            )}
            <p className="text-sm" aria-live="polite" data-testid="review-apply-owed">
              {t('applyOwed', { amount: formatTaka(owed, locale) })}
            </p>
            <MoneyField
              id={`${id}-amount`}
              label={t('applyAmount')}
              valuePaisa={applying}
              onChange={setAmount}
              hint={t('applyAmountHint', { money: formatTaka(money, locale) })}
              error={
                applying > money
                  ? t('err.AMOUNT_EXCEEDS_MONEY')
                  : applying > owed
                    ? t('err.AMOUNT_EXCEEDS_DUE')
                    : null
              }
              testId="review-apply-amount"
            />
            {remainder > 0 && applying >= 1 && (
              <div className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-lg border p-3">
                <p className="text-sm font-medium" data-testid="review-apply-remainder">
                  {t('applyRemainder', { amount: formatTaka(remainder, locale) })}
                </p>
                <TextField
                  id={`${id}-ref`}
                  label={t('refundReference')}
                  value={reference}
                  onChange={setReference}
                  hint={t('refundReferenceHint')}
                  error={referenceOk ? null : t('refundReferenceInvalid')}
                />
              </div>
            )}
            <NoteField
              value={note}
              onChange={setNote}
              tried={tried}
              label={remainder > 0 ? t('noteWithRefund') : undefined}
            />
          </>
        )}
        {apply.isError &&
          !(apply.error instanceof ApiError && apply.error.code === 'ALREADY_RESOLVED') && (
            <Alert variant="destructive">
              <AlertDescription>{describe(apply.error)}</AlertDescription>
            </Alert>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('notNow')}
          </Button>
          <Button
            onClick={submit}
            disabled={apply.isPending || !ledger.data || (tried && !valid)}
            data-testid="review-apply-confirm"
          >
            {t('applyConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickList({
  title,
  items,
  checked,
  onToggle,
}: {
  title: string;
  items: { key: string; label: string; amount: number }[];
  checked: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const locale = useLocale() as Locale;
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-sm" id={id}>
        {title}
      </p>
      <ul className="flex flex-col rounded-lg border" aria-labelledby={id}>
        {items.map((item) => (
          <li key={item.key} className="border-b last:border-0">
            <Label className="hover:bg-muted/60 flex min-h-(--control-h) cursor-pointer items-center gap-3 px-3 py-2 leading-normal font-normal">
              <input
                type="checkbox"
                className="accent-primary size-4.5 shrink-0"
                checked={checked(item.key)}
                onChange={() => onToggle(item.key)}
                data-testid="review-apply-pick"
              />
              <span className="min-w-0 flex-1">{item.label}</span>
              <span className="font-numeric shrink-0">{formatTaka(item.amount, locale)}</span>
            </Label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Refunded outside (an intent or a money item): the whole money was given back outside the app
 * (SSLCommerz's panel or by hand). Final (P7b-N).
 */
export function RefundDialog({
  target,
  amountPaisa,
  onClose,
}: {
  target: { kind: 'intent'; id: string } | { kind: 'signal'; eventId: string };
  amountPaisa: number | null;
  onClose: () => void;
}) {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const refresh = useRefreshOnline();
  const describe = useDecisionError();
  const id = useId();
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [tried, setTried] = useState(false);
  const referenceOk = REFERENCE.test(reference.trim());
  const path =
    target.kind === 'intent'
      ? `/fees/online-payments/${target.id}/refunded-outside`
      : `/fees/online-payments/signals/${target.eventId}/refunded-outside`;
  const refund = useMutation({
    mutationFn: () =>
      client.api(path, {
        method: 'POST',
        json: { note: note.trim(), reference: reference.trim() || null },
      }),
    onSuccess: () => {
      toast.success(t('refunded'));
      refresh();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ALREADY_RESOLVED') {
        toast.error(t('err.ALREADY_RESOLVED'));
        refresh();
        onClose();
      }
    },
  });
  const submit = () => {
    setTried(true);
    if (note.trim().length >= 3 && referenceOk) refund.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="review-refund-dialog">
        <DialogHeader>
          <DialogTitle>
            {t('refundTitle', {
              amount: amountPaisa !== null ? formatTaka(amountPaisa, locale) : '—',
            })}
          </DialogTitle>
          <DialogDescription>{t('refundIntro')}</DialogDescription>
        </DialogHeader>
        <TextField
          id={`${id}-ref`}
          label={t('refundReference')}
          value={reference}
          onChange={setReference}
          hint={t('refundReferenceHint')}
          error={referenceOk ? null : t('refundReferenceInvalid')}
        />
        <NoteField value={note} onChange={setNote} tried={tried} />
        {refund.isError &&
          !(refund.error instanceof ApiError && refund.error.code === 'ALREADY_RESOLVED') && (
            <Alert variant="destructive">
              <AlertDescription>{describe(refund.error)}</AlertDescription>
            </Alert>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('notNow')}
          </Button>
          <Button onClick={submit} disabled={refund.isPending} data-testid="review-refund-confirm">
            {t('refundConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dismiss: an intent that holds no money (after a check found nothing), or a repeat record of
 * money held elsewhere. Money itself is never dismissed (P7b-E).
 */
export function DismissDialog({
  target,
  onClose,
}: {
  target: { kind: 'intent'; id: string } | { kind: 'signal'; eventId: string };
  onClose: () => void;
}) {
  const t = useTranslations('fees.review');
  const { client } = useAuth();
  const refresh = useRefreshOnline();
  const describe = useDecisionError();
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const path =
    target.kind === 'intent'
      ? `/fees/online-payments/${target.id}/dismiss`
      : `/fees/online-payments/signals/${target.eventId}/dismiss`;
  const dismiss = useMutation({
    mutationFn: () => client.api(path, { method: 'POST', json: { note: note.trim() } }),
    onSuccess: () => {
      toast.success(t('dismissed'));
      refresh();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ALREADY_RESOLVED') {
        toast.error(t('err.ALREADY_RESOLVED'));
        refresh();
        onClose();
      }
    },
  });
  const submit = () => {
    setTried(true);
    if (note.trim().length >= 3) dismiss.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="review-dismiss-dialog">
        <DialogHeader>
          <DialogTitle>{t('dismissTitle')}</DialogTitle>
          <DialogDescription>
            {target.kind === 'intent' ? t('dismissIntro') : t('dismissRepeatIntro')}
          </DialogDescription>
        </DialogHeader>
        <NoteField value={note} onChange={setNote} tried={tried} />
        {dismiss.isError &&
          !(dismiss.error instanceof ApiError && dismiss.error.code === 'ALREADY_RESOLVED') && (
            <Alert variant="destructive">
              <AlertDescription>{describe(dismiss.error)}</AlertDescription>
            </Alert>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('notNow')}
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={dismiss.isPending}
            data-testid="review-dismiss-confirm"
          >
            {t('dismissConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Unmatched IPNs SSLCommerz said were not this store's payments (not items; 30 days). */
export function CheckedNotPayments({
  checked,
}: {
  checked: { eventId: string; receivedAt: string; tranId: string | null }[];
}) {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  if (checked.length === 0) return null;
  return (
    <details
      className="bg-card rounded-card border px-(--panel-p) py-3"
      data-testid="review-checked"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t('checkedTitle', { count: formatCount(checked.length, locale), n: checked.length })}
      </summary>
      <p className="text-muted-foreground mt-2 text-sm">{t('checkedHint')}</p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {checked.map((c) => (
          <li key={c.eventId} className={cn('flex flex-wrap gap-x-3')}>
            <span>
              {formatDate(c.receivedAt, locale, 'medium')}, {formatTime(c.receivedAt, locale)}
            </span>
            <Ident value={c.tranId} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A link to the queue from the list page, with how many items wait. */
export function ReviewLink({ count }: { count: number }) {
  const t = useTranslations('fees.online');
  const locale = useLocale() as Locale;
  return (
    <Link
      href="/fees/online-payments/review"
      className="text-link text-sm font-medium"
      data-testid="online-review-link"
    >
      {t('reviewLink', { count: formatCount(count, locale), n: count })}
    </Link>
  );
}
