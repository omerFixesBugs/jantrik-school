'use client';

import { formatBdPhone, normalizeBdPhone, toAsciiDigits } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState, type FormEvent } from 'react';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LOCALE_COOKIE, type Locale } from '@/i18n/config';
import { ApiError, NetworkError, toApiError } from '@/lib/api/errors';
import { API_URL, type Session } from '@/lib/auth/auth-client';
import { useAuth } from '@/lib/auth/auth-provider';
import { useCountdown, useErrorMessage } from '@/lib/hooks';

const RESEND_COOLDOWN_MS = 60_000;

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const t = useTranslations('login');
  const tApp = useTranslations('app');
  const { status, session } = useAuth();
  const router = useRouter();
  const locale = useLocale() as Locale;
  const next = useSafeNext();

  /** After login: adopt the user's saved language, then go to the app. */
  const finish = (s: Session) => {
    router.replace(s.tenant ? next : '/select-institute');
    if (s.user.locale !== locale) {
      document.cookie = `${LOCALE_COOKIE}=${s.user.locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
      router.refresh();
    }
  };

  // Already signed in (e.g. another tab logged in): skip the form.
  useEffect(() => {
    if (status === 'signed-in' && session)
      router.replace(session.tenant ? next : '/select-institute');
  }, [status, session, next, router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex w-full max-w-sm items-center justify-between">
        <span className="text-lg font-semibold">{tApp('name')}</span>
        <LanguageToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t('title')}</h1>
          </CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="otp">
            <TabsList className="mb-4 w-full">
              <TabsTrigger value="otp">{t('otpTab')}</TabsTrigger>
              <TabsTrigger value="password">{t('passwordTab')}</TabsTrigger>
            </TabsList>
            <TabsContent value="otp">
              <OtpForm onDone={finish} />
            </TabsContent>
            <TabsContent value="password">
              <PasswordForm onDone={finish} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  );
}

/** Only same-site relative paths, so ?next= can't redirect elsewhere. */
function useSafeNext(): string {
  const next = useSearchParams().get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function FormError({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive" className="min-h-0">
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Error text, with a live countdown for 429 responses. */
function useLoginError() {
  const t = useTranslations('errors');
  const describe = useErrorMessage();
  const [error, setError] = useState<unknown>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const secondsLeft = useCountdown(blockedUntil);

  const report = (e: unknown) => {
    setError(e);
    setBlockedUntil(
      e instanceof ApiError && e.status === 429 ? Date.now() + (e.retryAfter ?? 60) * 1000 : null,
    );
  };
  const message =
    error instanceof ApiError && error.status === 429
      ? secondsLeft > 0
        ? t('rateLimited', { seconds: secondsLeft })
        : null
      : error
        ? describe(error)
        : null;
  return { message, report, clear: () => report(null), blocked: secondsLeft > 0 };
}

function OtpForm({ onDone }: { onDone: (s: Session) => void }) {
  const t = useTranslations('login');
  const tErr = useTranslations('errors');
  const { client } = useAuth();
  const phoneId = useId();
  const codeId = useId();
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState<string | null>(null); // E.164 once a code was sent
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const resendIn = useCountdown(resendAt);
  const { message, report, clear, blocked } = useLoginError();
  const [localError, setLocalError] = useState<string | null>(null);

  const requestCode = async (target: string) => {
    setBusy(true);
    clear();
    try {
      const res = await fetch(`${API_URL}/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: target }),
      }).catch(() => {
        throw new NetworkError();
      });
      if (!res.ok) throw await toApiError(res);
      setPhone(target);
      setResendAt(Date.now() + RESEND_COOLDOWN_MS);
    } catch (e) {
      report(e);
      if (e instanceof ApiError && e.status === 429) {
        setResendAt(Date.now() + (e.retryAfter ?? 60) * 1000);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmitPhone = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeBdPhone(phoneInput);
    if (!normalized) {
      setLocalError(tErr('invalidPhone'));
      return;
    }
    setLocalError(null);
    void requestCode(normalized);
  };

  const onSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setLocalError(tErr('invalidCode'));
      return;
    }
    setLocalError(null);
    setBusy(true);
    clear();
    try {
      onDone(await client.login('/auth/otp/verify', { phone, code }));
    } catch (err) {
      report(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (!phone) {
    return (
      <form onSubmit={onSubmitPhone} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor={phoneId}>{t('phone')}</Label>
          <Input
            id={phoneId}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="01XXXXXXXXX"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            aria-invalid={Boolean(localError)}
            aria-describedby={`${phoneId}-hint`}
            required
          />
          <p id={`${phoneId}-hint`} className="text-muted-foreground text-xs">
            {t('phoneHint')}
          </p>
        </div>
        <FormError message={localError ?? message} />
        <Button type="submit" disabled={busy || blocked}>
          {busy ? t('sending') : t('sendCode')}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmitCode} className="flex flex-col gap-4" noValidate>
      <p className="text-sm" aria-live="polite">
        {t('codeSentTo', { phone: formatBdPhone(phone) })}
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={codeId}>{t('code')}</Label>
        <InputOTP
          id={codeId}
          maxLength={6}
          value={code}
          // Accept Bangla digits from a Bangla keyboard; store ASCII.
          pattern="^[0-9০-৯]*$"
          onChange={(value) => setCode(toAsciiDigits(value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          aria-invalid={Boolean(localError)}
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }, (_, i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      <FormError message={localError ?? message} />
      <Button type="submit" disabled={busy || blocked || code.length !== 6}>
        {busy ? t('verifying') : t('verify')}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button type="button" variant="link" className="px-0" onClick={() => setPhone(null)}>
          {t('changePhone')}
        </Button>
        {resendIn > 0 ? (
          <span className="text-muted-foreground" aria-live="polite" data-testid="resend-countdown">
            {t('resendIn', { seconds: resendIn })}
          </span>
        ) : (
          <Button
            type="button"
            variant="link"
            className="px-0"
            disabled={busy}
            onClick={() => void requestCode(phone)}
          >
            {t('resend')}
          </Button>
        )}
      </div>
    </form>
  );
}

function PasswordForm({ onDone }: { onDone: (s: Session) => void }) {
  const t = useTranslations('login');
  const { client } = useAuth();
  const idId = useId();
  const pwId = useId();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { message, report, clear, blocked } = useLoginError();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    clear();
    try {
      onDone(await client.login('/auth/login', { identifier, password }));
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={idId}>{t('identifier')}</Label>
        <Input
          id={idId}
          name="username"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={pwId}>{t('password')}</Label>
        <Input
          id={pwId}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <FormError message={message} />
      <Button type="submit" disabled={busy || blocked || !identifier || !password}>
        {busy ? t('signingIn') : t('signIn')}
      </Button>
    </form>
  );
}
