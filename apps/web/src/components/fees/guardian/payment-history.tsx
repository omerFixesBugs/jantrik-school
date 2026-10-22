'use client';

import { formatDate, formatTaka, type FeePaymentSummary } from '@jantrik/shared';
import { BanIcon, ChevronRightIcon, ReceiptTextIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Pill } from '@/components/kit/pill';
import type { Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';

/**
 * Every receipt of this child, newest first (void ones stay, marked): the receipt number (ASCII),
 * the date, the method and the amount; each opens the printable receipt.
 */
export function PaymentHistory({
  childId,
  payments,
}: {
  childId: string;
  payments: FeePaymentSummary[];
}) {
  const t = useTranslations('fees.guardian.payments');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="child-payments-title">
      <h2 id="child-payments-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      {payments.length === 0 ? (
        <p
          className="bg-card rounded-card text-muted-foreground border px-4 py-6 text-sm"
          data-testid="child-receipts-empty"
        >
          {t('empty')}
        </p>
      ) : (
        <ul
          data-slot="card"
          className="bg-card rounded-card shadow-card flex flex-col overflow-hidden border"
        >
          {payments.map((p) => {
            const isVoid = p.status === 'VOID';
            return (
              <li key={p.id} className="border-t first:border-t-0">
                <Link
                  href={`/children/${childId}/fees/receipts/${p.id}`}
                  className="hover:bg-muted focus-visible:ring-ring flex min-h-14 items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  data-testid="child-receipt"
                  data-receipt-number={p.receiptNumber}
                  data-status={p.status}
                >
                  <span className="bg-primary-soft text-primary-ink flex size-9 shrink-0 items-center justify-center rounded-xl">
                    <ReceiptTextIcon aria-hidden className="size-4.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm">
                      <span className="text-muted-foreground">{t('receiptNo')} </span>
                      <span className="font-mono font-medium" dir="ltr">
                        {p.receiptNumber}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {formatDate(p.recordedOn, locale)} · {tMethod(p.method)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={cn(
                        'font-numeric font-semibold',
                        isVoid && 'text-muted-foreground line-through',
                      )}
                    >
                      {formatTaka(p.amountPaisa, locale)}
                    </span>
                    {isVoid && (
                      <Pill tone="neutral">
                        <BanIcon aria-hidden className="size-3.5 shrink-0" />
                        {t('void')}
                      </Pill>
                    )}
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
