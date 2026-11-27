'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatCount,
  type OnlinePaymentStaffView,
  type PaymentReviewQueue,
  type PaymentSignalItem,
} from '@jantrik/shared';
import { ShieldCheckIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { onlineKeys } from '@/components/fees/online/kit';
import {
  ApplyDialog,
  CheckedNotPayments,
  DismissDialog,
  RefundDialog,
  ReviewIntentCard,
  ReviewSignalCard,
} from '@/components/fees/online/review';
import { EmptyState, LoadError } from '@/components/fees/counter/kit';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useFeeRoles } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';

export default function OnlinePaymentsReviewPage() {
  return (
    <PageGate page="fees">
      <Review />
    </PageGate>
  );
}

type Open =
  | { action: 'apply'; item: OnlinePaymentStaffView }
  | { action: 'refund'; item: OnlinePaymentStaffView }
  | { action: 'dismiss'; item: OnlinePaymentStaffView }
  | { action: 'signalRefund'; item: PaymentSignalItem }
  | { action: 'signalDismiss'; item: PaymentSignalItem };

/**
 * The review queue for online payments (docs/payments.md → The review queue): what SSLCommerz
 * confirmed but nobody may post without a person (S23), oldest first. OWNER and ADMIN decide;
 * an accountant sees the queue and may ask SSLCommerz again (P7b-D).
 */
function Review() {
  const t = useTranslations('fees.review');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const { manages } = useFeeRoles();
  const describe = useErrorMessage();
  const [open, setOpen] = useState<Open | null>(null);
  const queue = useQuery({
    queryKey: onlineKeys.review(session?.tenant?.id),
    queryFn: () => client.api<PaymentReviewQueue>('/fees/online-payments/review'),
  });
  const data = queue.data;

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="online-review">
      <FeesTabs />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        </div>
        <Link href="/fees/online-payments" className="text-link text-sm font-medium">
          {t('allPayments')}
        </Link>
      </header>

      {queue.isPending ? (
        <div className="grid gap-(--gap) md:grid-cols-2 2xl:grid-cols-3" aria-busy="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="rounded-card h-96" />
          ))}
        </div>
      ) : queue.isError ? (
        <LoadError message={describe(queue.error)} onRetry={() => void queue.refetch()} />
      ) : data!.count === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          title={t('empty')}
          text={t('emptyHint')}
          testId="review-empty"
        />
      ) : (
        <>
          <p
            className="text-muted-foreground text-sm"
            aria-live="polite"
            data-testid="review-count"
          >
            {t('count', { count: formatCount(data!.count, locale), n: data!.count })}
          </p>
          <ul className="grid gap-(--gap) md:grid-cols-2 2xl:grid-cols-3" aria-label={t('title')}>
            {data!.intents.map((item) => (
              <ReviewIntentCard
                key={item.id}
                item={item}
                manages={manages}
                onApply={() => setOpen({ action: 'apply', item })}
                onRefund={() => setOpen({ action: 'refund', item })}
                onDismiss={() => setOpen({ action: 'dismiss', item })}
              />
            ))}
            {data!.signals.map((item) => (
              <ReviewSignalCard
                key={item.eventId}
                item={item}
                manages={manages}
                onRefund={() => setOpen({ action: 'signalRefund', item })}
                onDismiss={() => setOpen({ action: 'signalDismiss', item })}
              />
            ))}
          </ul>
        </>
      )}
      {data && <CheckedNotPayments checked={data.checked} />}

      {open?.action === 'apply' && (
        <ApplyDialog key={open.item.id} item={open.item} onClose={() => setOpen(null)} />
      )}
      {open?.action === 'refund' && (
        <RefundDialog
          key={open.item.id}
          target={{ kind: 'intent', id: open.item.id }}
          amountPaisa={
            open.item.money?.amountPaisa != null
              ? open.item.money.amountPaisa - (open.item.refundedOutside?.amountPaisa ?? 0)
              : null
          }
          onClose={() => setOpen(null)}
        />
      )}
      {open?.action === 'dismiss' && (
        <DismissDialog
          key={open.item.id}
          target={{ kind: 'intent', id: open.item.id }}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.action === 'signalRefund' && (
        <RefundDialog
          key={open.item.eventId}
          target={{ kind: 'signal', eventId: open.item.eventId }}
          amountPaisa={open.item.money.amountPaisa}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.action === 'signalDismiss' && (
        <DismissDialog
          key={open.item.eventId}
          target={{ kind: 'signal', eventId: open.item.eventId }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
