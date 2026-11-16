'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  isStaffRole,
  passwordProblems,
  PASSWORD_RULES,
  toAsciiDigits,
  type PasswordCodeSent,
  type PasswordProblem,
  type PasswordStatus,
} from '@jantrik/shared';
import { CheckIcon, CircleIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { ContextGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useCountdown, useErrorMessage, useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/** One code a minute per phone (the API's cooldown), shown as a countdown on "Resend". */
const RESEND_AFTER_MS = 60_000;

/** A staff member's own password (sprint 1 P1): a code to their phone, then the new password. */
export default function PasswordPage() {
  return (
    <ContextGate allow={(ctx) => ctx.roles.some(isStaffRole)}>
      <PasswordSettings />
    </ContextGate>
  );
}

function PasswordSettings() {
  const t = useTranslations('account.password');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const status = useQuery({
    queryKey: ['password-status', session?.user.id],
    queryFn: () => client.api<PasswordStatus>('/me/password'),
  });
  const [done, setDone] = useState(false);

  if (status.isPending) return <Skeleton className="h-72 max-w-xl rounded-xl" />;
  if (status.isError) {
    return (
      <Alert variant="destructive" className="max-w-xl">
        <AlertDescription>{describe(status.error)}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-4">
      {done && (
        <Alert role="status" className="border-success/30 bg-success-soft">
          <CheckIcon aria-hidden className="text-success" />
          <AlertDescription className="text-foreground">{t('success')}</AlertDescription>
        </Alert>
      )}
      {/* The settings card of form-kit, without importing it (its badges need the setup texts). */}
      <section
        data-slot="card"
        className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-4 border p-(--panel-p)"
        aria-labelledby="password-card-title"
        data-testid="password-card"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="password-card-title" className="text-base font-semibold break-words">
            {status.data.hasPassword ? t('cardChange') : t('cardSet')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('why')}</p>
        </div>
        <StatusLine status={status.data} />
        <PasswordForm
          status={status.data}
          onDone={() => setDone(true)}
          onStart={() => setDone(false)}
        />
      </section>
    </div>
  );
}

function StatusLine({ status }: { status: PasswordStatus }) {
  const t = useTranslations('account.password');
  const locale = useLocale() as Locale;
  const text = !status.hasPassword
    ? t('statusNone')
    : status.changedAt
      ? t('statusChanged', { date: formatDate(status.changedAt, locale, 'long') })
      : t('statusSet');
  return (
    <p
      className="bg-canvas flex items-start gap-2 rounded-lg border p-3 text-sm"
      data-testid="password-status"
    >
      <KeyRoundIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

/** Step 1 sends the code; step 2 takes the code and the new password twice. */
function PasswordForm({
  status,
  onDone,
  onStart,
}: {
  status: PasswordStatus;
  onDone: () => void;
  onStart: () => void;
}) {
  const t = useTranslations('account.password');
  const tErr = useTranslations('errors');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { data: context } = useMeContext();
  const codeId = useId();
  const [sent, setSent] = useState<PasswordCodeSent | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const resendIn = useCountdown(resendAt);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const blockedFor = useCountdown(blockedUntil);

  const report = (e: unknown) => {
    setError(e);
    setBlockedUntil(
      e instanceof ApiError && e.status === 429 ? Date.now() + (e.retryAfter ?? 60) * 1000 : null,
    );
  };

  const sendCode = useMutation({
    mutationFn: () =>
      client.api<PasswordCodeSent>('/me/password/code', { method: 'POST', json: {} }),
    onMutate: () => {
      report(null);
      onStart();
    },
    onSuccess: (res) => {
      setSent(res);
      setCode('');
      setResendAt(Date.now() + RESEND_AFTER_MS);
    },
    onError: (e) => {
      report(e);
      if (e instanceof ApiError && e.status === 429) {
        setResendAt(Date.now() + (e.retryAfter ?? 60) * 1000);
      }
    },
  });

  const save = useMutation({
    mutationFn: () => client.api<void>('/me/password', { method: 'PUT', json: { code, password } }),
    onMutate: () => report(null),
    onSuccess: async () => {
      setSent(null);
      setCode('');
      setPassword('');
      setConfirm('');
      setResendAt(null);
      onDone();
      await queryClient.invalidateQueries({ queryKey: ['password-status'] });
    },
    onError: (e) => {
      report(e);
      if (e instanceof ApiError && e.code === 'PASSWORD_CODE_INVALID') setCode('');
    },
  });

  // The rules the browser can check; the server adds the common-password list.
  const instituteNames = context ? [context.tenant.name] : [];
  const problems = passwordProblems(password, { phone: status.phone, instituteNames });
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    code.length === 6 && password.length > 0 && problems.length === 0 && confirm === password;

  const errorText = (() => {
    if (!error) return null;
    if (error instanceof ApiError) {
      if (error.status === 429) {
        return blockedFor > 0
          ? tErr('rateLimited', { seconds: formatCount(blockedFor, locale) })
          : null;
      }
      if (error.code === 'PASSWORD_CODE_INVALID') return t('codeInvalid');
      if (error.code === 'PASSWORD_REJECTED') return null; // listed below
    }
    return describe(error);
  })();
  const rejected =
    error instanceof ApiError && error.code === 'PASSWORD_REJECTED'
      ? ((error.body as { problems?: (PasswordProblem | 'TOO_COMMON')[] }).problems ?? [])
      : [];

  if (!sent) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{t('codeFirst')}</p>
        <p className="text-muted-foreground text-sm">{t('otherDevices')}</p>
        <ErrorBox message={errorText} />
        <Button
          type="button"
          className="w-fit"
          onClick={() => sendCode.mutate()}
          disabled={sendCode.isPending || resendIn > 0}
        >
          {sendCode.isPending ? t('sending') : t('sendCode')}
        </Button>
        {resendIn > 0 && (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t('resendIn', { seconds: formatCount(resendIn, locale) })}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <p className="text-sm" aria-live="polite" data-testid="code-sent">
        {t('codeSent', { phone: sent.phoneHint })}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={codeId}>{t('code')}</Label>
        <InputOTP
          id={codeId}
          maxLength={6}
          value={code}
          // Bangla digits from a Bangla keyboard are fine; the API gets ASCII.
          pattern="^[0-9০-৯]*$"
          onChange={(value) => setCode(toAsciiDigits(value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }, (_, i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
        <div className="text-sm">
          {resendIn > 0 ? (
            <span className="text-muted-foreground" aria-live="polite">
              {t('resendIn', { seconds: formatCount(resendIn, locale) })}
            </span>
          ) : (
            <Button
              type="button"
              variant="link"
              className="h-auto px-0"
              disabled={sendCode.isPending}
              onClick={() => sendCode.mutate()}
            >
              {t('resend')}
            </Button>
          )}
        </div>
      </div>

      <PasswordField
        label={t('newPassword')}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        describedBy="password-rules"
      />
      <Rules password={password} problems={problems} />
      <PasswordField
        label={t('confirm')}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={mismatch ? t('mismatch') : null}
      />

      <ErrorBox message={errorText} />
      {rejected.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{t('rejected')}</p>
            <ul className="list-disc ps-5">
              {rejected.map((p) => (
                <li key={p}>
                  {t(`problem.${p}`, {
                    min: formatCount(PASSWORD_RULES.min, locale),
                    max: formatCount(PASSWORD_RULES.max, locale),
                  })}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || save.isPending || blockedFor > 0}>
          {save.isPending ? t('saving') : t('submit')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSent(null);
            setCode('');
            setPassword('');
            setConfirm('');
            report(null);
          }}
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A password input with a show/hide button (people check what they typed on a phone). */
function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  describedBy,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  describedBy?: string;
  error?: string | null;
}) {
  const t = useTranslations('account.password');
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          maxLength={512}
          className="pe-11"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : describedBy}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute inset-y-0 end-0 h-full"
          aria-label={shown ? t('hide') : t('show')}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The rules, checked as the person types: a check when met, a cross when not. */
function Rules({ password, problems }: { password: string; problems: PasswordProblem[] }) {
  const t = useTranslations('account.password');
  const locale = useLocale() as Locale;
  const typed = password.length > 0;
  const rules = [
    {
      key: 'length',
      ok: !problems.includes('TOO_SHORT') && !problems.includes('TOO_LONG') && typed,
      text: t('ruleLength', { min: formatCount(PASSWORD_RULES.min, locale) }),
    },
    { key: 'phone', ok: !problems.includes('HAS_PHONE'), text: t('rulePhone') },
    { key: 'institute', ok: !problems.includes('HAS_INSTITUTE_NAME'), text: t('ruleInstitute') },
  ];
  return (
    <div id="password-rules" className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs font-medium">{t('rules')}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {rules.map((r) => {
          const Icon = !typed ? CircleIcon : r.ok ? CheckIcon : XIcon;
          return (
            <li
              key={r.key}
              data-testid={`password-rule-${r.key}`}
              data-ok={r.ok ? 'true' : 'false'}
              className={cn(
                'flex items-start gap-2',
                !typed ? 'text-muted-foreground' : r.ok ? 'text-foreground' : 'text-destructive',
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  !typed ? 'size-3.5' : r.ok ? 'text-success' : 'text-destructive',
                )}
              />
              <span>{r.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive">
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
