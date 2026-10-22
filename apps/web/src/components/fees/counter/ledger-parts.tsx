'use client';

import {
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  type FeeConcessionView,
  type FeeDueView,
  type FeeLedger,
  type FeePaymentSummary,
  type FeeUpcomingDue,
  type FeeWaiverView,
} from '@jantrik/shared';
import { BadgePercentIcon, BanIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import { Pill } from '@/components/kit/pill';
import { PersonAvatar } from '@/components/person-avatar';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { pick, usePeriodLabel } from '@/lib/fees';
import { cn } from '@/lib/utils';
import { phoneText, StatusPill, StudentStatusPill, usePlace } from './kit';

/*
 * The parts of a student's fee ledger at the counter (docs/fees.md → Collecting cash): who it is,
 * each due as a card (phone-first), the periods that can be paid ahead, the payments, and the
 * concessions and waivers behind the figures. Money is tabular and right-aligned; "—" for none.
 */

/** Whose ledger this is: name, class, ID (ASCII) and the primary guardian. */
export function StudentHeader({ ledger }: { ledger: FeeLedger }) {
  const t = useTranslations('fees.counter');
  const locale = useLocale() as Locale;
  const place = usePlace();
  const s = ledger.student;
  const name = pick(locale, s);
  const g = s.guardian;
  return (
    <section
      data-slot="card"
      aria-labelledby="fees-student-name"
      className="bg-card rounded-card shadow-card flex min-w-0 items-start gap-3 border p-(--panel-p)"
      data-testid="fees-student"
    >
      <PersonAvatar name={name} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 id="fees-student-name" className="min-w-0 py-0.5 text-lg leading-snug font-semibold">
            {name}
          </h2>
          <StudentStatusPill status={s.status} />
          {ledger.family && (
            <Pill tone="accent">
              {t('ledger.family', { rank: formatCount(ledger.family.rank, locale) })}
            </Pill>
          )}
        </div>
        <p className="text-muted-foreground text-sm">{place(s.enrolment, locale)}</p>
        <p className="text-muted-foreground text-sm">
          {t('search.id')}{' '}
          <span className="text-foreground font-medium tabular-nums" dir="ltr">
            {formatIdentifier(s.studentCode)}
          </span>
        </p>
        {g && (
          <p className="text-muted-foreground flex min-w-0 flex-wrap gap-x-1.5 text-sm">
            <span>{t('search.guardian')}:</span>
            <span className="min-w-0">{pick(locale, g)}</span>
            <span className="tabular-nums" dir="ltr">
              {phoneText(g.phone)}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

/** One figure of a due's breakdown: the word on the left, the amount on the right. */
function Figure({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="num ms-auto">
        {value}
        {note && <span className="text-muted-foreground block text-xs">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * A due as a card: head and period, due date, what it owes, and (for an open due) the breakdown.
 * An open due with something owed has a checkbox; its label is the whole text block, so the
 * target is large. Cancelled dues stay, struck through and labelled (never disappear).
 */
export function DueCard({
  due,
  checked,
  onToggle,
  manages,
  onAction,
}: {
  due: FeeDueView;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  manages: boolean;
  onAction: (kind: 'waive' | 'cancel') => void;
}) {
  const t = useTranslations('fees.counter');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const id = useId();
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const dash = (paisa: number) => (paisa > 0 ? taka(paisa) : '—');
  const cancelled = due.status === 'CANCELLED';
  const owing = !cancelled && due.balance.total > 0;
  const head = pick(locale, due.head);
  const when = period(due);
  const paid = due.paidPrincipalPaisa + due.paidFinePaisa;
  const canWaive = manages && owing && due.balance.fine > 0;
  const canCancel = manages && !cancelled && paid === 0;

  const text = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'min-w-0 py-0.5 leading-snug font-medium',
            cancelled && 'text-muted-foreground line-through',
          )}
        >
          {head} <span className="text-muted-foreground font-normal">· {when}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="font-numeric text-base font-semibold">
            {owing ? taka(due.balance.total) : '—'}
          </span>
          {owing && <span className="text-muted-foreground text-xs">{t('ledger.owed')}</span>}
        </span>
      </span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>{t('ledger.dueOn', { date: formatDate(due.dueDate, locale) })}</span>
        {cancelled ? (
          <StatusPill kind="cancelled">{t('ledger.cancelledPill')}</StatusPill>
        ) : !owing && due.amountPaisa - due.concessionPaisa <= 0 ? (
          <Pill tone="neutral">{t('ledger.advanceFree')}</Pill>
        ) : !owing ? (
          <StatusPill kind="paid">{t('ledger.paidPill')}</StatusPill>
        ) : due.overdue ? (
          <StatusPill kind="overdue">{t('ledger.overduePill')}</StatusPill>
        ) : null}
      </span>
    </>
  );

  return (
    <li
      data-testid="fees-due"
      data-due-id={due.id}
      data-period-key={due.periodKey}
      data-status={due.status}
      data-overdue={due.overdue ? 'true' : undefined}
      className={cn(
        'flex flex-col gap-2 px-(--panel-p) py-3 transition-colors',
        checked && 'bg-primary-soft',
      )}
    >
      <div className="flex items-start gap-3">
        {owing ? (
          <>
            <input
              id={id}
              type="checkbox"
              checked={checked}
              onChange={(e) => onToggle(e.target.checked)}
              aria-label={t('ledger.choose', {
                head,
                period: when,
                amount: taka(due.balance.total),
              })}
              className="accent-primary mt-1 size-5 shrink-0 cursor-pointer"
            />
            <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
              {text}
            </label>
          </>
        ) : (
          <>
            <span aria-hidden className="size-5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">{text}</div>
          </>
        )}
      </div>

      {cancelled && due.cancelReason && (
        <p className="text-muted-foreground ps-8 text-sm">
          {t('ledger.cancelReason', { reason: due.cancelReason })}
        </p>
      )}

      {!cancelled && (
        <dl className="grid grid-cols-2 gap-x-5 gap-y-1 ps-8 text-sm lg:grid-cols-4">
          <Figure term={t('ledger.charged')} value={taka(due.amountPaisa)} />
          <Figure
            term={t('ledger.concession')}
            value={dash(due.concessionPaisa)}
            note={
              due.concessionPaisa > 0 && due.concessionSource !== 'NONE'
                ? t(`ledger.source.${due.concessionSource}`)
                : undefined
            }
          />
          <Figure
            term={t('ledger.fine')}
            value={dash(due.balance.fine)}
            note={
              due.fineWaivedAll
                ? t('ledger.fineWaivedAll')
                : due.fineWaivedPaisa > 0
                  ? t('ledger.fineWaived', { amount: taka(due.fineWaivedPaisa) })
                  : undefined
            }
          />
          <Figure term={t('ledger.paidAmount')} value={dash(paid)} />
        </dl>
      )}

      {(canWaive || canCancel) && (
        <div className="flex flex-wrap gap-2 ps-8">
          {canWaive && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction('waive')}
              data-testid="fees-due-waive"
            >
              <BadgePercentIcon aria-hidden />
              {t('actions.waive')}
            </Button>
          )}
          {canCancel && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => onAction('cancel')}
              data-testid="fees-due-cancel"
            >
              <BanIcon aria-hidden />
              {t('actions.cancel')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** What an upcoming period costs after its concession (no fine: it is not due yet). */
export const upcomingNet = (u: FeeUpcomingDue): number =>
  Math.max(0, u.amountPaisa - u.concessionPaisa);
export const upcomingKey = (u: Pick<FeeUpcomingDue, 'headId' | 'periodKey'>): string =>
  `${u.headId}|${u.periodKey}`;

/** A period that can be paid ahead, with its checkbox (a free one has nothing to pay). */
export function UpcomingRow({
  item,
  checked,
  onToggle,
}: {
  item: FeeUpcomingDue;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const t = useTranslations('fees.counter.ledger');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const id = useId();
  const net = upcomingNet(item);
  const head = pick(locale, item.head);
  const when = period(item);
  const amount = formatTaka(net, locale);
  const text = (
    <span className="flex items-start justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="py-0.5 leading-snug font-medium">
          {head} <span className="text-muted-foreground font-normal">· {when}</span>
        </span>
        <span className="text-muted-foreground text-sm">
          {t('dueOn', { date: formatDate(item.dueDate, locale) })}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className="font-numeric font-semibold">{net > 0 ? amount : '—'}</span>
        {item.concessionPaisa > 0 && (
          <span className="text-muted-foreground text-xs">
            {net > 0
              ? `${t('concession')} ${formatTaka(item.concessionPaisa, locale)}`
              : t('advanceFree')}
          </span>
        )}
      </span>
    </span>
  );
  return (
    <li
      data-testid="fees-upcoming"
      data-period-key={item.periodKey}
      data-head-id={item.headId}
      className={cn('flex items-start gap-3 px-(--panel-p) py-3', checked && 'bg-primary-soft')}
    >
      {net > 0 ? (
        <>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={t('chooseAhead', { head, period: when, amount })}
            className="accent-primary mt-1 size-5 shrink-0 cursor-pointer"
          />
          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
            {text}
          </label>
        </>
      ) : (
        <>
          <span aria-hidden className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">{text}</div>
        </>
      )}
    </li>
  );
}

/** Receipts, newest first: number (ASCII), date, method, amount; a void one says so. */
export function PaymentList({ payments }: { payments: FeePaymentSummary[] }) {
  const t = useTranslations('fees.counter.ledger');
  const tMethod = useTranslations('fees.common.method');
  const tStatus = useTranslations('fees.common.status');
  const locale = useLocale() as Locale;
  if (payments.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('historyEmpty')}</p>;
  }
  return (
    <ul className="-mx-2 flex flex-col" data-testid="fees-payments">
      {payments.map((p) => {
        const isVoid = p.status === 'VOID';
        return (
          <li key={p.id}>
            <Link
              href={`/fees/receipts/${p.id}`}
              data-testid="fees-payment"
              data-status={p.status}
              aria-label={t('openReceipt', { number: p.receiptNumber })}
              className="hover:bg-muted focus-visible:ring-ring flex min-h-(--control-h) items-center gap-3 rounded-xl px-2 py-2 outline-none focus-visible:ring-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="self-start font-mono text-sm font-medium" dir="ltr">
                  {p.receiptNumber}
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
                {isVoid && <StatusPill kind="void">{tStatus('VOID')}</StatusPill>}
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
  );
}

/** The student's concessions this year (read only: set up under Fees → Setup). */
export function ConcessionList({ concessions }: { concessions: FeeConcessionView[] }) {
  const t = useTranslations('fees.counter.ledger');
  const locale = useLocale() as Locale;
  return (
    <ul className="flex flex-col gap-2" data-testid="fees-concessions">
      {concessions.map((c) => (
        <Row
          key={c.id}
          title={
            <>
              {pick(locale, c.feeHead)}{' '}
              <span className="text-muted-foreground font-normal">
                · {t(`category.${c.category}`)}
              </span>
            </>
          }
          value={
            c.type === 'PERCENT' ? `${formatCount(c.value, locale)}%` : formatTaka(c.value, locale)
          }
          detail={[
            t('concessionFrom', { date: formatDate(c.validFrom, locale) }),
            c.endedOn && t('concessionEnded', { date: formatDate(c.endedOn, locale) }),
            c.reason,
          ]}
          ended={Boolean(c.endedOn)}
        />
      ))}
    </ul>
  );
}

/** Fines waived on this student's dues, with the reason (read only). */
export function WaiverList({ waivers, dues }: { waivers: FeeWaiverView[]; dues: FeeDueView[] }) {
  const t = useTranslations('fees.counter.ledger');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const byId = new Map(dues.map((d) => [d.id, d]));
  return (
    <ul className="flex flex-col gap-2" data-testid="fees-waivers">
      {waivers.map((w) => {
        const due = byId.get(w.dueId);
        return (
          <Row
            key={w.id}
            title={due ? t('waiverOf', { head: pick(locale, due.head), period: period(due) }) : '—'}
            value={w.amountPaisa === null ? t('waiverAll') : formatTaka(w.amountPaisa, locale)}
            detail={[formatDate(w.createdAt, locale), w.reason]}
          />
        );
      })}
    </ul>
  );
}

function Row({
  title,
  value,
  detail,
  ended,
}: {
  title: ReactNode;
  value: string;
  detail: (string | null | false | undefined)[];
  ended?: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('leading-snug font-medium', ended && 'text-muted-foreground')}>
          {title}
        </span>
        <span className="text-muted-foreground text-sm">{detail.filter(Boolean).join(' · ')}</span>
      </span>
      <span className="font-numeric shrink-0 text-sm font-semibold">{value}</span>
    </li>
  );
}
