'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FEE_MOBILE_METHODS,
  formatBdPhone,
  formatCount,
  formatIdentifier,
  formatTaka,
  normalizeBdPhone,
  normalizeTrxId,
  toAsciiDigits,
  type FeeLedger,
  type FeeMobileAccountView,
  type FeeMobileMethod,
  type FeeStudentHit,
  type FeeSubmissionView,
} from '@jantrik/shared';
import { SearchIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Field, SelectField } from '@/components/form-kit';
import { MoneyField } from '@/components/fees/money-field';
import { Pill } from '@/components/kit/pill';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, useFeeRoles } from '@/lib/fees';
import { useDebounced, useErrorMessage, useLabel } from '@/lib/hooks';
import { randomId } from '@/lib/uuid';
import { LoadError, useDueName } from './kit';

/** The most dues one transfer may pay (staffSubmissionSchema). */
const MAX_DUES = 24;

/**
 * Staff record a transfer a guardian reported (by phone or at the desk): find the student,
 * tick the open dues it pays, then the institute's number, the amount, the TrxID and the
 * sender. It joins the queue as "waiting", to be matched in the institute's app and verified.
 */
export function RecordTransfer({
  onDone,
  onCancel,
}: {
  onDone: (submission: FeeSubmissionView) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('fees.reports.record');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const { isOwner } = useFeeRoles();
  const dueName = useDueName();
  const id = useId();
  // One id per form: a retry after a lost answer finds the submission it already made.
  const [requestId] = useState(randomId);

  const [student, setStudent] = useState<FeeStudentHit | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [method, setMethod] = useState<FeeMobileMethod>('BKASH');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [amountTouched, setAmountTouched] = useState(false);
  const [trx, setTrx] = useState('');
  const [sender, setSender] = useState('');
  const [tried, setTried] = useState(false);

  const ledger = useQuery({
    queryKey: ['fee-ledger', tenantId, student?.id],
    queryFn: () => client.api<FeeLedger>(`/fees/students/${student!.id}/ledger`),
    enabled: Boolean(student),
  });
  const accounts = useQuery({
    queryKey: ['fee-mobile-accounts', tenantId],
    queryFn: () => client.api<FeeMobileAccountView[]>('/fees/mobile-accounts'),
  });
  const forMethod = (accounts.data ?? []).filter((a) => a.isActive && a.method === method);
  // One number for the method: chosen for them.
  const account =
    forMethod.find((a) => a.id === accountId) ??
    (forMethod.length === 1 ? forMethod[0] : undefined);

  const open = (ledger.data?.dues ?? []).filter((d) => d.status === 'OPEN' && d.balance.total > 0);
  const pickedSum = open.filter((d) => picked.has(d.id)).reduce((s, d) => s + d.balance.total, 0);
  // The amount follows the chosen dues until the person types their own.
  const amountPaisa = amountTouched ? amount : pickedSum || null;
  const trxId = normalizeTrxId(trx);
  const senderPhone = normalizeBdPhone(sender);

  const errors = {
    dues: picked.size === 0 ? t('pickDues') : picked.size > MAX_DUES ? t('tooManyDues') : null,
    account: account ? null : t('accountRequired'),
    amount: !amountPaisa
      ? t('amountRequired')
      : amountPaisa > pickedSum && picked.size > 0
        ? t('amountTooMuch', { amount: formatTaka(pickedSum, locale) })
        : null,
    trx: trxId ? null : t('trxInvalid'),
    sender: senderPhone ? null : t('senderInvalid'),
  };

  const save = useMutation({
    mutationFn: () =>
      client.api<FeeSubmissionView>('/fees/submissions', {
        method: 'POST',
        json: {
          studentId: student!.id,
          method,
          accountId: account!.id,
          amountPaisa: amountPaisa!,
          trxId: trxId!,
          senderPhone: senderPhone!,
          dueIds: [...picked],
          clientRequestId: requestId,
        },
      }),
    onSuccess: (submission) => {
      toast.success(t('saved'));
      onDone(submission);
    },
  });
  const code = save.error instanceof ApiError ? save.error.code : undefined;
  const serverTrx = code === 'TRX_ID_USED' ? t('errTrxUsed') : null;
  const serverAmount =
    code === 'AMOUNT_EXCEEDS_DUE'
      ? t('errAmountExceeds', {
          amount: formatTaka(
            ((save.error as ApiError).body as { outstandingPaisa?: number } | undefined)
              ?.outstandingPaisa ?? pickedSum,
            locale,
          ),
        })
      : null;
  const serverOther =
    !save.error || serverTrx || serverAmount
      ? null
      : code === 'TOO_MANY_PENDING'
        ? t('errTooMany')
        : code === 'ACCOUNT_INACTIVE'
          ? t('errAccountInactive')
          : describe(save.error);

  const submit = () => {
    setTried(true);
    if (!student || Object.values(errors).some(Boolean)) return;
    save.mutate();
  };
  const show = (error: string | null) => (tried ? error : null);
  // What the server said is about the old values: gone once the person changes them.
  const edited = () => {
    if (save.isError) save.reset();
  };

  return (
    <section
      data-slot="card"
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-4 border p-(--panel-p)"
      aria-labelledby={`${id}-title`}
      data-testid="record-transfer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${id}-title`} className="text-base font-semibold">
            {t('title')}
          </h3>
          <p className="text-muted-foreground max-w-prose text-sm">{t('hint')}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t('cancel')} onClick={onCancel}>
          <XIcon aria-hidden />
        </Button>
      </div>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {student ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('student')}</span>
            <div className="bg-muted/60 flex items-center gap-3 rounded-xl px-3 py-2">
              <StudentLine student={student} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ms-auto shrink-0"
                onClick={() => {
                  setStudent(null);
                  setPicked(new Set());
                  setAmountTouched(false);
                }}
              >
                {t('change')}
              </Button>
            </div>
          </div>
        ) : (
          <StudentSearch
            label={t('student')}
            error={show(t('studentRequired'))}
            onPick={(s) => {
              setStudent(s);
              setPicked(new Set());
              setAmountTouched(false);
            }}
          />
        )}

        {student && (
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t('dues')}</legend>
            {ledger.isPending ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : ledger.isError ? (
              <LoadError error={ledger.error} onRetry={() => void ledger.refetch()} />
            ) : open.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noDues')}</p>
            ) : (
              <>
                <ul className="flex flex-col rounded-lg border">
                  {open.map((d) => (
                    <li key={d.id} className="border-b last:border-0">
                      <Label className="hover:bg-muted/60 flex min-h-(--control-h) cursor-pointer items-center gap-3 px-3 py-2 leading-normal font-normal">
                        <input
                          type="checkbox"
                          className="accent-primary size-4.5 shrink-0"
                          checked={picked.has(d.id)}
                          onChange={() => {
                            edited();
                            const next = new Set(picked);
                            if (next.has(d.id)) next.delete(d.id);
                            else next.add(d.id);
                            setPicked(next);
                          }}
                          data-testid="record-due"
                        />
                        <span className="min-w-0 flex-1">{dueName(d)}</span>
                        {d.overdue && (
                          <Pill tone="destructive" className="hidden sm:inline-flex">
                            {t('overdue')}
                          </Pill>
                        )}
                        <span className="font-numeric shrink-0">
                          {formatTaka(d.balance.total, locale)}
                        </span>
                      </Label>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-sm" aria-live="polite">
                  {picked.size > 0 &&
                    t('picked', {
                      count: formatCount(picked.size, locale),
                      n: picked.size,
                      amount: formatTaka(pickedSum, locale),
                    })}
                </p>
                {show(errors.dues) && (
                  <p className="text-destructive text-sm" role="alert">
                    {errors.dues}
                  </p>
                )}
              </>
            )}
          </fieldset>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span aria-hidden className="text-sm font-medium">
              {t('method')}
            </span>
            <SegmentedControl
              label={t('method')}
              value={method}
              onChange={(m) => {
                edited();
                setMethod(m);
                setAccountId('');
              }}
              options={FEE_MOBILE_METHODS.map((m) => ({ value: m, label: tMethod(m) }))}
              className="self-start"
              testId="record-method"
            />
          </div>
          {accounts.isPending ? (
            <Skeleton className="h-(--control-h) self-end rounded-md" />
          ) : accounts.isError ? (
            <LoadError error={accounts.error} onRetry={() => void accounts.refetch()} />
          ) : forMethod.length === 0 ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{t('account')}</span>
              <p className="text-muted-foreground">
                {t('noAccounts', { method: tMethod(method) })}{' '}
                {isOwner && (
                  <Link href="/fees/setup" className="text-link underline-offset-2 hover:underline">
                    {t('addAccounts')}
                  </Link>
                )}
              </p>
            </div>
          ) : (
            <SelectField
              id={`${id}-account`}
              label={t('account')}
              value={account?.id ?? ''}
              onChange={(v) => {
                edited();
                setAccountId(v);
              }}
              placeholder={forMethod.length > 1 ? t('accountPlaceholder') : undefined}
              required
              error={show(errors.account)}
              options={forMethod.map((a) => ({
                value: a.id,
                label: [formatBdPhone(a.phone), a.label].filter(Boolean).join(' · '),
              }))}
            />
          )}
          <MoneyField
            id={`${id}-amount`}
            label={t('amount')}
            valuePaisa={amountPaisa}
            onChange={(p) => {
              edited();
              setAmountTouched(true);
              setAmount(p);
            }}
            required
            error={serverAmount ?? show(errors.amount)}
            testId="record-amount"
          />
          <Field
            id={`${id}-trx`}
            label={t('trxId')}
            hint={t('trxHint')}
            error={serverTrx ?? show(errors.trx)}
            required
          >
            <Input
              id={`${id}-trx`}
              value={trx}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono tracking-wide uppercase"
              aria-invalid={Boolean(serverTrx ?? show(errors.trx)) || undefined}
              aria-describedby={`${id}-trx-${(serverTrx ?? show(errors.trx)) ? 'error' : 'hint'}`}
              onChange={(e) => {
                edited();
                setTrx(e.target.value);
              }}
              onBlur={() => trxId && setTrx(trxId)}
              data-testid="record-trx"
            />
          </Field>
          <Field
            id={`${id}-sender`}
            label={t('sender')}
            hint={t('senderHint')}
            error={show(errors.sender)}
            required
          >
            <Input
              id={`${id}-sender`}
              value={sender}
              dir="ltr"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              className="tabular-nums"
              aria-invalid={Boolean(show(errors.sender)) || undefined}
              aria-describedby={`${id}-sender-${show(errors.sender) ? 'error' : 'hint'}`}
              onChange={(e) => {
                edited();
                setSender(e.target.value);
              }}
              onBlur={() => senderPhone && setSender(formatBdPhone(senderPhone))}
              data-testid="record-sender"
            />
          </Field>
        </div>

        {serverOther && (
          <Alert variant="destructive">
            <AlertDescription>{serverOther}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending} data-testid="record-submit">
            {t('submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Name, class · section · roll and the ID: who this is, at a glance. */
function StudentLine({ student: s }: { student: FeeStudentHit }) {
  const locale = useLocale() as Locale;
  const label = useLabel();
  const tRoll = useTranslations('fees.reports.dues');
  const e = s.enrolment;
  const place = e
    ? [
        pick(locale, e.classLevel),
        e.section && `${label('section', 'Section')} ${e.section.name}`,
        e.roll != null && `${tRoll('roll')} ${formatIdentifier(e.roll)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate py-0.5 leading-normal font-semibold">
        {pick(locale, s) || formatIdentifier(s.studentCode)}
      </span>
      <span className="text-muted-foreground text-sm leading-normal">
        {place && <>{place} · </>}
        <span className="whitespace-nowrap tabular-nums" dir="ltr">
          {formatIdentifier(s.studentCode)}
        </span>
      </span>
    </span>
  );
}

/** Find the student by name, ID or roll (Bangla digits work); a full-row button each. */
function StudentSearch({
  label,
  error,
  onPick,
}: {
  label: string;
  error: string | null;
  onPick: (student: FeeStudentHit) => void;
}) {
  const t = useTranslations('fees.reports.record');
  const { client, session } = useAuth();
  const id = useId();
  const [text, setText] = useState('');
  const q = useDebounced(toAsciiDigits(text).trim(), 300);
  const hits = useQuery({
    queryKey: ['fee-student-search', session?.tenant?.id, q],
    queryFn: () => client.api<FeeStudentHit[]>(`/fees/students?${new URLSearchParams({ q })}`),
    enabled: q.length > 0,
  });
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
        />
        <Input
          id={id}
          type="search"
          value={text}
          placeholder={t('search')}
          className="ps-9"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          onChange={(e) => setText(e.target.value)}
          data-testid="record-student-search"
        />
      </div>
      {q.length > 0 &&
        (hits.isPending ? (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t('searching')}
          </p>
        ) : hits.isError ? (
          <LoadError error={hits.error} onRetry={() => void hits.refetch()} />
        ) : hits.data.length === 0 ? (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t('noMatch')}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto rounded-lg border">
            {hits.data.map((s) => (
              <li key={s.id} className="border-b last:border-0">
                <button
                  type="button"
                  className="hover:bg-muted/60 focus-visible:ring-ring flex min-h-(--control-h) w-full items-center px-3 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  onClick={() => onPick(s)}
                  data-testid="record-student-hit"
                >
                  <StudentLine student={s} />
                </button>
              </li>
            ))}
          </ul>
        ))}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
