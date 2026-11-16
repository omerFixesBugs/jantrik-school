'use client';

import {
  effectiveAdmissionFields,
  formatBdPhone,
  formatDate,
  formatIdentifier,
  normalizeBdPhone,
  toAsciiDigits,
  type AdmissionPublicCycle,
  type AdmissionPublicForm,
} from '@jantrik/shared';
import { CheckCircle2Icon, PrinterIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import {
  ApplicationFields,
  applicationPayload,
  emptyApplication,
  localProblems,
  serverProblems,
  type ApplicationValues,
} from '@/components/admission/application-form';
import { publicApi, TurnstileBox } from '@/components/admission/public-kit';
import { ChoiceChip, TextField } from '@/components/form-kit';
import { ChooseImageButton, useFilePreview } from '@/components/image-upload';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { displayName } from '@/lib/names';

type Form = AdmissionPublicForm & { formTicket: string };
type Step = 'class' | 'phone' | 'code' | 'form' | 'review' | 'done';

/** The public admission form (sprint 1 P3b): class → phone → code → form → check → done. */
export default function ApplyPage() {
  const t = useTranslations('admissions.apply');
  const ta = useTranslations('admission');
  const locale = useLocale() as Locale;
  const { slug } = useParams<{ slug: string }>();
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<'unknown' | 'network' | null>(null);
  const [step, setStep] = useState<Step>('class');
  const [cycleClassId, setCycleClassId] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneToken, setPhoneToken] = useState('');
  const [robot, setRobot] = useState('');
  const [robotKey, setRobotKey] = useState(0);
  const [values, setValues] = useState<ApplicationValues>(emptyApplication);
  const [touched, setTouched] = useState(false);
  const [website, setWebsite] = useState('');
  const { file: photo, preview: photoUrl, choose: choosePhoto } = useFilePreview();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [applicationNo, setApplicationNo] = useState('');
  const onRobot = useCallback((token: string) => setRobot(token), []);

  useEffect(() => {
    let live = true;
    publicApi<Form>(`/${slug}`)
      .then((f) => live && setForm(f))
      .catch(
        (e) =>
          live && setLoadError(e instanceof ApiError && e.status === 404 ? 'unknown' : 'network'),
      );
    return () => {
      live = false;
    };
  }, [slug]);

  const cycle: AdmissionPublicCycle | null =
    form?.cycles.find((c) => c.classes.some((cc) => cc.cycleClassId === cycleClassId)) ?? null;
  const settings = cycle ? effectiveAdmissionFields(cycle.fields, cycle.collectPhoto) : null;
  const institute = form
    ? ((locale === 'bn' ? form.institute.nameBn : form.institute.nameEn) ?? form.institute.name)
    : '';
  const freshRobot = () => {
    setRobot('');
    setRobotKey((k) => k + 1);
  };
  const failed = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : null;
    if (code === 'TURNSTILE_FAILED') setMessage(t('robotFailed'));
    else if (code === 'TURNSTILE_UNAVAILABLE') setMessage(t('robotDown'));
    else if (e instanceof ApiError && e.status === 429) setMessage(t('tooMany'));
    else if (code === 'ADMISSION_CODE_INVALID') setMessage(t('wrongCode'));
    else if (code === 'ADMISSION_TOKEN_INVALID') {
      setMessage(t('expired'));
      setPhoneToken('');
      setStep('phone');
    } else if (code === 'ADMISSION_DUPLICATE') {
      const no = (e as ApiError).body as { applicationNo?: string } | null;
      setMessage(t('duplicate', { no: formatIdentifier(no?.applicationNo ?? '') }));
    } else if (code === 'ADMISSION_PHONE_CAP') setMessage(t('phoneCap'));
    else if (code === 'ADMISSION_REJECTED') setMessage(t('rejected'));
    else if (code === 'ADMISSION_CLOSED') setMessage(t('classClosed'));
    else if (code === 'ADMISSION_INVALID' || code === 'PHONE_INVALID') setMessage(t('invalid'));
    else setMessage(t('robotDown'));
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      failed(e);
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
          json: { phone: e164, turnstileToken: robot },
        });
        setStep('code');
      } finally {
        freshRobot();
      }
    });
  }

  async function verifyCode() {
    await run(async () => {
      const r = await publicApi<{ phoneToken: string }>(`/${slug}/otp/verify`, {
        method: 'POST',
        json: { phone: normalizeBdPhone(phone), code: toAsciiDigits(code.trim()) },
      });
      setPhoneToken(r.phoneToken);
      setStep('form');
    });
  }

  async function submit() {
    if (!robot) return setMessage(t('robotNeeded'));
    setSubmitError(null);
    await run(async () => {
      const { phone: _p, staffNote: _n, ...payload } = applicationPayload(values);
      const body = new FormData();
      body.set('payload', JSON.stringify(payload));
      body.set('cycleClassId', cycleClassId);
      body.set('turnstileToken', robot);
      body.set('formTicket', form!.formTicket);
      body.set('website', website);
      if (photo) body.set('photo', photo);
      try {
        const r = await publicApi<{ applicationNo: string }>(`/${slug}/applications`, {
          method: 'POST',
          form: body,
          token: phoneToken,
        });
        setApplicationNo(r.applicationNo);
        setStep('done');
      } catch (e) {
        setSubmitError(e);
        if (e instanceof ApiError && e.code === 'ADMISSION_INVALID') setStep('form');
        throw e;
      } finally {
        freshRobot();
      }
    });
  }

  const header = (
    <header className="flex items-start justify-between gap-3 print:hidden">
      <div className="flex min-w-0 flex-col">
        <p className="text-muted-foreground text-sm">{t('title')}</p>
        <h1 className="text-xl font-semibold break-words">{institute}</h1>
      </div>
      <LanguageToggle />
    </header>
  );

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 bg-background p-4">
        <Alert>
          <AlertDescription>
            {loadError === 'unknown' ? t('unknown') : t('robotDown')}
          </AlertDescription>
        </Alert>
      </main>
    );
  }
  if (!form) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 bg-background p-4">
        <Skeleton className="h-64 rounded-xl" />
      </main>
    );
  }
  const required = ta('errorRequired');
  const errors = {
    ...serverProblems(submitError, ta('errorInvalid'), required),
    ...(touched ? localProblems({ ...values, phone: phone || 'x' }, required) : {}),
  };
  const photoMissing = settings?.photo === 'REQUIRED' && !photo;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-5 bg-background p-4 pb-16">
      {header}
      {message && (
        <Alert role="alert">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {form.cycles.length === 0 && <p className="text-muted-foreground">{t('closed')}</p>}

      {step === 'class' && form.cycles.length > 0 && (
        <section className="flex flex-col gap-4" data-testid="apply-class">
          {form.cycles.map((c, i) => (
            <div key={i} className="flex flex-col gap-3">
              <h2 className="font-semibold">{displayName(c.nameBn, c.nameEn, locale)}</h2>
              <p className="text-muted-foreground text-sm">
                {t('closes', { date: formatDate(c.closesAt, locale) })}
              </p>
              {(locale === 'bn' ? c.noteBn : c.noteEn) && (
                <p className="text-sm whitespace-pre-line">
                  {locale === 'bn' ? c.noteBn : c.noteEn}
                </p>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{t('chooseClass')}</legend>
                {c.classes.map((cc) => (
                  <ChoiceChip
                    key={cc.cycleClassId}
                    type="radio"
                    name="class"
                    checked={cycleClassId === cc.cycleClassId}
                    onChange={() => setCycleClassId(cc.cycleClassId)}
                  >
                    {displayName(cc.classNameBn, cc.classNameEn, locale)}
                    {cc.groupNameBn && ` · ${displayName(cc.groupNameBn, cc.groupNameEn, locale)}`}
                  </ChoiceChip>
                ))}
              </fieldset>
            </div>
          ))}
          <Button disabled={!cycleClassId} onClick={() => setStep(phoneToken ? 'form' : 'phone')}>
            {t('next')}
          </Button>
        </section>
      )}

      {step === 'phone' && (
        <section className="flex flex-col gap-4" data-testid="apply-phone">
          <h2 className="font-semibold">{t('phoneTitle')}</h2>
          <TextField
            id="apply-phone"
            label={t('phone')}
            hint={t('phoneHint')}
            value={phone}
            onChange={setPhone}
            inputMode="tel"
            autoComplete="tel"
          />
          <TurnstileBox action="admission-otp" onToken={onRobot} resetKey={robotKey} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep('class')}>
              {t('back')}
            </Button>
            <Button className="flex-1" disabled={busy} onClick={() => void sendCode()}>
              {t('sendCode')}
            </Button>
          </div>
        </section>
      )}

      {step === 'code' && (
        <section className="flex flex-col gap-4" data-testid="apply-code">
          <h2 className="font-semibold">{t('codeTitle')}</h2>
          <p className="text-muted-foreground text-sm">
            {t('codeHint', { phone: formatBdPhone(normalizeBdPhone(phone) ?? phone) })}
          </p>
          <TextField
            id="apply-code"
            label={t('code')}
            value={code}
            onChange={setCode}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep('phone')}>
              {t('resend')}
            </Button>
            <Button className="flex-1" disabled={busy} onClick={() => void verifyCode()}>
              {t('verify')}
            </Button>
          </div>
        </section>
      )}

      {step === 'form' && (
        <form
          className="flex flex-col gap-5"
          noValidate
          data-testid="apply-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (
              Object.keys(localProblems({ ...values, phone: 'x' }, 'x')).length === 0 &&
              !photoMissing
            ) {
              setStep('review');
            }
          }}
        >
          <ApplicationFields
            values={values}
            onChange={setValues}
            errors={errors}
            settings={settings}
            showNote={false}
            showPhone={false}
            hideHidden
          />
          {settings && settings.photo !== 'HIDDEN' && (
            <div className="flex flex-col gap-2">
              <p className="font-medium">
                {t('photo')}
                {settings.photo === 'REQUIRED' && <span className="text-destructive">*</span>}
              </p>
              <p className="text-muted-foreground text-sm">{t('photoHint')}</p>
              {photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- a local preview
                <img src={photoUrl} alt="" className="aspect-[3/4] w-32 rounded-lg object-cover" />
              )}
              <ChooseImageButton
                opaque
                onChoose={choosePhoto}
                onTooLarge={() => setMessage(t('invalid'))}
              >
                {t('choosePhoto')}
              </ChooseImageButton>
              {touched && photoMissing && <p className="text-destructive text-sm">{required}</p>}
            </div>
          )}
          {/* The honeypot: hidden from people, filled by naive bots. */}
          <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
            <label htmlFor="website">{t('website')}</label>
            <input
              id="website"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep('class')}>
              {t('back')}
            </Button>
            <Button type="submit" className="flex-1" data-testid="apply-next">
              {t('next')}
            </Button>
          </div>
        </form>
      )}

      {step === 'review' && (
        <section className="flex flex-col gap-4" data-testid="apply-review">
          <h2 className="font-semibold">{t('reviewTitle')}</h2>
          <dl className="bg-card grid gap-2 rounded-xl border p-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('child')}</dt>
              <dd>{displayName(values.nameBn || null, values.nameEn || null, locale)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('class')}</dt>
              <dd>
                {(() => {
                  const cc = cycle?.classes.find((x) => x.cycleClassId === cycleClassId);
                  return cc ? displayName(cc.classNameBn, cc.classNameEn, locale) : '';
                })()}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('guardianPhone')}</dt>
              <dd className="font-mono">{formatBdPhone(normalizeBdPhone(phone) ?? phone)}</dd>
            </div>
          </dl>
          <TurnstileBox action="admission-submit" onToken={onRobot} resetKey={robotKey} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep('form')}>
              {t('back')}
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => void submit()}
              data-testid="apply-submit"
            >
              {t('submit')}
            </Button>
          </div>
        </section>
      )}

      {step === 'done' && (
        <section className="flex flex-col items-center gap-4 text-center" data-testid="apply-done">
          <CheckCircle2Icon aria-hidden className="text-success size-12" />
          <h2 className="text-lg font-semibold">{t('doneTitle')}</h2>
          <p
            className="bg-card w-full rounded-xl border p-4 font-mono text-2xl"
            data-testid="application-no"
          >
            {formatIdentifier(applicationNo)}
          </p>
          <p className="text-sm">{t('doneText', { no: formatIdentifier(applicationNo) })}</p>
          <div className="flex flex-wrap justify-center gap-2 print:hidden">
            <Button variant="outline" onClick={() => window.print()}>
              <PrinterIcon aria-hidden />
              {t('print')}
            </Button>
            <ButtonLink href={`/apply/${slug}/status`}>{t('statusLink')}</ButtonLink>
          </div>
        </section>
      )}
    </main>
  );
}
