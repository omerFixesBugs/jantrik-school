'use client';

import { formatBdPhone, formatDate, formatTaka, type FeeSubmissionView } from '@jantrik/shared';
import { ReceiptTextIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { ButtonLink } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { pick, usePeriodLabel } from '@/lib/fees';
import { SubmissionStatusPill } from './status-pills';

/** An E.164 number as people dial it (ASCII); a masked one as it came. */
export const showPhone = (phone: string) => (phone.startsWith('+') ? formatBdPhone(phone) : phone);

/**
 * The bKash/Nagad payments this child's guardians reported, newest first: waiting, verified
 * (with the receipt) or returned (with the reason and what to do).
 */
export function SubmissionList({
  childId,
  submissions,
}: {
  childId: string;
  submissions: FeeSubmissionView[];
}) {
  const t = useTranslations('fees.guardian.submissions');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="child-submissions-title">
      <h2 id="child-submissions-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <ul className="flex flex-col gap-(--gap)">
        {submissions.map((s) => (
          <li
            key={s.id}
            data-slot="card"
            className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-2 border p-(--panel-p)"
            data-testid="child-submission"
            data-trx={s.trxId}
            data-status={s.status}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="font-numeric text-xl font-semibold">
                  {formatTaka(s.amountPaisa, locale)}
                </span>
                <span className="text-muted-foreground text-sm">
                  {tMethod(s.method)} · {t('sent', { date: formatDate(s.sentOn, locale) })}
                </span>
              </div>
              <span className="shrink-0">
                <SubmissionStatusPill status={s.status} />
              </span>
            </div>

            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap gap-x-1.5">
                <dt className="text-muted-foreground">{t('trx')}:</dt>
                <dd className="font-mono font-medium break-all" dir="ltr">
                  {s.trxId}
                </dd>
              </div>
              <div className="text-muted-foreground">
                {t('to', { number: showPhone(s.account.phone) })}
                {s.account.label ? ` (${s.account.label})` : ''}
              </div>
              {s.dues.length > 0 && (
                <div className="text-muted-foreground">
                  {t('for', {
                    list: s.dues.map((d) => `${pick(locale, d.head)} · ${period(d)}`).join(', '),
                  })}
                </div>
              )}
            </dl>

            {s.status === 'PENDING' && (
              <p className="text-muted-foreground text-sm">{t('pendingHint')}</p>
            )}
            {s.status === 'REJECTED' && (
              <div className="bg-destructive-soft flex flex-col gap-1 rounded-lg px-3 py-2 text-sm">
                {s.rejectReason && (
                  <p className="text-destructive font-medium">
                    {t('rejectReason', { reason: s.rejectReason })}
                  </p>
                )}
                <p className="text-foreground">{t('rejectHint')}</p>
              </div>
            )}
            {s.status === 'VERIFIED' && s.receipt && (
              <ButtonLink
                variant="outline"
                className="self-start"
                href={`/children/${childId}/fees/receipts/${s.receipt.id}`}
                data-testid="child-submission-receipt"
              >
                <ReceiptTextIcon aria-hidden />
                {t('receipt')}
                <span className="font-mono text-xs" dir="ltr">
                  {s.receipt.receiptNumber}
                </span>
              </ButtonLink>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
