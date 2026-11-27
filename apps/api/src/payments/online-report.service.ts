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

/**
 * The online payments report (sprint 1 P7b, docs/payments.md → Reports; OWNER, ADMIN,
 * ACCOUNTANT): every payment started in the range, by the day it was started in the institute's
 * timezone and by where it stands now, with the money SSLCommerz validated for them and its
 * charges (amount − store amount, S24). Sums are taken in SQL as bigint.
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
             sum(validated_amount_paisa) FILTER (WHERE status = 'NEEDS_REVIEW')::bigint
               AS review_amount,
             count(*) FILTER (WHERE status = 'REFUNDED_OUTSIDE' OR refunded_outside_paisa IS NOT NULL)::bigint
               AS refunded,
             sum(refunded_outside_paisa)::bigint AS refunded_amount,
             count(*) FILTER (WHERE status = 'DISMISSED')::bigint AS dismissed,
             sum(validated_amount_paisa)::bigint AS received,
             sum(store_amount_paisa)::bigint AS store,
             sum(validated_amount_paisa - store_amount_paisa)::bigint AS charges
      FROM payment_intents
      WHERE created_at >= ${from} AND created_at < ${to}
      GROUP BY 1 ORDER BY 1`;
    const n = (v: bigint | null) => Number(v ?? 0n);
    const out: OnlinePaymentsReportRow[] = rows.map((r) => ({
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
