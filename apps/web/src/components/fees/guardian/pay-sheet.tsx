'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  formatBdPhone,
  formatCount,
  formatTaka,
  normalizeBdPhone,
  normalizeTrxId,
  type FeeDueView,
  type FeeGuardianView,
  type FeeMobileMethod,
  type FeeSubmissionInput,
  type FeeSubmissionView,
} from '@jantrik/shared';
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { Field } from '@/components/form-kit';
import { MoneyField } from '@/components/fees/money-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { Locale } from '@/i18n/config';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { randomId } from '@/lib/uuid';
import { SubmissionStatusPill } from './status-pills';
import {
  childFeesKey,
  isOwed,
  MAX_DUES_PER_SUBMISSION,
  MAX_PENDING_PER_CHILD,
  pendingDueIds,
} from './use-child-fees';
import { useVisualViewport } from './use-visual-viewport';

type Account = FeeGuardianView['accounts'][number];
type FieldKey = 'account' | 'dues' | 'amount' | 'trx' | 'sender';
type Problems = Partial<Record<FieldKey | 'form', string>>;

/** "+8801712345678" → "01712345678": what people type into the bKash/Nagad app. */
const dialDigits = (phone: string) =>
  phone.startsWith('+880') ? `0${phone.slice(4)}` : phone.replace(/^\+/, '');
const showNumber = (phone: string) => (phone.startsWith('+') ? formatBdPhone(phone) : phone);

/** Copy text; falls back to a hidden textarea where the Clipboard API is missing (plain http). */
async function copyText(text: string, near: HTMLElement): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
  // Next to the button, inside the sheet: the dialog keeps focus within itself.
  (near.parentElement ?? document.body).appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  near.focus();
  return ok;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations('fees.guardian.pay');
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  return (
    <Button
      type="button"
      variant="outline"
      className="shrink-0"
      aria-label={label}
      onClick={async (e) => {
        const ok = await copyText(text, e.currentTarget);
        if (!ok) {
          toast.error(t('copyFailed'));
          return;
        }
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2500);
      }}
    >
      {copied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
      <span aria-live="polite">{copied ? t('copied') : t('copy')}</span>
    </Button>
  );
}

/** The dues ticked at first: the overdue ones not already waiting in a submission, else all. */
function defaultDues(owed: FeeDueView[], pending: Set<string>): string[] {
  const free = owed.filter((d) => !pending.has(d.id));
  const late = free.filter((d) => d.overdue);
  return (late.length > 0 ? late : free).slice(0, MAX_DUES_PER_SUBMISSION).map((d) => d.id);
}

/** The number used last time (if still active), else the first. */
function defaultAccount(view: FeeGuardianView): Account | undefined {
  const last = view.submissions[0]?.account.id;
  return view.accounts.find((a) => a.id === last) ?? view.accounts[0];
}

/** A radio or checkbox with its whole row as the target (44 px on touch), ticked in the accent. */
function ChoiceRow({
  children,
  className,
  disabled,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'bg-card flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
        'has-checked:border-primary-ink has-checked:bg-primary-soft',
        'has-focus-visible:ring-ring has-focus-visible:ring-3',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      {children}
    </label>
  );
}

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="text-destructive text-sm" role="alert">
      {children}
    </p>
  );
}

/**
 * "I paid by bKash/Nagad": a bottom sheet in two steps. First the institute's numbers to send
 * money to (with a copy button and how to send: Send Money to a personal number, Payment to a
 * merchant, Cash Out to an agent); then what was sent: the number, the fees, the amount, the
 * TrxID and the sender's number. The institute checks it and sends the receipt by SMS.
 */
export function PaySheet({
  open,
  onOpenChange,
  childId,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  childId: string;
  view: FeeGuardianView;
}) {
  const t = useTranslations('fees.guardian.pay');
  const vp = useVisualViewport(open);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-2xl p-0 sm:rounded-2xl sm:border sm:data-[side=bottom]:bottom-4"
        // Above the on-screen keyboard, and never taller than what can be seen.
        style={{
          bottom: vp.keyboard > 0 ? vp.keyboard : undefined,
          maxHeight: vp.height > 0 ? Math.round(vp.height * 0.94) : undefined,
        }}
        data-testid="pay-sheet"
      >
        <SheetTitle className="px-4 pt-4 pe-14 text-lg">{t('title')}</SheetTitle>
        {/* The popup unmounts when closed, so every opening starts afresh. */}
        <PayFlow childId={childId} view={view} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function PayFlow({
  childId,
  view,
  onClose,
}: {
  childId: string;
  view: FeeGuardianView;
  onClose: () => void;
}) {
  const t = useTranslations('fees.guardian.pay');
  const tMethod = useTranslations('fees.common.method');
  const tDues = useTranslations('fees.guardian.dues');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const f = (n: number) => formatCount(n, locale);

  const accounts = view.accounts;
  const methods = [...new Set(accounts.map((a) => a.method))];
  const owed = view.ledger.dues.filter(isOwed);
  const pending = pendingDueIds(view);

  const [step, setStep] = useState<1 | 2 | 'done'>(1);
  const [method, setMethod] = useState<FeeMobileMethod>(
    () => defaultAccount(view)?.method ?? 'BKASH',
  );
  const [accountId, setAccountId] = useState(() => defaultAccount(view)?.id ?? '');
  const [dueIds, setDueIds] = useState<string[]>(() => defaultDues(owed, pending));
  // undefined: follow the chosen dues' total; a number (or null while not an amount): typed.
  const [typedAmount, setTypedAmount] = useState<number | null | undefined>(undefined);
  const [trx, setTrx] = useState('');
  // The number this guardian sent from last time (their own submissions carry it in full).
  const [sender, setSender] = useState(() => {
    const own = view.submissions.find((s) => s.senderPhone.startsWith('+'));
    return own ? dialDigits(own.senderPhone) : '';
  });
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Problems>({});
  const [result, setResult] = useState<FeeSubmissionView | null>(null);
  /**
   * The id of an attempt whose outcome is unknown (no answer, or a 5xx: it may have been saved).
   * A retry of the same details reuses it, so the API answers with the saved submission instead
   * of "TrxID already used".
   */
  const retry = useRef<{ id: string; signature: string } | null>(null);
  const sendTitle = useRef<HTMLHeadingElement>(null);
  const formTitle = useRef<HTMLHeadingElement>(null);

  const account = accounts.find((a) => a.id === accountId);
  const chosen = owed.filter((d) => dueIds.includes(d.id));
  const chosenTotal = chosen.reduce((sum, d) => sum + d.balance.total, 0);
  const amount = typedAmount === undefined ? (chosenTotal > 0 ? chosenTotal : null) : typedAmount;
  const trxId = normalizeTrxId(trx);
  const senderPhone = normalizeBdPhone(sender);
  const atMax = dueIds.length >= MAX_DUES_PER_SUBMISSION;

  const local: Problems = {
    account: account ? undefined : t('accountRequired'),
    dues: chosen.length === 0 ? t('duesRequired') : undefined,
    amount:
      amount === null || amount <= 0
        ? t('amountRequired')
        : amount > chosenTotal
          ? t('amountTooMuch', { amount: taka(chosenTotal) })
          : undefined,
    trx: trxId ? undefined : t('trxInvalid'),
    sender: senderPhone ? undefined : t('senderInvalid'),
  };
  const problem = (key: FieldKey) => server[key] ?? (tried ? local[key] : undefined);
  const forget = (key: FieldKey) =>
    setServer((s) => (s[key] || s.form ? { ...s, [key]: undefined, form: undefined } : s));

  const submit = useMutation({
    mutationFn: (body: FeeSubmissionInput) =>
      client.api<FeeSubmissionView>(`/me/children/${childId}/fees/submissions`, {
        method: 'POST',
        json: body,
      }),
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: childFeesKey(session?.tenant?.id, childId) });

  /** The API's refusal in plain words, on the field it is about. */
  function explain(error: unknown): Problems {
    if (error instanceof ApiError) {
      const body = error.body as {
        outstandingPaisa?: number;
        errors?: { path: string }[];
      } | null;
      switch (error.code) {
        case 'TRX_ID_USED':
          return { trx: t('trxUsed') };
        case 'AMOUNT_EXCEEDS_DUE':
          refresh();
          return typeof body?.outstandingPaisa === 'number'
            ? { amount: t('errors.amountExceeds', { amount: taka(body.outstandingPaisa) }) }
            : { form: t('errors.changed') };
        case 'TOO_MANY_PENDING':
          refresh();
          return { form: t('errors.tooManyPending', { max: f(MAX_PENDING_PER_CHILD) }) };
        case 'ACCOUNT_INACTIVE':
          refresh();
          return { account: t('errors.accountInactive') };
      }
      if (error.status === 429) {
        const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60));
        return { form: t('errors.rateLimited', { minutes: f(minutes), n: minutes }) };
      }
      if (error.status === 404) {
        // A fee was paid or cancelled, or a number removed, since the page loaded.
        refresh();
        return { form: t('errors.changed') };
      }
      if (error.status === 400) {
        const out: Problems = {};
        for (const e of body?.errors ?? []) {
          const field = e.path.split('.')[0];
          if (field === 'trxId') out.trx = t('trxInvalid');
          else if (field === 'senderPhone') out.sender = t('senderInvalid');
          else if (field === 'amountPaisa') out.amount = t('amountRequired');
          else if (field === 'dueIds') out.dues = t('duesRequired');
          else if (field === 'accountId' || field === 'method') out.account = t('accountRequired');
        }
        return Object.keys(out).length > 0
          ? { ...out, form: t('errors.check') }
          : { form: describe(error) };
      }
    }
    return { form: describe(error) };
  }

  const fieldIds: Record<FieldKey, string | undefined> = {
    account: accounts[0] ? `pay-account-${accounts[0].id}` : undefined,
    dues: owed[0] ? `pay-due-${owed[0].id}` : undefined,
    amount: 'pay-amount-input',
    trx: 'pay-trx-input',
    sender: 'pay-sender-input',
  };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submit.isPending) return;
    setTried(true);
    const firstBad = (Object.keys(fieldIds) as FieldKey[]).find((k) => local[k]);
    if (firstBad || !account || !trxId || !senderPhone || amount === null) {
      const id = firstBad && fieldIds[firstBad];
      if (id) document.getElementById(id)?.focus();
      return;
    }
    const details = {
      method: account.method,
      accountId: account.id,
      amountPaisa: amount,
      trxId,
      senderPhone,
      dueIds: chosen.map((d) => d.id),
    };
    const signature = JSON.stringify(details);
    const clientRequestId = retry.current?.signature === signature ? retry.current.id : randomId();
    setServer({});
    submit.mutate(
      { ...details, clientRequestId },
      {
        onSuccess: (created) => {
          retry.current = null;
          setResult(created);
          setStep('done');
          refresh();
        },
        onError: (error) => {
          const unknownOutcome =
            error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
          retry.current = unknownOutcome ? { id: clientRequestId, signature } : null;
          setServer(explain(error));
        },
      },
    );
  }

  const go = (next: 1 | 2) => {
    flushSync(() => setStep(next));
    (next === 1 ? sendTitle : formTitle).current?.focus();
  };

  if (step === 'done' && result) {
    return <PaySuccess result={result} onClose={onClose} />;
  }

  const stepLabel = (n: number) => (
    <p className="text-muted-foreground text-sm">{t('step', { step: f(n), total: f(2) })}</p>
  );

  return (
    <>
      {/* Step 1: where to send the money. Kept mounted (hidden) so step 2 keeps what was typed. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={step !== 1}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
          <div className="flex flex-col gap-1">
            {stepLabel(1)}
            <h3 ref={sendTitle} tabIndex={-1} className="text-base font-semibold outline-none">
              {t('sendTitle')}
            </h3>
            <SheetDescription className="text-sm">{t('sendText')}</SheetDescription>
          </div>
          <ul className="flex flex-col gap-3">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="bg-card flex flex-col gap-2 rounded-xl border p-4"
                data-testid="pay-number"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-semibold">{tMethod(a.method)}</span>
                  {a.label && (
                    <span className="text-muted-foreground min-w-0 text-sm wrap-break-word">
                      {a.label}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <span
                    className="font-mono text-2xl font-semibold tracking-wide select-all"
                    dir="ltr"
                  >
                    {showNumber(a.phone)}
                  </span>
                  <CopyButton
                    text={dialDigits(a.phone)}
                    label={t('copyNumber', { number: showNumber(a.phone) })}
                  />
                </div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <SmartphoneIcon aria-hidden className="text-primary-ink size-4 shrink-0" />
                  {t(`kind.${a.kind}`)}
                </p>
              </li>
            ))}
          </ul>
          <div className="bg-muted flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl px-4 py-3">
            <p className="min-w-0 text-sm">
              {t('reference')}:{' '}
              <span className="font-mono font-semibold whitespace-nowrap" dir="ltr">
                {view.ledger.student.studentCode}
              </span>
            </p>
            <CopyButton
              text={view.ledger.student.studentCode}
              label={t('copyId', { id: view.ledger.student.studentCode })}
            />
          </div>
        </div>
        <div className="border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button size="lg" className="w-full" onClick={() => go(2)} data-testid="pay-next">
            {t('sent')}
          </Button>
        </div>
      </div>

      {/* Step 2: what was sent. */}
      <form
        className="flex min-h-0 flex-1 flex-col"
        hidden={step !== 2}
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="pay-form-title"
      >
        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-2 pb-4"
          // With the keyboard open, keep the field being typed in on screen.
          onFocus={(e) => {
            const el = e.target;
            if (el instanceof HTMLInputElement && el.type !== 'radio' && el.type !== 'checkbox') {
              window.setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 300);
            }
          }}
        >
          <div className="flex flex-col gap-1">
            {stepLabel(2)}
            <h3
              id="pay-form-title"
              ref={formTitle}
              tabIndex={-1}
              className="text-base font-semibold outline-none"
            >
              {t('formTitle')}
            </h3>
          </div>

          {/* Shown even with one method: it says which app the details are for. */}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('method')}</legend>
            <div className="flex flex-wrap gap-2">
              {methods.map((m) => (
                <ChoiceRow key={m} className="min-w-28 flex-1 sm:flex-none">
                  <input
                    type="radio"
                    name="pay-method"
                    value={m}
                    checked={method === m}
                    onChange={() => {
                      setMethod(m);
                      if (account?.method !== m) {
                        setAccountId(accounts.find((a) => a.method === m)?.id ?? '');
                      }
                      forget('account');
                    }}
                    className="accent-primary size-5 shrink-0"
                    data-testid="pay-method"
                  />
                  <span className="font-medium">{tMethod(m)}</span>
                </ChoiceRow>
              ))}
            </div>
          </fieldset>

          <fieldset
            className="flex min-w-0 flex-col gap-2"
            aria-describedby={problem('account') ? 'pay-account-error' : undefined}
          >
            <legend className="mb-2 text-sm font-medium">{t('account')}</legend>
            {/* Every number, each with its app: choosing one also chooses the method above. */}
            {accounts.map((a) => (
              <ChoiceRow key={a.id}>
                <input
                  id={`pay-account-${a.id}`}
                  type="radio"
                  name="pay-account"
                  value={a.id}
                  checked={accountId === a.id}
                  onChange={() => {
                    setAccountId(a.id);
                    setMethod(a.method);
                    forget('account');
                  }}
                  className="accent-primary size-5 shrink-0"
                  data-testid="pay-account"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono font-semibold" dir="ltr">
                    {showNumber(a.phone)}
                  </span>
                  <span className="text-muted-foreground text-sm wrap-break-word">
                    {[tMethod(a.method), a.label].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </ChoiceRow>
            ))}
            <FieldError id="pay-account-error">{problem('account')}</FieldError>
          </fieldset>

          <fieldset
            className="flex min-w-0 flex-col gap-2"
            aria-describedby={problem('dues') ? 'pay-dues-error' : 'pay-dues-hint'}
          >
            <legend className="mb-1 text-sm font-medium">{t('dues')}</legend>
            <p id="pay-dues-hint" className="text-muted-foreground text-sm">
              {t('duesHint')}
            </p>
            <ul className="flex flex-col gap-2">
              {owed.map((d) => {
                const checked = dueIds.includes(d.id);
                return (
                  <li key={d.id}>
                    <ChoiceRow disabled={!checked && atMax}>
                      <input
                        id={`pay-due-${d.id}`}
                        type="checkbox"
                        value={d.id}
                        checked={checked}
                        disabled={!checked && atMax}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setDueIds((ids) =>
                            on ? [...ids, d.id] : ids.filter((id) => id !== d.id),
                          );
                          forget('dues');
                          forget('amount');
                        }}
                        className="accent-primary size-5 shrink-0"
                        data-testid="pay-due"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium wrap-break-word">
                          {pick(locale, d.head)}
                          <span className="text-muted-foreground font-normal"> · {period(d)}</span>
                        </span>
                        {d.overdue && (
                          <span className="text-destructive flex items-center gap-1 text-xs font-medium">
                            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                            {tDues('status.OVERDUE')}
                          </span>
                        )}
                        {pending.has(d.id) && (
                          <span className="text-muted-foreground text-xs">{t('duePending')}</span>
                        )}
                      </span>
                      <span className="num shrink-0 font-medium">{taka(d.balance.total)}</span>
                    </ChoiceRow>
                  </li>
                );
              })}
            </ul>
            <p className="flex items-baseline justify-between gap-3 px-3 text-sm font-semibold">
              <span>{t('chosenTotal')}</span>
              <span className="num" data-testid="pay-chosen-total">
                {chosenTotal > 0 ? taka(chosenTotal) : '—'}
              </span>
            </p>
            {atMax && (
              <p className="text-muted-foreground text-sm">
                {t('duesMax', { max: f(MAX_DUES_PER_SUBMISSION) })}
              </p>
            )}
            <FieldError id="pay-dues-error">{problem('dues')}</FieldError>
          </fieldset>

          <MoneyField
            id="pay-amount-input"
            label={t('amount')}
            valuePaisa={amount}
            onChange={(paisa) => {
              setTypedAmount(paisa);
              forget('amount');
            }}
            hint={t('amountHint')}
            error={problem('amount')}
            required
            testId="pay-amount"
          />

          <Field
            id="pay-trx-input"
            label={t('trx')}
            hint={t('trxHint')}
            error={problem('trx')}
            required
          >
            <Input
              id="pay-trx-input"
              value={trx}
              onChange={(e) => {
                setTrx(e.target.value);
                forget('trx');
              }}
              required
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              dir="ltr"
              // Typed in any case and with spaces: the API normalises it (normalizeTrxId).
              className="font-mono tracking-wide uppercase"
              aria-invalid={problem('trx') ? true : undefined}
              aria-describedby={problem('trx') ? 'pay-trx-input-error' : 'pay-trx-input-hint'}
              data-testid="pay-trx"
            />
          </Field>

          <Field
            id="pay-sender-input"
            label={t('sender')}
            hint={t('senderHint')}
            error={problem('sender')}
            required
          >
            <Input
              id="pay-sender-input"
              value={sender}
              onChange={(e) => {
                setSender(e.target.value);
                forget('sender');
              }}
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              dir="ltr"
              className="font-mono"
              aria-invalid={problem('sender') ? true : undefined}
              aria-describedby={
                problem('sender') ? 'pay-sender-input-error' : 'pay-sender-input-hint'
              }
              data-testid="pay-sender"
            />
          </Field>
        </div>

        <div className="flex flex-col gap-3 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {server.form && (
            <Alert variant="destructive" data-testid="pay-error">
              <AlertDescription className="text-destructive">{server.form}</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => go(1)}
              disabled={submit.isPending}
            >
              {t('backStep')}
            </Button>
            <Button
              type="submit"
              size="lg"
              className="flex-1"
              disabled={submit.isPending}
              data-testid="pay-submit"
            >
              {submit.isPending ? t('submitting') : t('submit')}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

function PaySuccess({ result, onClose }: { result: FeeSubmissionView; onClose: () => void }) {
  const t = useTranslations('fees.guardian.pay');
  const tSub = useTranslations('fees.guardian.submissions');
  const locale = useLocale() as Locale;
  const title = useRef<HTMLHeadingElement>(null);
  // The submit button has gone: take focus to what happened.
  useEffect(() => title.current?.focus(), []);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center"
      data-testid="pay-success"
    >
      <span className="bg-success-soft text-success flex size-14 items-center justify-center rounded-2xl">
        <CircleCheckIcon aria-hidden className="size-7" />
      </span>
      <h3 ref={title} tabIndex={-1} className="text-xl font-semibold outline-none">
        {t('successTitle')}
      </h3>
      <SubmissionStatusPill status={result.status} />
      <p className="text-muted-foreground max-w-sm">{t('successText')}</p>
      <dl className="bg-muted grid w-full max-w-sm grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 rounded-xl px-4 py-3 text-start text-sm">
        <dt className="text-muted-foreground">{t('amount')}</dt>
        <dd className="num font-semibold">{formatTaka(result.amountPaisa, locale)}</dd>
        <dt className="text-muted-foreground">{tSub('trx')}</dt>
        <dd className="text-end font-mono font-semibold break-all" dir="ltr">
          {result.trxId}
        </dd>
      </dl>
      <Button size="lg" className="mt-2 w-full max-w-sm" onClick={onClose}>
        {t('done')}
      </Button>
    </div>
  );
}
