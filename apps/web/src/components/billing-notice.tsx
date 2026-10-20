'use client';

import { formatCount, formatDate, formatTaka, type BillingNotice } from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { ReceiptTextIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';

/**
 * For the institute's owner only: Jantrik's invoices past their due date, as a gentle notice
 * (nothing is blocked; Jantrik follows up by phone).
 */
export function BillingNoticeBanner() {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const q = useQuery({
    queryKey: ['billing-notice', session?.tenant?.id],
    queryFn: () => client.api<BillingNotice>('/me/billing-notice'),
    staleTime: 10 * 60_000,
  });
  const o = q.data?.overdue;
  if (!o) return null;
  const amount = formatTaka(o.duePaisa, locale);
  // UTC noon: the same calendar day in any time zone.
  const date = formatDate(new Date(`${o.oldestDueOn}T12:00:00Z`), locale, 'medium');
  return (
    <div
      className="border-warning/40 bg-warning-soft mb-4 flex gap-3 rounded-xl border px-4 py-3"
      role="status"
      data-testid="billing-notice"
    >
      <ReceiptTextIcon aria-hidden className="text-warning mt-0.5 size-5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {o.count === 1
            ? t('billingNoticeOne', { amount, date })
            : t('billingNoticeMany', { count: formatCount(o.count, locale), amount, date })}
        </span>
        <span className="text-muted-foreground text-sm">{t('billingNoticeText')}</span>
      </div>
    </div>
  );
}
