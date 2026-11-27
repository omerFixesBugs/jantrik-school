import { Injectable } from '@nestjs/common';
import {
  addDays,
  toCsv,
  wallClockToUtc,
  type OnlinePaymentsReport,
  type OnlinePaymentsReportRow,
} from '@jantrik/shared';
import type { z } from 'zod';
import type { onlinePaymentsReportQuerySchema } from '@jantrik/shared';
import { Db } from '../tenancy/db.service.js';

type ReportQuery = z.output<typeof onlinePaymentsReportQuerySchema>;

/** Paisa as taka with two decimals and ASCII digits (files people re-use in other software). */
const taka = (paisa: number) => (paisa / 100).toFixed(2);

type Totals = Omit<OnlinePaymentsReportRow, 'day'>;

const empty = (): Totals => ({
  initiated: { count: 0, amountPaisa: 0 },
  open: { count: 0 },
  paid: { count: 0, amountPaisa: 0 },
  failed: { count: 0 },
  expired: { count: 0 },
  review: { count: 0, amountPaisa: 0 },
  refundedOutside: { count: 0, amountPaisa: 0 },
  dismissed: { count: 0 },
  received: { amountPaisa: 0, storeAmountPaisa: 0, chargesPaisa: 0 },
});

/** A gateway amount as the API reads it (parseGatewayAmount), in SQL: paisa, or NULL. */
const GATEWAY_AMOUNT_SQL = '^[0-9]{1,7}([.][0-9]{1,2})?$';

/**
 * The online payments report (sprint 1 P7b, docs/payments.md → Reports; OWNER, ADMIN,
 * ACCOUNTANT): every payment started in the range, by the day it was started in the institute's
 * timezone and by where it stands now (each in one status column), with the money SSLCommerz
 * validated for them and its charges (amount − store amount, S24). Money items count too (review
 * round 1, hardening e): a second payment (DUPLICATE) on its payment's day, money of no payment
 * of ours (UNMATCHED) on the day it arrived; each payment's money once (its val_id; a repeat
 * record dismissed, or money an intent holds, is not counted again): in received, to check while
 * undecided, refunded outside once refunded. Sums are taken in SQL as bigint.
 */
@Injectable()
export class OnlinePaymentsReportService {
  constructor(private readonly db: Db) {}

  async report(q: ReportQuery): Promise<OnlinePaymentsReport> {
    const tx = this.db.tx;
    const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const from = wallClockToUtc(`${q.from} 00:00:00`, timezone);
    const to = wallClockToUtc(`${addDays(q.to, 1)} 00:00:00`, timezone);
    type Row = {
      day: string;
      initiated: bigint;
      asked: bigint | null;
      open: bigint;
      paid: bigint;
      paid_amount: bigint | null;
      failed: bigint;
      expired: bigint;
      review: bigint;
      review_amount: bigint | null;
      refunded: bigint;
      refunded_amount: bigint | null;
      dismissed: bigint;
      received: bigint | null;
      store: bigint | null;
      charges: bigint | null;
    };
    const rows = await tx.$queryRaw<Row[]>`
      SELECT to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
             count(*)::bigint AS initiated,
             sum(amount_paisa)::bigint AS asked,
             count(*) FILTER (WHERE status IN ('CREATED', 'REDIRECTED'))::bigint AS open,
             count(*) FILTER (WHERE status = 'PAID')::bigint AS paid,
             sum(COALESCE(applied_paisa, amount_paisa)) FILTER (WHERE status = 'PAID')::bigint
               AS paid_amount,
             count(*) FILTER (WHERE status IN ('FAILED', 'CANCELLED'))::bigint AS failed,
             count(*) FILTER (WHERE status = 'EXPIRED')::bigint AS expired,
             count(*) FILTER (WHERE status = 'NEEDS_REVIEW')::bigint AS review,
             sum(validated_amount_paisa - COALESCE(refunded_outside_paisa, 0))
               FILTER (WHERE status = 'NEEDS_REVIEW')::bigint AS review_amount,
             -- Each payment counts once, in its state now (review round 2, probe D); the amount
             -- refunded outside also holds the refund part of an applied one, and the refund an
             -- applied one voided back into review keeps (P7b-x24).
             count(*) FILTER (WHERE status = 'REFUNDED_OUTSIDE')::bigint AS refunded,
             sum(refunded_outside_paisa)::bigint AS refunded_amount,
             count(*) FILTER (WHERE status = 'DISMISSED')::bigint AS dismissed,
             sum(validated_amount_paisa)::bigint AS received,
             sum(store_amount_paisa)::bigint AS store,
             sum(validated_amount_paisa - store_amount_paisa)::bigint AS charges
      FROM payment_intents
      WHERE created_at >= ${from} AND created_at < ${to}
      GROUP BY 1 ORDER BY 1`;
    type ItemRow = {
      day: string;
      review: bigint;
      review_amount: bigint | null;
      refunded: bigint;
      refunded_amount: bigint | null;
      received: bigint | null;
      store: bigint | null;
      charges: bigint | null;
    };
    const items = await tx.$queryRaw<ItemRow[]>`
      WITH money AS (
        SELECT DISTINCT ON (COALESCE(e.val_id, e.id::text))
               COALESCE(i.created_at, e.received_at) AS at,
               r.outcome,
               r.amount_paisa AS refunded,
               CASE WHEN e.fields->>'amount' ~ ${GATEWAY_AMOUNT_SQL}
                    THEN round((e.fields->>'amount')::numeric * 100)::bigint END AS amount,
               CASE WHEN e.fields->>'store_amount' ~ ${GATEWAY_AMOUNT_SQL}
                    THEN round((e.fields->>'store_amount')::numeric * 100)::bigint END AS store
        FROM payment_gateway_events e
        LEFT JOIN payment_intents i ON i.tenant_id = e.tenant_id AND i.id = e.intent_id
        LEFT JOIN payment_signal_reviews r ON r.tenant_id = e.tenant_id AND r.event_id = e.id
        WHERE e.kind = 'VALIDATE' AND e.review_reason IS NOT NULL
          AND (r.outcome IS NULL OR r.outcome = 'REFUNDED_OUTSIDE')
          AND NOT EXISTS (
            SELECT 1 FROM payment_intents h WHERE h.tenant_id = e.tenant_id AND h.val_id = e.val_id)
        ORDER BY COALESCE(e.val_id, e.id::text), (r.outcome IS NOT NULL) DESC, e.received_at
      ), valid AS (
        SELECT at, outcome, refunded, amount,
               CASE WHEN store <= amount THEN store END AS store
        FROM money WHERE at >= ${from} AND at < ${to}
      )
      SELECT to_char(at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE outcome IS NULL)::bigint AS review,
             sum(amount) FILTER (WHERE outcome IS NULL)::bigint AS review_amount,
             count(*) FILTER (WHERE outcome = 'REFUNDED_OUTSIDE')::bigint AS refunded,
             sum(refunded) FILTER (WHERE outcome = 'REFUNDED_OUTSIDE')::bigint AS refunded_amount,
             sum(amount)::bigint AS received,
             sum(store)::bigint AS store,
             sum(amount - store)::bigint AS charges
      FROM valid GROUP BY 1 ORDER BY 1`;
    const n = (v: bigint | null) => Number(v ?? 0n);
    const zero = (day: string): Row => ({
      day,
      initiated: 0n,
      asked: 0n,
      open: 0n,
      paid: 0n,
      paid_amount: 0n,
      failed: 0n,
      expired: 0n,
      review: 0n,
      review_amount: 0n,
      refunded: 0n,
      refunded_amount: 0n,
      dismissed: 0n,
      received: 0n,
      store: 0n,
      charges: 0n,
    });
    const byDay = new Map(rows.map((r) => [r.day, r]));
    for (const item of items) {
      const r = byDay.get(item.day) ?? zero(item.day);
      byDay.set(item.day, {
        ...r,
        review: r.review + item.review,
        review_amount: (r.review_amount ?? 0n) + (item.review_amount ?? 0n),
        refunded: r.refunded + item.refunded,
        refunded_amount: (r.refunded_amount ?? 0n) + (item.refunded_amount ?? 0n),
        received: (r.received ?? 0n) + (item.received ?? 0n),
        store: (r.store ?? 0n) + (item.store ?? 0n),
        charges: (r.charges ?? 0n) + (item.charges ?? 0n),
      });
    }
    const merged = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    const out: OnlinePaymentsReportRow[] = merged.map((r) => ({
      day: r.day,
      initiated: { count: n(r.initiated), amountPaisa: n(r.asked) },
      open: { count: n(r.open) },
      paid: { count: n(r.paid), amountPaisa: n(r.paid_amount) },
      failed: { count: n(r.failed) },
      expired: { count: n(r.expired) },
      review: { count: n(r.review), amountPaisa: n(r.review_amount) },
      refundedOutside: { count: n(r.refunded), amountPaisa: n(r.refunded_amount) },
      dismissed: { count: n(r.dismissed) },
      received: {
        amountPaisa: n(r.received),
        storeAmountPaisa: n(r.store),
        chargesPaisa: n(r.charges),
      },
    }));
    const total = empty();
    for (const r of out) {
      for (const key of Object.keys(total) as (keyof Totals)[]) {
        const into = total[key] as Record<string, number>;
        const add = r[key] as Record<string, number>;
        for (const k of Object.keys(into)) into[k] = into[k]! + add[k]!;
      }
    }
    return { from: q.from, to: q.to, rows: out, total };
  }

  async csv(q: ReportQuery): Promise<{ filename: string; csv: string }> {
    const r = await this.report(q);
    const bn = q.locale === 'bn';
    const header = bn
      ? [
          'দিন',
          'শুরু (সংখ্যা)',
          'চাওয়া (টাকা)',
          'চলমান',
          'পরিশোধিত (সংখ্যা)',
          'পরিশোধিত (টাকা)',
          'ব্যর্থ বা বাতিল',
          'মেয়াদোত্তীর্ণ',
          'পর্যালোচনায় (সংখ্যা)',
          'পর্যালোচনায় (টাকা)',
          'বাইরে ফেরত (সংখ্যা)',
          'বাইরে ফেরত (টাকা)',
          'খারিজ',
          'প্রাপ্ত (টাকা)',
          'প্রতিষ্ঠানের অংশ (টাকা)',
          'SSLCommerz চার্জ (টাকা)',
        ]
      : [
          'Day',
          'Started',
          'Asked (Tk)',
          'Open',
          'Paid',
          'Paid (Tk)',
          'Failed or cancelled',
          'Expired',
          'In review',
          'In review (Tk)',
          'Refunded outside',
          'Refunded outside (Tk)',
          'Dismissed',
          'Received (Tk)',
          'Store amount (Tk)',
          'SSLCommerz charges (Tk)',
        ];
    const line = (label: string, t: Totals) => [
      label,
      t.initiated.count,
      taka(t.initiated.amountPaisa),
      t.open.count,
      t.paid.count,
      taka(t.paid.amountPaisa),
      t.failed.count,
      t.expired.count,
      t.review.count,
      taka(t.review.amountPaisa),
      t.refundedOutside.count,
      taka(t.refundedOutside.amountPaisa),
      t.dismissed.count,
      taka(t.received.amountPaisa),
      taka(t.received.storeAmountPaisa),
      taka(t.received.chargesPaisa),
    ];
    return {
      filename: `online-payments-${q.from}-${q.to}.csv`,
      csv: toCsv([
        header,
        ...r.rows.map((row) => line(row.day, row)),
        line(bn ? 'মোট' : 'Total', r.total),
      ]),
    };
  }
}
