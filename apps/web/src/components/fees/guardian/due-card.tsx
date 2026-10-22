'use client';

import { formatDate, formatTaka, type FeeConcessionView, type FeeDueView } from '@jantrik/shared';
import { HourglassIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/config';
import { pick, usePeriodLabel } from '@/lib/fees';
import { cn } from '@/lib/utils';
import { DueStatusPill } from './status-pills';
import { dueState } from './use-child-fees';

/** The manual concession behind a due's discount, if one matches (for its name). */
function concessionFor(due: FeeDueView, concessions: FeeConcessionView[]) {
  return concessions.find(
    (c) =>
      c.feeHead.id === due.head.id &&
      c.academicYearId === due.academicYear.id &&
      c.validFrom <= due.dueDate &&
      (c.endedOn === null || c.endedOn > due.periodStart),
  );
}

function Row({
  term,
  children,
  note,
  strong,
}: {
  term: string;
  children: ReactNode;
  note?: string | null;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 py-1',
        strong && 'mt-1 border-t pt-2 font-semibold',
      )}
    >
      <dt className={cn('min-w-0', !strong && 'text-muted-foreground')}>
        {term}
        {note && <span className="text-muted-foreground block text-xs font-normal">{note}</span>}
      </dt>
      <dd className="num shrink-0">{children}</dd>
    </div>
  );
}

/**
 * One due as a guardian reads it: the fee and its period, the due date, then the sum written
 * out (fee, discount, late fine, paid) down to what is left, and its status in words.
 */
export function DueCard({
  due,
  concessions,
  pending,
}: {
  due: FeeDueView;
  concessions: FeeConcessionView[];
  /** A submission naming this due is waiting to be checked. */
  pending: boolean;
}) {
  const t = useTranslations('fees.guardian.dues');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const state = dueState(due);
  const taka = (paisa: number) => formatTaka(paisa, locale);
  // The fine after any waiver, so fee − discount + fine − paid adds up to what is left.
  const fine = due.balance.fine + due.paidFinePaisa;
  const paid = due.paidPrincipalPaisa + due.paidFinePaisa;
  const manual = due.concessionSource === 'MANUAL' ? concessionFor(due, concessions) : undefined;
  const concessionName =
    due.concessionSource === 'SIBLING'
      ? t('concessionSibling')
      : manual
        ? t(`category.${manual.category}`)
        : t('concession');
  const cancelled = state === 'CANCELLED';

  return (
    <li
      data-slot="card"
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-3 border p-(--panel-p)"
      data-testid="child-due"
      data-period-key={due.periodKey}
      data-status={state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className={cn('font-semibold wrap-break-word', cancelled && 'line-through')}>
            {pick(locale, due.head)}
            <span className="text-muted-foreground font-normal"> · {period(due)}</span>
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('dueDate', { date: formatDate(due.dueDate, locale) })}
          </p>
        </div>
        <span className="shrink-0">
          <DueStatusPill state={state} />
        </span>
      </div>

      <dl className="text-sm">
        <Row term={t('amount')}>
          <span className={cn(cancelled && 'line-through')}>{taka(due.amountPaisa)}</span>
        </Row>
        {due.concessionPaisa > 0 && <Row term={concessionName}>−{taka(due.concessionPaisa)}</Row>}
        {(fine > 0 || due.fineWaivedPaisa > 0) && (
          <Row
            term={t('fine')}
            note={
              due.fineWaivedPaisa > 0
                ? t('fineWaived', { amount: taka(due.fineWaivedPaisa) })
                : null
            }
          >
            {taka(fine)}
          </Row>
        )}
        {paid > 0 && <Row term={t('paid')}>−{taka(paid)}</Row>}
        {!cancelled && (
          <Row term={t('left')} strong>
            <span data-testid="child-due-left">
              {due.balance.total > 0 ? taka(due.balance.total) : '—'}
            </span>
          </Row>
        )}
      </dl>

      {pending && !cancelled && due.balance.total > 0 && (
        <p className="bg-info-soft text-info flex items-start gap-2 rounded-lg px-3 py-2 text-sm">
          <HourglassIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('pending')}
        </p>
      )}
      {cancelled && due.cancelReason && (
        <p className="text-muted-foreground text-sm">
          {t('cancelReason', { reason: due.cancelReason })}
        </p>
      )}
    </li>
  );
}
