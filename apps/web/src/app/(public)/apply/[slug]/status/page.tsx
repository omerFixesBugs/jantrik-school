'use client';

import {
  formatBdPhone,
  formatDate,
  formatIdentifier,
  normalizeBdPhone,
  toAsciiDigits,
  type AdmissionPublicStatus,
} from '@jantrik/shared';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { publicApi, TurnstileBox } from '@/components/admission/public-kit';
import { TextField } from '@/components/form-kit';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { displayName } from '@/lib/names';

/** The application's status (decision P3-F): its number, then a code to the phone it used. */
export default function StatusPage() {
  const t = useTranslations('admissions.apply');
  const ta = useTranslations('admission');
  const locale = useLocale() as Locale;
  const { slug } = useParams<{ slug: string }>();
  const [no, setNo] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'ask' | 'code' | 'shown'>('ask');
  const [robot, setRobot] = useState('');
  const [robotKey, setRobotKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<AdmissionPublicStatus | null>(null);
  const onRobot = useCallback((token: string) => setRobot(token), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      const c = e instanceof ApiError ? e.code : null;
      if (c === 'APPLICATION_NOT_FOUND') setMessage(t('notFound'));
      else if (c === 'ADMISSION_CODE_INVALID') setMessage(t('wrongCode'));
      else if (c === 'TURNSTILE_FAILED') setMessage(t('robotFailed'));
      else if (e instanceof ApiError && e.status === 429) setMessage(t('tooMany'));
      else if (c === 'ADMISSION_UNKNOWN') setMessage(t('unknown'));
      else setMessage(t('robotDown'));
    } finally {
      setBusy(false);
    }
  };

  async function sendCode() {
    const e164 = normalizeBdPhone(phone);
    if (!e164) return setMessage(ta('errorPhone'));
    if (!robot) return setMessage(t('robotNeeded'));
    await run(async () => {
      try {
        await publicApi(`/${slug}/otp`, {
          method: 'POST',
          // A status code: sent only when this phone made this application (review S4).
          json: {
            phone: e164,
            turnstileToken: robot,
            purpose: 'status',
            applicationNo: toAsciiDigits(no.trim()),
          },
        });
        setStep('code');
      } finally {
        setRobot('');
        setRobotKey((k) => k + 1);
      }
    });
  }

  async function check() {
    await run(async () => {
      const e164 = normalizeBdPhone(phone);
      const v = await publicApi<{ phoneToken: string }>(`/${slug}/otp/verify`, {
        method: 'POST',
        json: { phone: e164, code: toAsciiDigits(code.trim()) },
      });
      const s = await publicApi<AdmissionPublicStatus>(`/${slug}/status`, {
        method: 'POST',
        json: { applicationNo: toAsciiDigits(no.trim()) },
        token: v.phoneToken,
      });
      setStatus(s);
      setStep('shown');
    });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-5 bg-background p-4 pb-16">
      <header className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('statusTitle')}</h1>
        <LanguageToggle />
      </header>
      {message && (
        <Alert role="alert">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {step === 'ask' && (
        <section className="flex flex-col gap-4" data-testid="status-ask">
          <TextField
            id="status-no"
            label={t('applicationNo')}
            value={no}
            onChange={setNo}
            inputMode="numeric"
          />
          <TextField
            id="status-phone"
            label={t('phone')}
            value={phone}
            onChange={setPhone}
            inputMode="tel"
            autoComplete="tel"
          />
          <TurnstileBox action="admission-otp" onToken={onRobot} resetKey={robotKey} />
          <Button disabled={busy || !no.trim()} onClick={() => void sendCode()}>
            {t('sendCode')}
          </Button>
        </section>
      )}
      {step === 'code' && (
        <section className="flex flex-col gap-4" data-testid="status-code">
          <p className="text-muted-foreground text-sm">
            {t('codeHint', { phone: formatBdPhone(normalizeBdPhone(phone) ?? phone) })}
          </p>
          <TextField
            id="status-code"
            label={t('code')}
            value={code}
            onChange={setCode}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <Button disabled={busy} onClick={() => void check()}>
            {t('check')}
          </Button>
        </section>
      )}
      {step === 'shown' && status && (
        <section
          className="bg-card flex flex-col gap-2 rounded-xl border p-4"
          data-testid="status-shown"
        >
          <p className="font-mono text-lg">{formatIdentifier(status.applicationNo)}</p>
          <p className="text-xl font-semibold">{t(`status.${status.status}`)}</p>
          <p>{displayName(status.nameBn, status.nameEn, locale)}</p>
          <p className="text-muted-foreground text-sm">
            {displayName(status.classNameBn, status.classNameEn, locale)}
            {status.groupNameBn &&
              ` · ${displayName(status.groupNameBn, status.groupNameEn, locale)}`}
            {' · '}
            {displayName(status.cycleNameBn, status.cycleNameEn, locale)}
          </p>
          <p className="text-muted-foreground text-sm">
            {t('submittedOn', { date: formatDate(status.submittedAt, locale) })}
          </p>
        </section>
      )}
    </main>
  );
}
