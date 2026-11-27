'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatTaka, formatIdentifier, type OnlinePaymentView } from '@jantrik/shared';
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  SearchXIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { abandonOffered } from '@/lib/online-payment';
import { useErrorMessage } from '@/lib/hooks';
import { GuardianNotice } from './guardian-gate';
import { childFeesKey } from './use-child-fees';

/** How often the page asks again: every second while the session is made (30 s), every 2 s for
 * two minutes after the gateway, then every 15 s. Final states are not asked again. */
function pollEvery(state: OnlinePaymentView['state'] | undefined, sinceMs: number): number | false {
  if (state === 'PREPARING') return sinceMs < 30_000 ? 1000 : 5000;
  if (state === 'READY' || state === 'CONFIRMING') return sinceMs < 120_000 ? 2000 : 15_000;
  return false;
}

/**
 * One online payment (sprint 1 P7a2): PREPARING → READY (off to SSLCommerz at once, with a button
 * as well) → back from the gateway CONFIRMING (the server asks SSLCommerz; "do not pay again";
 * "start again" once its query found nothing paid or pending) → PAID with the receipt, CHECKING
 * (the school checks it), NOT_PAID ("start again"), or EXPIRED. Coming back from the gateway
 * (`?from=gateway`) never sends the guardian there again.
 */
export function OnlinePaymentPage({ childId, intentId }: { childId: string; intentId: string }) {
  const t = useTranslations('fees.guardian.online.page');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const back = useSearchParams().get('from') === 'gateway';
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  // When the page opened: how often it asks again depends on how long it has waited.
  const [opened] = useState(() => Date.now());
  const sent = useRef(false);
  const [leaving, setLeaving] = useState(false);

  const q = useQuery({
    queryKey: ['online-payment', session?.tenant?.id, childId, intentId],
    queryFn: () =>
      client.api<OnlinePaymentView>(`/me/children/${childId}/fees/online-payments/${intentId}`),
    refetchInterval: (query) => pollEvery(query.state.data?.state, Date.now() - opened),
  });
  const payment = q.data;
  const ready = payment?.state === 'READY' && !back ? payment.checkoutUrl : undefined;

  // Straight on to the gateway once its page exists (only for the payer, never on the way back).
  useEffect(() => {
    if (ready && !sent.current) {
      sent.current = true;
      setLeaving(true);
      window.location.assign(ready);
    }
  }, [ready]);

  // A final state: the fees page shows the change (a receipt, the dues paid).
  const final = payment && !['PREPARING', 'READY', 'CONFIRMING'].includes(payment.state);
  useEffect(() => {
    if (final) {
      void queryClient.invalidateQueries({ queryKey: childFeesKey(session?.tenant?.id, childId) });
    }
  }, [final, queryClient, session?.tenant?.id, childId]);

  const abandon = useMutation({
    mutationFn: () =>
      client.api<OnlinePaymentView>(
        `/me/children/${childId}/fees/online-payments/${intentId}/abandon`,
        { method: 'POST' },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: childFeesKey(session?.tenant?.id, childId) });
      router.push(`/children/${childId}/fees?pay=online`);
    },
  });

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)" aria-label={tCommon('loading')}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="rounded-card h-56" />
      </div>
    );
  }
  if (q.isError) {
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <GuardianNotice
        icon={SearchXIcon}
        title={t('notFoundTitle')}
        text={t('notFoundText')}
        testId="online-payment-not-found"
      />
    ) : (
      <Alert variant="destructive">
        <AlertDescription className="text-destructive flex flex-wrap items-center justify-between gap-2">
          <span>{describe(q.error)}</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {tCommon('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const p = payment!;
  const shown = back && p.state === 'READY' ? 'CONFIRMING' : p.state;
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const tone =
    shown === 'PAID'
      ? { icon: CircleCheckIcon, tile: 'bg-success-soft text-success' }
      : shown === 'NOT_PAID' || shown === 'EXPIRED' || shown === 'REFUNDED'
        ? { icon: CircleXIcon, tile: 'bg-muted text-muted-foreground' }
        : shown === 'CHECKING'
          ? { icon: ShieldCheckIcon, tile: 'bg-info-soft text-info' }
          : {
              icon: shown === 'CONFIRMING' ? ClockIcon : LoaderCircleIcon,
              tile: 'bg-primary-soft text-primary-ink',
            };
  const Icon = tone.icon;
  // "Start again": also from "confirming" once our query found nothing at SSLCommerz (P7a2-x31).
  const offerAbandon = abandonOffered(p, shown);

  return (
    <div className="flex min-w-0 flex-col gap-(--section-gap)" data-testid="online-payment">
      <ButtonLink
        variant="ghost"
        size="sm"
        href={`/children/${childId}/fees`}
        className="-ms-2 self-start"
      >
        <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
        {t('back')}
      </ButtonLink>
      <section
        data-slot="card"
        className="bg-card rounded-card shadow-card flex flex-col items-center gap-3 border p-(--panel-p) text-center"
        aria-live="polite"
      >
        <span className={`flex size-14 items-center justify-center rounded-2xl ${tone.tile}`}>
          <Icon
            aria-hidden
            className={`size-7 ${shown === 'PREPARING' || leaving ? 'motion-safe:animate-spin' : ''}`}
          />
        </span>
        <h1 className="text-xl font-semibold" data-testid="online-payment-state" data-state={shown}>
          {leaving ? t('leaving') : t(`state.${shown}.title`)}
        </h1>
        <p className="text-muted-foreground max-w-md">{t(`state.${shown}.text`)}</p>
        {shown === 'CONFIRMING' && offerAbandon && (
          <p className="max-w-md text-sm" data-testid="online-nothing-found">
            {t('nothingFound')}
          </p>
        )}
        <p
          className="font-numeric text-[2rem] leading-none font-light"
          data-testid="online-payment-amount"
        >
          {taka(p.amountPaisa)}
        </p>
        {shown === 'READY' && p.checkoutUrl && (
          <Button
            size="lg"
            onClick={() => window.location.assign(p.checkoutUrl!)}
            data-testid="online-go"
          >
            <ExternalLinkIcon aria-hidden />
            {t('go')}
          </Button>
        )}
        {shown === 'PAID' && p.receipt && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm">
              {t('receiptNumber')}{' '}
              <span
                className="font-mono font-semibold"
                dir="ltr"
                data-testid="online-receipt-number"
              >
                {p.receipt.receiptNumber}
              </span>
            </p>
            <ButtonLink
              size="lg"
              href={`/children/${childId}/fees/receipts/${p.receipt.id}`}
              data-testid="online-view-receipt"
            >
              {t('viewReceipt')}
            </ButtonLink>
          </div>
        )}
        {(shown === 'NOT_PAID' || shown === 'EXPIRED') && (
          <div className="flex flex-wrap justify-center gap-2">
            <ButtonLink
              size="lg"
              href={`/children/${childId}/fees?pay=online`}
              data-testid="online-start-again"
            >
              {t('startAgain')}
            </ButtonLink>
            <ButtonLink size="lg" variant="outline" href={`/children/${childId}/fees`}>
              {t('payOtherWay')}
            </ButtonLink>
          </div>
        )}
        {offerAbandon && (
          <Button
            variant="ghost"
            onClick={() => abandon.mutate()}
            disabled={abandon.isPending}
            data-testid="online-abandon"
          >
            {t('abandon')}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="online-dues-title">
        <h2 id="online-dues-title" className="text-lg font-semibold">
          {t('dues')}
        </h2>
        <ul className="bg-card divide-y rounded-xl border">
          {p.dues.map((d) => (
            <li key={d.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
              <span className="min-w-0 wrap-break-word">
                {pick(locale, d.head)}
                <span className="text-muted-foreground"> · {period(d)}</span>
                {d.finePaisa > 0 && (
                  <span className="text-muted-foreground block text-sm">
                    {t('fine', { amount: taka(d.finePaisa) })}
                  </span>
                )}
              </span>
              <span className="num shrink-0 font-medium">
                {taka(d.principalPaisa + d.finePaisa)}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-sm">
          {t('tranId')}{' '}
          <span className="font-mono" dir="ltr">
            {formatIdentifier(p.tranId)}
          </span>
        </p>
      </section>
    </div>
  );
}
