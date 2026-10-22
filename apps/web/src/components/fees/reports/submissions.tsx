'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBdPhone,
  formatDate,
  formatIdentifier,
  formatTaka,
  type FeeLedger,
  type FeeReceipt,
  type FeeSubmissionView,
} from '@jantrik/shared';
import { PrinterIcon, ReceiptTextIcon, SmartphoneIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Receipt } from '@/components/fees/receipt';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
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
import { isDialable, LoadError, PhoneText, SubmissionStatusPill, TrxId, useDueName } from './kit';

/*
 * The bKash/Nagad review queue (docs/fees.md → Manual bKash/Nagad): one card per transfer, with
 * everything the reviewer needs to find it in the institute's own app (TrxID, sender, the
 * number it was sent to, the date), and the two decisions: verify (a receipt) or return (a
 * reason the guardian sees).
 */

/** The submissions list and the dashboard figure: refreshed after every decision. */
export const submissionKeys = {
  all: (tenantId: string | undefined) => ['fee-submissions', tenantId] as const,
  list: (tenantId: string | undefined, status: string) =>
    ['fee-submissions', tenantId, status] as const,
  summary: (tenantId: string | undefined) => ['fee-summary', tenantId] as const,
};

function useRefreshAfterReview() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const tenantId = session?.tenant?.id;
  return (studentId?: string) => {
    void queryClient.invalidateQueries({ queryKey: submissionKeys.all(tenantId) });
    void queryClient.invalidateQueries({ queryKey: submissionKeys.summary(tenantId) });
    if (studentId) {
      void queryClient.invalidateQueries({ queryKey: ['fee-ledger', tenantId, studentId] });
    }
  };
}

export function SubmissionCard({
  submission: s,
  onVerify,
  onReject,
  onViewReceipt,
}: {
  submission: FeeSubmissionView;
  onVerify: () => void;
  onReject: () => void;
  onViewReceipt: () => void;
}) {
  const t = useTranslations('fees.reports.submissions');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const dueName = useDueName();
  const name = pick(locale, s.student) || formatIdentifier(s.student.studentCode);
  const pending = s.status === 'PENDING';
  return (
    <li
      data-slot="card"
      data-testid="submission"
      data-trx={s.trxId}
      data-status={s.status}
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col border"
    >
      <div className="flex items-start justify-between gap-3 px-(--panel-p) pt-(--panel-p) pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="min-w-0 truncate py-0.5 leading-normal font-semibold">{name}</span>
          <span className="text-muted-foreground text-sm leading-normal">
            {s.student.classLevel && <>{pick(locale, s.student.classLevel)} · </>}
            <span className="whitespace-nowrap tabular-nums" dir="ltr">
              {formatIdentifier(s.student.studentCode)}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-numeric text-xl leading-tight font-semibold">
            {formatTaka(s.amountPaisa, locale)}
          </span>
          <Pill tone="neutral">
            <SmartphoneIcon aria-hidden className="size-3.5 shrink-0" />
            {tMethod(s.method)}
          </Pill>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 border-t px-(--panel-p) py-3 text-sm">
        <dt className="text-muted-foreground">{t('trxId')}</dt>
        <dd className="min-w-0">
          <TrxId trxId={s.trxId} />
        </dd>
        <dt className="text-muted-foreground">{t('sender')}</dt>
        <dd>
          <PhoneText phone={s.senderPhone} />
        </dd>
        <dt className="text-muted-foreground">{t('sentTo')}</dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <PhoneText phone={s.account.phone} className="font-medium" />
          {s.account.label && <span className="text-muted-foreground">{s.account.label}</span>}
        </dd>
        <dt className="text-muted-foreground">{t('sentOn')}</dt>
        <dd>{formatDate(s.sentOn, locale, 'long')}</dd>
        <dt className="text-muted-foreground">{t('forDues')}</dt>
        <dd className="min-w-0">
          <ul className="flex flex-wrap gap-1">
            {s.dues.map((d) => (
              <li key={d.id}>
                <Pill tone="neutral" className="text-foreground whitespace-normal">
                  {dueName(d)}
                </Pill>
              </li>
            ))}
          </ul>
        </dd>
      </dl>

      {!pending && (
        <div className="flex flex-col gap-2 border-t px-(--panel-p) py-3 text-sm">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <SubmissionStatusPill status={s.status} />
            {s.reviewedAt && (
              <span className="text-muted-foreground">
                {t('reviewedOn', { date: formatDate(s.reviewedAt, locale, 'long') })}
              </span>
            )}
          </span>
          {s.rejectReason && (
            <p>
              <span className="text-muted-foreground">{t('rejectReason')}: </span>
              {s.rejectReason}
            </p>
          )}
          {s.receipt && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onViewReceipt}
              data-testid="submission-receipt"
            >
              <ReceiptTextIcon aria-hidden />
              {t('viewReceipt', { number: s.receipt.receiptNumber })}
            </Button>
          )}
        </div>
      )}

      <p className="text-muted-foreground border-t px-(--panel-p) py-2 text-xs">
        {s.submitter === 'GUARDIAN' ? t('byGuardian') : t('byStaff')}
      </p>

      {pending && (
        <div className="mt-auto flex gap-2 border-t p-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onReject}
            data-testid="submission-reject"
          >
            {t('reject')}
          </Button>
          <Button className="flex-1" onClick={onVerify} data-testid="submission-verify">
            {t('verify')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** One fact in a dialog's summary. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </>
  );
}

const aheadKey = (headId: string, periodKey: string) => `${headId}|${periodKey}`;

/**
 * Verify: first the reminder to find the TrxID in the institute's own app. When the dues it was
 * sent for have been paid meanwhile (422), the student's ledger opens here to choose others (or
 * months ahead), and the reviewer can still return it instead.
 */
export function VerifyDialog({
  submission: s,
  onClose,
  onReject,
}: {
  submission: FeeSubmissionView;
  onClose: () => void;
  onReject: () => void;
}) {
  const t = useTranslations('fees.reports.submissions');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const refresh = useRefreshAfterReview();
  const period = usePeriodLabel();
  const dueName = useDueName();
  const formId = useId();
  // One id for this decision: a retry after a lost answer returns the same receipt.
  const [requestId] = useState(randomId);
  const [repick, setRepick] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [ahead, setAhead] = useState<Set<string>>(() => new Set());
  const queryClient = useQueryClient();
  const ledgerKey = ['fee-ledger', tenantId, s.student.id];

  const ledger = useQuery({
    queryKey: ledgerKey,
    queryFn: () => client.api<FeeLedger>(`/fees/students/${s.student.id}/ledger`),
    enabled: repick,
  });
  const open = (ledger.data?.dues ?? []).filter((d) => d.status === 'OPEN' && d.balance.total > 0);
  const upcoming = ledger.data?.upcoming ?? [];
  // Until the reviewer changes it: the dues it was sent for that are still open.
  const chosen =
    picked ?? new Set(open.filter((d) => s.dues.some((x) => x.id === d.id)).map((d) => d.id));
  const pickedSum =
    open.filter((d) => chosen.has(d.id)).reduce((sum, d) => sum + d.balance.total, 0) +
    upcoming
      .filter((u) => ahead.has(aheadKey(u.headId, u.periodKey)))
      .reduce((sum, u) => sum + u.amountPaisa - u.concessionPaisa, 0);
  const pickedCount = chosen.size + ahead.size;
  const enough = pickedCount > 0 && pickedCount <= 24 && pickedSum >= s.amountPaisa;

  const verify = useMutation({
    mutationFn: () =>
      client.api<FeeReceipt>(`/fees/submissions/${s.id}/verify`, {
        method: 'POST',
        json: repick
          ? {
              clientRequestId: requestId,
              dueIds: [...chosen],
              advance: [...ahead].map((k) => {
                const [headId, periodKey] = k.split('|') as [string, string];
                return { headId, periodKey };
              }),
            }
          : { clientRequestId: requestId },
      }),
    onSuccess: (receipt) => {
      toast.success(t('verified', { number: receipt.receiptNumber }));
      refresh(s.student.id);
      onClose();
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'ALREADY_REVIEWED') {
        toast.error(t('errAlreadyReviewed'));
        refresh(s.student.id);
        onClose();
      } else if (e.code === 'AMOUNT_EXCEEDS_DUE' || e.code === 'NOTHING_DUE') {
        // A ledger loaded earlier is out of date now: fetched afresh when the list opens.
        void queryClient.invalidateQueries({ queryKey: ledgerKey, refetchType: 'none' });
        setRepick(true);
      }
    },
  });
  const err = verify.error;
  const code = err instanceof ApiError ? err.code : undefined;
  const errorText =
    !err || verify.isPending
      ? null
      : code === 'TRX_ID_USED'
        ? t('errTrxUsed')
        : code === 'AMOUNT_EXCEEDS_DUE' || code === 'NOTHING_DUE'
          ? null
          : describe(err);
  const amount = formatTaka(s.amountPaisa, locale);
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        data-testid="submission-verify-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('verifyTitle', { amount })}</DialogTitle>
          <DialogDescription>
            {pick(locale, s.student)}
            {s.student.classLevel && ` · ${pick(locale, s.student.classLevel)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="border-warning/40 bg-warning-soft flex gap-3 rounded-lg border p-3">
          <SmartphoneIcon aria-hidden className="text-warning mt-0.5 size-5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">{t('verifyCheckTitle')}</p>
            <p className="text-sm">
              {t('verifyCheck', {
                method: tMethod(s.method),
                account: isDialable(s.account.phone)
                  ? formatBdPhone(s.account.phone)
                  : s.account.phone,
              })}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
          <Fact term={t('trxId')}>
            <span className="font-mono text-base font-semibold tracking-wide select-all" dir="ltr">
              {s.trxId}
            </span>
          </Fact>
          <Fact term={t('amount')}>
            <span className="font-numeric">{amount}</span>
            <span className="text-muted-foreground font-normal"> · {tMethod(s.method)}</span>
          </Fact>
          <Fact term={t('sender')}>
            <PhoneText phone={s.senderPhone} />
          </Fact>
          <Fact term={t('sentTo')}>
            <PhoneText phone={s.account.phone} />
          </Fact>
          <Fact term={t('sentOn')}>{formatDate(s.sentOn, locale, 'long')}</Fact>
          {!repick && <Fact term={t('forDues')}>{s.dues.map((d) => dueName(d)).join(', ')}</Fact>}
        </dl>

        {repick && (
          <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${formId}-why`}>
            <legend className="mb-1 font-semibold">{t('repickTitle')}</legend>
            <Alert variant="destructive" id={`${formId}-why`}>
              <AlertDescription>{t('errAmountExceeds')}</AlertDescription>
            </Alert>
            {ledger.isPending ? (
              <Skeleton className="h-28 w-full rounded-lg" />
            ) : ledger.isError ? (
              <LoadError error={ledger.error} onRetry={() => void ledger.refetch()} />
            ) : open.length + upcoming.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('repickNone')}</p>
            ) : (
              <>
                {open.length > 0 && (
                  <PickList
                    title={t('repickDues')}
                    items={open.map((d) => ({
                      key: d.id,
                      label: dueName(d),
                      amount: d.balance.total,
                      overdue: d.overdue,
                    }))}
                    checked={(k) => chosen.has(k)}
                    onToggle={(k) => setPicked(toggle(chosen, k))}
                  />
                )}
                {upcoming.length > 0 && (
                  <PickList
                    title={t('repickAdvance')}
                    items={upcoming.map((u) => ({
                      key: aheadKey(u.headId, u.periodKey),
                      label: `${pick(locale, u.head)} · ${period(u)}`,
                      amount: u.amountPaisa - u.concessionPaisa,
                      overdue: false,
                    }))}
                    checked={(k) => ahead.has(k)}
                    onToggle={(k) => setAhead(toggle(ahead, k))}
                  />
                )}
                <p
                  className={cn('text-sm font-medium', !enough && 'text-destructive')}
                  aria-live="polite"
                >
                  {enough
                    ? t('repickSum', { picked: formatTaka(pickedSum, locale), amount })
                    : t('repickShort', { amount })}
                </p>
              </>
            )}
          </fieldset>
        )}

        {errorText && (
          <Alert variant="destructive">
            <AlertDescription>{errorText}</AlertDescription>
          </Alert>
        )}

        <p className="text-muted-foreground text-sm">{t('verifyAfter')}</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('notNow')}
          </Button>
          {(repick || code === 'TRX_ID_USED') && (
            <Button variant="destructive" onClick={onReject}>
              {t('reject')}
            </Button>
          )}
          <Button
            onClick={() => verify.mutate()}
            disabled={
              verify.isPending || code === 'TRX_ID_USED' || (repick && (!ledger.data || !enough))
            }
            data-testid="submission-verify-confirm"
          >
            {t('verifyConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Dues to tick, each a full-width row (the label is the target), with what it still owes. */
function PickList({
  title,
  items,
  checked,
  onToggle,
}: {
  title: string;
  items: { key: string; label: string; amount: number; overdue: boolean }[];
  checked: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const t = useTranslations('fees.reports.submissions');
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
              />
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.overdue && <Pill tone="destructive">{t('overdue')}</Pill>}
              <span className="font-numeric shrink-0">{formatTaka(item.amount, locale)}</span>
            </Label>
          </li>
        ))}
      </ul>
    </div>
  );
}

const textareaClass =
  'min-h-24 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-(length:--input-fs) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-destructive';

/** Return: the reason is required (3+ characters) and the guardian sees it. */
export function RejectDialog({
  submission: s,
  onClose,
}: {
  submission: FeeSubmissionView;
  onClose: () => void;
}) {
  const t = useTranslations('fees.reports.submissions');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client } = useAuth();
  const refresh = useRefreshAfterReview();
  const id = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const short = reason.trim().length < 3;
  const reject = useMutation({
    mutationFn: () =>
      client.api<FeeSubmissionView>(`/fees/submissions/${s.id}/reject`, {
        method: 'POST',
        json: { reason: reason.trim() },
      }),
    onSuccess: () => {
      toast.success(t('rejected'));
      refresh();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ALREADY_REVIEWED') {
        toast.error(t('errAlreadyReviewed'));
        refresh();
        onClose();
      }
    },
  });
  const submit = () => {
    setTried(true);
    if (!short) reject.mutate();
  };
  const fieldError = tried && short ? t('rejectShort') : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="submission-reject-dialog">
        <DialogHeader>
          <DialogTitle>{t('rejectTitle')}</DialogTitle>
          <DialogDescription>{t('rejectBody')}</DialogDescription>
        </DialogHeader>
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{pick(locale, s.student)}</span>
          <span className="font-numeric">{formatTaka(s.amountPaisa, locale)}</span>
          <span className="font-mono" dir="ltr">
            {s.trxId}
          </span>
        </p>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Label htmlFor={id}>
            {t('rejectReason')}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <textarea
            id={id}
            className={textareaClass}
            value={reason}
            maxLength={500}
            required
            placeholder={t('rejectPlaceholder')}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
            data-testid="submission-reject-reason"
          />
          {fieldError && (
            <p id={`${id}-error`} className="text-destructive text-sm" role="alert">
              {fieldError}
            </p>
          )}
        </form>
        {reject.isError &&
          !(reject.error instanceof ApiError && reject.error.code === 'ALREADY_REVIEWED') && (
            <Alert variant="destructive">
              <AlertDescription>{describe(reject.error)}</AlertDescription>
            </Alert>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('notNow')}
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={reject.isPending}
            data-testid="submission-reject-confirm"
          >
            {t('rejectConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A verified transfer's receipt, as the counter prints it. */
export function ReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: { id: string; receiptNumber: string };
  onClose: () => void;
}) {
  const t = useTranslations('fees.reports.submissions');
  const { client, session } = useAuth();
  const query = useQuery({
    queryKey: ['fee-receipt', session?.tenant?.id, receipt.id],
    queryFn: () => client.api<FeeReceipt>(`/fees/payments/${receipt.id}`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-x-2">
            {t('receipt')}
            <span className="font-mono" dir="ltr">
              {receipt.receiptNumber}
            </span>
          </DialogTitle>
        </DialogHeader>
        {query.isPending ? (
          <Skeleton className="h-96 w-full rounded-lg" />
        ) : query.isError ? (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <div className="overflow-x-auto">
            <Receipt receipt={query.data} />
          </div>
        )}
        {/* Printing (A5 or thermal) is done from the receipt's own page. */}
        <DialogFooter>
          <ButtonLink variant="outline" href={`/fees/receipts/${receipt.id}`}>
            <PrinterIcon aria-hidden />
            {t('openReceipt')}
          </ButtonLink>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
