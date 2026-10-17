'use client';

import { formatBdPhone, normalizeBdPhone, toAsciiDigits } from '@jantrik/shared';
import { LanguagesIcon, LifeBuoyIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState, type FormEvent } from 'react';
import { AlphabetChart, AlphabetStrip, Logo } from '@/components/brand';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
    <main className="bg-canvas grid min-h-svh flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <BrandPanel />
      <section className="flex min-w-0 flex-col">
        <div className="bg-brand flex items-center justify-between px-4 py-3 text-white lg:bg-transparent lg:px-8 lg:py-6 lg:text-inherit">
          <Logo inverted className="lg:hidden" />
          <span className="hidden lg:block" />
          <span className="lg:hidden">
            <LanguageToggle onBrand />
          </span>
          <span className="hidden lg:block">
            <LanguageToggle />
          </span>
        </div>
        {/* Phone: a short brand band above the form. */}
        <div className="bg-brand flex flex-col gap-4 overflow-hidden px-4 pt-2 pb-14 text-white lg:hidden">
          <p className="font-heading max-w-xs text-2xl leading-snug font-semibold">
            {t('brandHeadline')}
          </p>
          <AlphabetStrip />
        </div>
        <div className="flex flex-1 flex-col items-center px-4 pb-10 lg:justify-center lg:px-8">
          <div className="bg-card relative z-10 -mt-8 w-full max-w-md rounded-2xl border p-5 shadow-lg sm:p-8 lg:mt-0">
            <div className="mb-6 flex flex-col gap-1">
              <h1 className="text-2xl font-semibold">{t('title')}</h1>
              <p className="text-muted-foreground">{t('subtitle')}</p>
            </div>
            <Tabs defaultValue="otp">
              <TabsList className="mb-5 w-full">
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
          </div>
          <p className="text-muted-foreground mt-5 flex max-w-md items-start gap-2 text-sm">
            <LifeBuoyIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('help')}
          </p>
        </div>
      </section>
    </main>
  );
}

/** Desktop brand panel: the বর্ণমালা chart, the promise, three plain facts. */
function BrandPanel() {
  const t = useTranslations('login');
  const points = [
    { icon: LanguagesIcon, text: t('pointLanguage') },
    { icon: SmartphoneIcon, text: t('pointPhone') },
    { icon: ShieldCheckIcon, text: t('pointPrivate') },
  ];
  return (
    <aside className="bg-brand relative hidden flex-col overflow-hidden p-12 text-white lg:flex xl:p-16">
      <Logo inverted />
      <div className="relative z-10 mt-16 flex max-w-lg flex-col gap-5">
        <h2 className="text-4xl leading-tight font-semibold">{t('brandHeadline')}</h2>
        <p className="text-lg text-white/80">{t('brandText')}</p>
        <ul className="mt-2 flex flex-col gap-3">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-white/90">
              <span className="flex size-9 items-center justify-center rounded-lg bg-white/10">
                <Icon aria-hidden className="size-4.5" />
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <AlphabetChart className="pointer-events-none absolute -right-8 -bottom-10 w-[34rem]" />
    </aside>
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
            className="tabular-nums"
            dir="ltr"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            aria-invalid={Boolean(localError)}
            aria-describedby={`${phoneId}-hint`}
            required
          />
          <p id={`${phoneId}-hint`} className="text-muted-foreground text-sm">
            {t('phoneHint')}
          </p>
        </div>
        <FormError message={localError ?? message} />
        <Button type="submit" size="lg" disabled={busy || blocked}>
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
      <Button type="submit" size="lg" disabled={busy || blocked || code.length !== 6}>
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
      <Button type="submit" size="lg" disabled={busy || blocked || !identifier || !password}>
        {busy ? t('signingIn') : t('signIn')}
      </Button>
    </form>
  );
}
