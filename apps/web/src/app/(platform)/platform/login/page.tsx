'use client';

import {
  toAsciiDigits,
  type PlatformLoginResponse,
  type PlatformVerifyResponse,
} from '@jantrik/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CopyIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/brand';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/hooks';
import { platformApi } from '@/lib/platform/platform-api';

type Step =
  | { kind: 'password' }
  | { kind: 'code'; challengeId: string; enrol?: PlatformLoginResponse['enrol'] }
  | { kind: 'backup-codes'; codes: string[] };

/** /platform/login: password, then the authenticator code (first time: set the app up). */
export default function PlatformLoginPage() {
  const t = useTranslations('platform');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [notice, setNotice] = useState<string | null>(null);

  const signedIn = (res: PlatformVerifyResponse) => {
    queryClient.setQueryData(['platform-me'], res.admin);
    if (res.backupCodes) setStep({ kind: 'backup-codes', codes: res.backupCodes });
    else router.replace('/platform');
  };

  return (
    <main className="bg-canvas flex min-h-svh flex-col" data-board="slate">
      <header className="bg-board flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo inverted />
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-sm font-medium">
            {t('badge')}
          </span>
        </div>
        <LanguageToggle onBrand />
      </header>
      <div className="flex flex-1 flex-col items-center px-4 py-8 sm:py-12">
        <div
          className="bg-card w-full max-w-md rounded-2xl border p-5 shadow-lg sm:p-8"
          data-testid="platform-login"
        >
          {step.kind === 'password' && (
            <PasswordStep
              notice={notice}
              onDone={(res) => {
                setNotice(null);
                setStep({ kind: 'code', challengeId: res.challengeId, enrol: res.enrol });
              }}
            />
          )}
          {step.kind === 'code' && (
            <CodeStep
              challengeId={step.challengeId}
              enrol={step.enrol}
              onDone={signedIn}
              onRestart={(message) => {
                setNotice(message);
                setStep({ kind: 'password' });
              }}
            />
          )}
          {step.kind === 'backup-codes' && (
            <BackupCodes codes={step.codes} onContinue={() => router.replace('/platform')} />
          )}
        </div>
      </div>
    </main>
  );
}

function useLoginError() {
  const t = useTranslations('platform');
  const describe = useErrorMessage();
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.code === 'INVALID_CREDENTIALS') return t('errorCredentials');
      if (error.code === 'ENROLMENT_CLOSED') return t('errorEnrolClosed');
      if (error.code === 'INVALID_CODE') {
        const left = (error.body as { attemptsLeft?: number } | undefined)?.attemptsLeft;
        return left !== undefined ? t('errorCodeLeft', { left }) : t('errorCode');
      }
    }
    return describe(error);
  };
}

function PasswordStep({
  notice,
  onDone,
}: {
  notice: string | null;
  onDone: (res: PlatformLoginResponse) => void;
}) {
  const t = useTranslations('platform');
  const message = useLoginError();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      onDone(
        await platformApi<PlatformLoginResponse>('/platform/auth/login', {
          method: 'POST',
          json: { identifier, password },
        }),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('loginTitle')}</h1>
        <p className="text-muted-foreground">{t('loginText')}</p>
      </div>
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="platform-identifier">{t('identifier')}</Label>
        <Input
          id="platform-identifier"
          autoComplete="username"
          inputMode="email"
          dir="ltr"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="platform-password">{t('password')}</Label>
        <Input
          id="platform-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending || !identifier || !password}>
        {t('next')}
      </Button>
    </form>
  );
}

function CodeStep({
  challengeId,
  enrol,
  onDone,
  onRestart,
}: {
  challengeId: string;
  enrol?: PlatformLoginResponse['enrol'];
  onDone: (res: PlatformVerifyResponse) => void;
  onRestart: (message: string) => void;
}) {
  const t = useTranslations('platform');
  const message = useLoginError();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!enrol) return;
    void QRCode.toDataURL(enrol.uri, { margin: 1, width: 216, errorCorrectionLevel: 'M' }).then(
      setQr,
    );
  }, [enrol]);

  const submit = async (e?: FormEvent, value = code) => {
    e?.preventDefault();
    setPending(true);
    setError(null);
    try {
      onDone(
        await platformApi<PlatformVerifyResponse>('/platform/auth/verify', {
          method: 'POST',
          json: { challengeId, code: value },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHALLENGE_EXPIRED') onRestart(t('errorExpired'));
      else setError(message(err));
      setCode('');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{enrol ? t('enrolTitle') : t('codeTitle')}</h1>
        <p className="text-muted-foreground">{enrol ? t('enrolText') : t('codeText')}</p>
      </div>
      {enrol && (
        <div
          className="flex flex-col items-center gap-3 rounded-xl border p-4"
          data-testid="platform-enrol"
        >
          {qr ? (
            // A generated image of the otpauth:// link (no user content).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={t('qrAlt')} width={216} height={216} data-testid="platform-qr" />
          ) : (
            <div className="bg-muted size-[216px] rounded-lg" aria-hidden />
          )}
          <p className="text-muted-foreground text-center text-sm">{t('enrolManual')}</p>
          <div className="flex max-w-full items-center gap-2">
            <code
              className="bg-muted font-numeric rounded-md px-2 py-1 text-sm break-all"
              dir="ltr"
              data-testid="platform-secret"
            >
              {enrol.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('copyKey')}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(enrol.secret)
                  .then(() => toast.success(t('copied')))
              }
            >
              <CopyIcon aria-hidden />
            </Button>
          </div>
        </div>
      )}
      {useBackup ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="platform-backup">{t('backupCode')}</Label>
          <Input
            id="platform-backup"
            autoComplete="one-time-code"
            dir="ltr"
            className="font-numeric uppercase"
            placeholder="XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="platform-backup-input"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="platform-code">{t('code')}</Label>
          <InputOTP
            id="platform-code"
            maxLength={6}
            pattern="^[0-9০-৯]*$"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(v) => setCode(toAsciiDigits(v))}
            onComplete={(v: string) => void submit(undefined, toAsciiDigits(v))}
            data-testid="platform-code"
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending || code.length < 6}>
        <ShieldCheckIcon aria-hidden />
        {t('verify')}
      </Button>
      {!enrol && (
        <Button
          type="button"
          variant="link"
          className="self-start px-0"
          onClick={() => {
            setUseBackup((b) => !b);
            setCode('');
            setError(null);
          }}
        >
          <KeyRoundIcon aria-hidden />
          {useBackup ? t('useApp') : t('useBackup')}
        </Button>
      )}
    </form>
  );
}

function BackupCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const t = useTranslations('platform');
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-col gap-5" data-testid="platform-backup-codes">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('backupTitle')}</h1>
        <p className="text-muted-foreground">{t('backupText')}</p>
      </div>
      <ol className="grid grid-cols-2 gap-2" dir="ltr">
        {codes.map((c) => (
          <li
            key={c}
            className="bg-muted font-numeric rounded-md px-2 py-1.5 text-center text-sm tracking-wide"
          >
            {c}
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(codes.join('\n'))
            .then(() => toast.success(t('copied')))
        }
      >
        <CopyIcon aria-hidden />
        {t('copyCodes')}
      </Button>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="accent-primary mt-0.5 size-5 shrink-0"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          data-testid="platform-backup-saved"
        />
        <span className="font-medium">{t('backupSaved')}</span>
      </label>
      <Button size="lg" disabled={!saved} onClick={onContinue} data-testid="platform-continue">
        {t('continue')}
      </Button>
    </div>
  );
}
