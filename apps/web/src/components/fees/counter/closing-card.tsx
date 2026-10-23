'use client';

import {
  formatCount,
  formatDate,
  formatTaka,
  type FeeClosing,
  type FeeClosingCollector,
} from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/config';
import { pick } from '@/lib/fees';
import { cn } from '@/lib/utils';

/*
 * The day's money per collector (docs/fees.md → Daily closing): what was collected, the voids made
 * that day (deducted that day, listed with their own receipt's date), by method, and what should
 * be in hand. Black on white in print, so the figures read without colour.
 */

/** A big light figure with its word above and an optional note under it. */
function Figure({
  term,
  value,
  note,
  strong,
  testId,
}: {
  term: string;
  value: string;
  note?: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex grow basis-32 flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm font-medium">{term}</dt>
      <dd
        className={cn(
          'font-numeric leading-tight',
          strong ? 'text-[1.75rem] font-semibold' : 'text-2xl font-light',
        )}
        data-testid={testId}
      >
        {value}
      </dd>
      {note && <dd className="text-muted-foreground text-xs">{note}</dd>}
    </div>
  );
}

export function ClosingCollectorCard({ entry }: { entry: FeeClosingCollector }) {
  const t = useTranslations('fees.counter.closing');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const voided = entry.voided.reduce((sum, v) => sum + v.amountPaisa, 0);
  const name =
    pick(locale, { nameBn: entry.collector.nameBn, nameEn: entry.collector.name }) || '—';
  const headingId = `closing-${entry.collector.id}`;
  return (
    <section
      data-slot="card"
      aria-labelledby={headingId}
      data-testid="fees-closing-collector"
      data-collector-id={entry.collector.id}
      className="bg-card rounded-card shadow-card flex min-w-0 break-inside-avoid flex-col gap-4 border p-(--panel-p) print:shadow-none"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={headingId} className="text-base font-semibold">
          {name}
        </h3>
        <p className="text-muted-foreground text-sm">
          {entry.receipts
            ? entry.receipts.first === entry.receipts.last
              ? t.rich('receiptOne', { number: entry.receipts.first, n: mono })
              : t.rich('receipts', { ...entry.receipts, n: mono })
            : t('noReceipts')}
        </p>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-3">
        <Figure
          term={t('collected')}
          value={taka(entry.collected.amountPaisa)}
          note={t('receiptCount', {
            count: formatCount(entry.collected.count, locale),
            n: entry.collected.count,
          })}
        />
        <Figure term={t('voided')} value={voided > 0 ? `− ${taka(voided)}` : '—'} />
        <Figure
          term={t('net')}
          value={taka(entry.net.amountPaisa)}
          note={t('netHint')}
          testId="fees-closing-net"
        />
        <Figure
          term={t('cashInHand')}
          value={taka(entry.cashInHandPaisa)}
          note={t('cashInHandHint')}
          strong
          testId="fees-closing-cash"
        />
      </dl>

      {entry.byMethod.length > 0 && (
        <table className="w-full text-sm">
          <caption className="mb-1 text-start text-sm font-medium">{t('byMethod')}</caption>
          <thead>
            <tr className="text-muted-foreground border-b">
              <th scope="col" className="py-1.5 text-start font-medium">
                {t('method')}
              </th>
              <th scope="col" className="num py-1.5 font-medium">
                {t('count')}
              </th>
              <th scope="col" className="num py-1.5 font-medium">
                {t('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.byMethod.map((m) => (
              <tr key={m.method} className="border-b last:border-b-0">
                <th scope="row" className="py-1.5 text-start font-normal">
                  {tMethod(m.method)}
                </th>
                <td className="num py-1.5">{formatCount(m.count, locale)}</td>
                <td className="num py-1.5">{taka(m.amountPaisa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entry.voided.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-sm font-medium">{t('voidedList')}</h4>
          <ul className="flex flex-col gap-1.5" data-testid="fees-closing-voided">
            {entry.voided.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/fees/receipts/${v.id}`}
                  className="hover:bg-muted focus-visible:ring-ring flex items-start justify-between gap-3 rounded-xl border px-3 py-2 outline-none focus-visible:ring-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">
                      <span className="font-mono font-medium" dir="ltr">
                        {v.receiptNumber}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        · {t('voidedOf', { date: formatDate(v.recordedOn, locale) })}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-sm">{v.reason}</span>
                  </span>
                  <span className="font-numeric shrink-0 text-sm font-semibold">
                    − {taka(v.amountPaisa)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Receipt numbers are identifiers: ASCII, left to right, whatever the language around them. */
const mono = (chunks: ReactNode) => (
  <span className="text-foreground font-mono" dir="ltr">
    {chunks}
  </span>
);

/** Everyone's totals for the day (shown when more than one person collected). */
export function ClosingTotals({ total }: { total: FeeClosing['total'] }) {
  const t = useTranslations('fees.counter.closing');
  const locale = useLocale() as Locale;
  const taka = (paisa: number) => formatTaka(paisa, locale);
  return (
    <section
      data-slot="card"
      aria-labelledby="closing-total"
      data-testid="fees-closing-total"
      className="bg-card rounded-card shadow-card flex min-w-0 break-inside-avoid flex-col gap-4 border p-(--panel-p) print:shadow-none"
    >
      <h3 id="closing-total" className="text-base font-semibold">
        {t('total')}
      </h3>
      <dl className="flex flex-wrap gap-x-6 gap-y-3">
        <Figure term={t('collected')} value={taka(total.collectedPaisa)} />
        <Figure
          term={t('voided')}
          value={total.voidedPaisa > 0 ? `− ${taka(total.voidedPaisa)}` : '—'}
        />
        <Figure term={t('net')} value={taka(total.netPaisa)} note={t('netHint')} />
        <Figure
          term={t('cashInHand')}
          value={taka(total.cashInHandPaisa)}
          note={t('cashInHandHint')}
          strong
        />
      </dl>
    </section>
  );
}
