'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatIdentifier,
  formatTime,
  type OnlinePaymentCheckQueued,
  type PaymentIntentStatus,
} from '@jantrik/shared';
import { RefreshCwIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Pill, type PillTone } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * Online payments for staff (sprint 1 P7b, docs/payments.md → The review queue): the pieces the
 * list, the review queue and the reports share.
 */

/** Every staff fee query starts with 'fees': a decision refreshes them all (closing, reports…). */
export const onlineKeys = {
  list: (tenantId: string | undefined, query: string) =>
    ['fees', 'online', tenantId, 'list', query] as const,
  review: (tenantId: string | undefined) => ['fees', 'online', tenantId, 'review'] as const,
  count: (tenantId: string | undefined) => ['fees', 'online', tenantId, 'count'] as const,
};

export function useRefreshOnline() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['fees'] });
}

const STATUS_TONE: Record<PaymentIntentStatus, PillTone> = {
  CREATED: 'neutral',
  REDIRECTED: 'info',
  PAID: 'success',
  FAILED: 'neutral',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  NEEDS_REVIEW: 'warning',
  REFUNDED_OUTSIDE: 'accent',
  DISMISSED: 'neutral',
};

export function OnlineStatusPill({ status }: { status: PaymentIntentStatus }) {
  const t = useTranslations('fees.online.status');
  return (
    <Pill tone={STATUS_TONE[status]} className="whitespace-nowrap">
      {t(status)}
    </Pill>
  );
}

/** An identifier (our tran_id, the bank's, a val_id): ASCII, left to right, selectable. */
export function Ident({ value, className }: { value: string | null; className?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('font-mono text-sm break-all select-all', className)} dir="ltr">
      {formatIdentifier(value)}
    </span>
  );
}

/** What a due is, in words: "বেতন · অক্টোবর ২০২৬". */
export function useDueName() {
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  return (due: {
    head: { nameBn: string; nameEn: string };
    periodKey: string;
    term?: { nameBn: string; nameEn: string } | null;
  }) => `${pick(locale, due.head)} · ${period(due)}`;
}

/** When SSLCommerz was last asked and what it said, in words. */
export function LastCheck({ check }: { check: { at: string; outcome: string } | null }) {
  const t = useTranslations('fees.online');
  const locale = useLocale() as Locale;
  if (!check) return <span className="text-muted-foreground">{t('never')}</span>;
  const known = ['SUCCESS_FOUND', 'PENDING', 'NO_SUCCESS'].includes(check.outcome);
  return (
    <span>
      {t('lastCheckAt', {
        date: formatDate(check.at, locale, 'medium'),
        time: formatTime(check.at, locale),
      })}
      {' · '}
      {known
        ? t(`checkOutcome.${check.outcome as 'SUCCESS_FOUND' | 'PENDING' | 'NO_SUCCESS'}`)
        : t('checkOutcome.other', { code: check.outcome })}
    </span>
  );
}

/** "Check with SSLCommerz" (any fee staff): queues a query; the answer arrives on the item. */
export function CheckButton({
  intentId,
  size = 'sm',
  className,
}: {
  intentId: string;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const t = useTranslations('fees.online');
  const describe = useErrorMessage();
  const { client } = useAuth();
  const refresh = useRefreshOnline();
  const check = useMutation({
    mutationFn: () =>
      client.api<OnlinePaymentCheckQueued>(`/fees/online-payments/${intentId}/check`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success(t('checkQueued'));
      // The job answers within seconds: look again a little later.
      setTimeout(refresh, 3_000);
      setTimeout(refresh, 10_000);
    },
    onError: (e) =>
      toast.error(e instanceof ApiError && e.status === 429 ? t('checkTooSoon') : describe(e)),
  });
  return (
    <Button
      variant="outline"
      size={size}
      className={className}
      onClick={() => check.mutate()}
      disabled={check.isPending}
      data-testid="online-check"
    >
      <RefreshCwIcon aria-hidden className={cn(check.isPending && 'animate-spin')} />
      {t('check')}
    </Button>
  );
}
