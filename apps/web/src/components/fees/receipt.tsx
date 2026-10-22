'use client';

import {
  amountInWords,
  formatBdPhone,
  formatDate,
  formatTaka,
  type FeeReceipt,
} from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { pick, usePeriodLabel } from '@/lib/fees';
import { cn } from '@/lib/utils';

export type ReceiptPaper = 'a5' | '80';

/**
 * A money receipt (docs/fees.md → Receipts), the same for staff and guardians. Printing shows
 * only this (`.print-area`) on its own page size: A5, or 80 mm thermal paper (named @page rules
 * in globals.css, so the A4 register stays as it is). Black on white, no colour needed: a void
 * receipt says VOID in words, with the reason. Amounts in Bangla digits in bn; the receipt
 * number, student ID and TrxID always ASCII (identifiers).
 */
export function Receipt({ receipt, paper = 'a5' }: { receipt: FeeReceipt; paper?: ReceiptPaper }) {
  const t = useTranslations('fees.common.receipt');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as 'bn' | 'en';
  const period = usePeriodLabel();
  const isVoid = receipt.status === 'VOID';
  const fine = receipt.lines.reduce((s, l) => s + l.finePaisa, 0);
  const narrow = paper === '80';
  return (
    <article
      className={cn(
        'receipt print-area relative mx-auto flex flex-col gap-3 border bg-white p-4 text-black',
        narrow ? 'max-w-[80mm] text-[13px]' : 'max-w-[148mm] text-sm',
      )}
      data-paper={paper}
      data-testid="receipt"
      data-status={receipt.status}
      aria-label={`${t('title')} ${receipt.receiptNumber}`}
    >
      {isVoid && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
        >
          <span className="-rotate-12 rounded border-4 border-black px-4 py-1 text-5xl font-bold tracking-wide opacity-25">
            {t('void')}
          </span>
        </div>
      )}
      <header className="flex flex-col items-center gap-0.5 border-b border-black pb-2 text-center">
        <p className="text-base font-bold">{receipt.institute.name}</p>
        <p className="font-semibold">{t('title')}</p>
      </header>

      <dl className={cn('grid gap-x-3 gap-y-1', narrow ? 'grid-cols-1' : 'grid-cols-2')}>
        <div className="flex gap-1">
          <dt>{t('number')}:</dt>
          <dd className="font-mono font-semibold" data-testid="receipt-number">
            {receipt.receiptNumber}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('date')}:</dt>
          <dd>{formatDate(receipt.recordedOn, locale, 'long')}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('student')}:</dt>
          <dd className="font-semibold">{pick(locale, receipt.student)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('id')}:</dt>
          <dd className="font-mono">{receipt.student.studentCode}</dd>
        </div>
        {receipt.student.classLevel && (
          <div className="flex gap-1">
            <dt>{t('class')}:</dt>
            <dd>
              {pick(locale, receipt.student.classLevel)}
              {receipt.student.section ? `, ${receipt.student.section}` : ''}
              {receipt.student.roll !== null && (
                <>
                  {' · '}
                  {t('roll')} <span className="font-mono">{receipt.student.roll}</span>
                </>
              )}
            </dd>
          </div>
        )}
        {receipt.paidOn !== receipt.recordedOn && (
          <div className="flex gap-1">
            <dt>{t('paidOn')}:</dt>
            <dd>{formatDate(receipt.paidOn, locale, 'long')}</dd>
          </div>
        )}
      </dl>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-black">
            <th scope="col" className="py-1 text-left font-semibold">
              {t('head')}
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              {t('amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((l) => (
            <tr key={l.dueId} className="border-b border-dotted border-black/40">
              <td className="py-1 pr-2">
                {pick(locale, l.head)} <span className="text-black/70">· {period(l)}</span>
                {l.finePaisa > 0 && (
                  <span className="block text-black/70">
                    {t('fine')} {formatTaka(l.finePaisa, locale)}
                  </span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">
                {formatTaka(l.principalPaisa + l.finePaisa, locale)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {fine > 0 && (
            <tr>
              <td className="pt-1 text-right">{t('fine')}</td>
              <td className="pt-1 text-right tabular-nums">{formatTaka(fine, locale)}</td>
            </tr>
          )}
          <tr className="border-t border-black">
            <th scope="row" className="py-1 text-right font-bold">
              {t('total')}
            </th>
            <td className="py-1 text-right font-bold tabular-nums" data-testid="receipt-total">
              {formatTaka(receipt.amountPaisa, locale)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p>
        <span className="font-semibold">{t('inWords')}:</span>{' '}
        {amountInWords(receipt.amountPaisa, locale)}
      </p>

      <dl className="grid gap-y-1">
        <div className="flex gap-1">
          <dt>{t('method')}:</dt>
          <dd>{tMethod(receipt.method)}</dd>
        </div>
        {receipt.trxId && (
          <div className="flex gap-1">
            <dt>{t('trxId')}:</dt>
            <dd className="font-mono">{receipt.trxId}</dd>
          </div>
        )}
        {receipt.senderPhone && (
          <div className="flex gap-1">
            <dt>{t('sender')}:</dt>
            <dd className="font-mono">
              {receipt.senderPhone.startsWith('+')
                ? formatBdPhone(receipt.senderPhone)
                : receipt.senderPhone}
            </dd>
          </div>
        )}
        {receipt.collectedBy && (
          <div className="flex gap-1">
            <dt>{t('collectedBy')}:</dt>
            <dd>
              {pick(locale, {
                nameBn: receipt.collectedBy.nameBn,
                nameEn: receipt.collectedBy.name,
              })}
            </dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>{t('balanceToday')}:</dt>
          <dd className="tabular-nums">{formatTaka(receipt.balanceTodayPaisa, locale)}</dd>
        </div>
      </dl>

      {isVoid && receipt.void && (
        <p className="border border-black p-2" data-testid="receipt-void">
          <span className="font-bold">{t('void')}</span> · {t('voidReason')}: {receipt.void.reason}{' '}
          · {t('voidedBy')}:{' '}
          {pick(locale, { nameBn: receipt.void.by.nameBn, nameEn: receipt.void.by.name })} ·{' '}
          {formatDate(receipt.void.at, locale)}
        </p>
      )}
      {receipt.institute.receiptNote && (
        <p className="text-center">{receipt.institute.receiptNote}</p>
      )}
      {!narrow && (
        <p className="mt-6 self-end border-t border-black px-6 pt-1 text-center">
          {t('signature')}
        </p>
      )}
    </article>
  );
}
