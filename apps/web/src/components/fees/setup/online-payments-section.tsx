'use client';

import { useMutation } from '@tanstack/react-query';
import {
  formatDate,
  formatIdentifier,
  formatTime,
  type GatewayAccountView,
  type GatewayTestQueued,
} from '@jantrik/shared';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CopyIcon,
  CreditCardIcon,
  LockIcon,
  PlugZapIcon,
  PowerIcon,
  PowerOffIcon,
  SaveIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SectionCard, TextField } from '@/components/form-kit';
import { Pill, type PillTone } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useFeeRoles } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { fieldsFromError, LoadError, useFeeQuery, useInvalidateFees } from './kit';

const PATH = '/fees/online-payments/account';
/** How long the page waits for a connection test's result (the job gives up after 30 s). */
const TEST_WAIT_MS = 45_000;

type Status = 'notSetUp' | 'off' | 'on';
const STATUS_TONE: Record<Status, PillTone> = {
  notSetUp: 'neutral',
  off: 'warning',
  on: 'success',
};
const RESULT_TONE: Record<string, PillTone> = {
  OK: 'success',
  BAD_CREDENTIALS: 'destructive',
  STORE_INACTIVE: 'destructive',
  UNREACHABLE: 'warning',
  ERROR: 'warning',
};
const KNOWN_FAILURES = ['CREDENTIALS_UNREADABLE', 'AUTH_FAILED', 'STORE_INACTIVE'];

/**
 * Online payments through SSLCommerz (sprint 1 P7a, docs/payments.md): the institute's own
 * sandbox store. Only the owner sees it (where money goes). The store ID and password are
 * write-only: the form is never pre-filled and the server never sends them back. Testing runs on
 * the server (a job); the page waits for its result. On only after a passing test.
 */
export function OnlinePaymentsSection() {
  const t = useTranslations('fees.setup.online');
  const { isOwner } = useFeeRoles();
  const account = useFeeQuery<GatewayAccountView>(isOwner ? PATH : null);
  const { refetch: refetchAccount } = account;
  const refetch = useCallback(() => void refetchAccount(), [refetchAccount]);
  if (!isOwner) {
    return (
      <SectionCard id="fees-online" title={t('title')}>
        <p
          className="bg-muted flex gap-2 rounded-xl p-3 text-sm"
          data-testid="fees-online-owner-only"
        >
          <LockIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          {t('ownerOnly')}
        </p>
      </SectionCard>
    );
  }
  return account.isPending ? (
    <Skeleton className="h-96 rounded-xl" />
  ) : account.isError ? (
    <LoadError error={account.error} onRetry={() => void account.refetch()} />
  ) : (
    <OnlinePayments view={account.data} refetch={refetch} />
  );
}

function useOnlineError() {
  const t = useTranslations('fees.setup.online.errors');
  const generic = useErrorMessage();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.code === 'TEST_REQUIRED') return t('testRequired');
      if (e.code === 'API_PUBLIC_URL_MISSING') return t('noPublicAddress');
      if (e.code === 'CREDENTIALS_REQUIRED') return t('credentialsRequired');
      if (e.status === 400) return t('checkForm');
    }
    return generic(e);
  };
}

function OnlinePayments({ view, refetch }: { view: GatewayAccountView; refetch: () => void }) {
  const t = useTranslations('fees.setup.online');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const invalidate = useInvalidateFees();
  const errorText = useOnlineError();
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const status: Status = !view.configured ? 'notSetUp' : view.enabled ? 'on' : 'off';
  const waiting = waitingSince !== null && !(view.lastTest && view.lastTest.at >= waitingSince);

  // A queued test: ask again every 1.5 s until its result is on the view (or give up).
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(refetch, 1500);
    const stop = setTimeout(() => {
      setWaitingSince(null);
      toast.error(t('testSlow'));
    }, TEST_WAIT_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [waiting, refetch, t]);

  const call = <T,>(action: 'test' | 'enable' | 'disable') =>
    client.api<T>(`${PATH}/${action}`, { method: 'POST' });
  const test = useMutation({
    mutationFn: () => call<GatewayTestQueued>('test'),
    onSuccess: (queued) => setWaitingSince(queued.requestedAt),
    onError: (e) => toast.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => call<GatewayAccountView>(on ? 'enable' : 'disable'),
    onSuccess: (next) => {
      void invalidate();
      toast.success(next.enabled ? t('turnedOn') : t('turnedOff'));
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const at = (iso: string) => `${formatDate(iso, locale)}, ${formatTime(iso, locale)}`;
  const canTurnOn = view.configured && view.lastTest?.result === 'OK' && view.ipnUrl !== null;

  return (
    <>
      <SectionCard
        id="fees-online"
        title={t('title')}
        hint={t('hint')}
        actions={<Pill tone="info">{t('sandbox')}</Pill>}
      >
        <dl className="grid gap-3 sm:grid-cols-2" data-testid="fees-online-status">
          <Fact label={t('statusLabel')}>
            <Pill tone={STATUS_TONE[status]}>
              <span data-testid="fees-online-state">{t(`status.${status}`)}</span>
            </Pill>
          </Fact>
          <Fact label={t('storeLabel')}>
            {view.hint ? (
              <span className="font-mono" data-testid="fees-online-hint" dir="ltr">
                ••••{formatIdentifier(view.hint)}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('noStore')}</span>
            )}
          </Fact>
          <Fact label={t('lastTestLabel')}>
            {waiting ? (
              <span className="text-muted-foreground" aria-live="polite">
                {t('testing')}
              </span>
            ) : view.lastTest ? (
              <span className="flex flex-wrap items-center gap-2" aria-live="polite">
                <Pill tone={RESULT_TONE[view.lastTest.result] ?? 'warning'}>
                  <span data-testid="fees-online-test-result">
                    {t(`result.${view.lastTest.result}`)}
                  </span>
                </Pill>
                <span className="text-muted-foreground text-sm">{at(view.lastTest.at)}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{t('neverTested')}</span>
            )}
          </Fact>
          {view.lastFailure && (
            <Fact label={t('lastFailureLabel')}>
              <span className="text-sm">
                {t(
                  `failure.${KNOWN_FAILURES.includes(view.lastFailure.code) ? view.lastFailure.code : 'OTHER'}`,
                )}{' '}
                <span className="text-muted-foreground">{at(view.lastFailure.at)}</span>
              </span>
            </Fact>
          )}
        </dl>
        {view.lastTest && view.lastTest.result !== 'OK' && !waiting && (
          <p className="bg-warning-soft text-warning flex gap-2 rounded-xl p-3 text-sm">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t(`resultHelp.${view.lastTest.result}`)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!view.configured || waiting || test.isPending}
            onClick={() => test.mutate()}
            data-testid="fees-online-test"
          >
            <PlugZapIcon aria-hidden />
            {waiting ? t('testing') : t('test')}
          </Button>
          {view.enabled ? (
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
              data-testid="fees-online-disable"
            >
              <PowerOffIcon aria-hidden />
              {t('turnOff')}
            </Button>
          ) : (
            <Button
              disabled={!canTurnOn || toggle.isPending || waiting}
              onClick={() => toggle.mutate(true)}
              data-testid="fees-online-enable"
            >
              <PowerIcon aria-hidden />
              {t('turnOn')}
            </Button>
          )}
        </div>
        {!view.enabled && view.configured && !canTurnOn && !waiting && (
          <p className="text-muted-foreground text-sm">
            {view.ipnUrl === null ? t('errors.noPublicAddress') : t('turnOnNeedsTest')}
          </p>
        )}
      </SectionCard>
      <CredentialsForm configured={view.configured} enabled={view.enabled} />
      <IpnAddress url={view.ipnUrl} />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex min-h-7 items-center">{children}</dd>
    </div>
  );
}

/** The write-only form: empty every time, cleared after a save. */
function CredentialsForm({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  const t = useTranslations('fees.setup.online');
  const { client } = useAuth();
  const invalidate = useInvalidateFees();
  const errorText = useOnlineError();
  const [storeId, setStoreId] = useState('');
  const [storePassword, setStorePassword] = useState('');
  const [bad, setBad] = useState<Set<string>>(new Set());
  const save = useMutation({
    mutationFn: () =>
      client.api<GatewayAccountView>(PATH, {
        method: 'PUT',
        json: { storeId: storeId.trim(), storePassword },
      }),
    onSuccess: () => {
      setStoreId('');
      setStorePassword('');
      setBad(new Set());
      void invalidate();
      toast.success(t('saved'));
    },
    onError: (e) => {
      setBad(fieldsFromError(e));
      toast.error(errorText(e));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (storeId.trim() && storePassword) save.mutate();
  };
  return (
    <SectionCard
      id="fees-online-credentials"
      title={configured ? t('replaceTitle') : t('credentialsTitle')}
      hint={t('credentialsHint')}
    >
      <form className="grid gap-4 lg:grid-cols-2" onSubmit={submit} autoComplete="off">
        <TextField
          id="online-store-id"
          label={t('storeId')}
          value={storeId}
          onChange={setStoreId}
          error={bad.has('storeId') ? t('errors.storeId') : null}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          required
          data-testid="fees-online-store-id"
        />
        <TextField
          id="online-store-password"
          label={t('storePassword')}
          type="password"
          value={storePassword}
          onChange={setStorePassword}
          error={bad.has('storePassword') ? t('errors.storePassword') : null}
          autoComplete="new-password"
          spellCheck={false}
          dir="ltr"
          required
          data-testid="fees-online-store-password"
        />
        <div className="flex flex-col gap-2 lg:col-span-2">
          {enabled && <p className="text-muted-foreground text-sm">{t('replaceTurnsOff')}</p>}
          <div>
            <Button
              type="submit"
              disabled={!storeId.trim() || !storePassword || save.isPending}
              data-testid="fees-online-save"
            >
              <SaveIcon aria-hidden />
              {t('save')}
            </Button>
          </div>
        </div>
      </form>
    </SectionCard>
  );
}

/** What the owner pastes into the SSLCommerz panel as the IPN address. */
function IpnAddress({ url }: { url: string | null }) {
  const t = useTranslations('fees.setup.online');
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  return (
    <SectionCard id="fees-online-ipn" title={t('ipnTitle')} hint={t('ipnHint')}>
      {url ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            readOnly
            value={url}
            dir="ltr"
            aria-label={t('ipnTitle')}
            className="font-mono text-sm"
            onFocus={(e) => e.currentTarget.select()}
            data-testid="fees-online-ipn-url"
          />
          <Button variant="outline" onClick={() => void copy()} data-testid="fees-online-ipn-copy">
            <CopyIcon aria-hidden />
            {t('copy')}
          </Button>
        </div>
      ) : (
        <p className="bg-muted flex gap-2 rounded-xl p-3 text-sm">
          <CreditCardIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          {t('ipnMissing')}
        </p>
      )}
      <p className="text-muted-foreground flex gap-2 text-sm">
        <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('sandboxNote')}
      </p>
    </SectionCard>
  );
}
