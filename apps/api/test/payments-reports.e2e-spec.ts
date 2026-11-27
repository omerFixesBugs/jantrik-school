import { randomUUID } from 'node:crypto';
import {
  addDays,
  type FeeClosing,
  type FeeCollections,
  type FeeReceipt,
  type FeeSummary,
  type OnlinePaymentsReport,
} from '@jantrik/shared';
import { ReconcileService } from '../src/payments/reconcile.service.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { createHarness, http, type Harness } from './support/harness.js';
import {
  api,
  extraDue,
  intentRow,
  onlineSchool,
  payAtGateway,
  PUBLIC_API,
  PUBLIC_WEB,
  startPayment,
  type OnlineSchool,
} from './support/payments.js';

// Online money in the reports (sprint 1 P7b, Task 5, docs/payments.md → Reports): the online
// payments report by the day each payment was started (with SSLCommerz's charges, S24), the daily
// closing's online line (P7b-L) and the dashboard's to-check count. Review focus 6: for one day
// with two online payments (one voided the next day), an applied review item and a cash payment,
// the closing, the online report, the collections report and the summary agree.

describe('online payments in the reports, the daily closing and the dashboard', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let s: OnlineSchool;
  let reconcile: ReconcileService;
  let card: FeeReceipt;

  const child = () => s.students[0]!;
  const as = (role: 'owner' | 'admin' | 'accountant' | 'teacher') => api(h, s.tokens[role]);

  /** A due of its own, paid online with these fields, found by a check: posted or in review. */
  const paidOnline = async (amountPaisa: number, fields: Record<string, string> = {}) => {
    const due = await extraDue(h, s, child().id, { amountPaisa, dueDate: s.today });
    const view = await startPayment(h, s.tokens.guardian, child().id, {
      dueIds: [due.id],
      expected: amountPaisa,
    });
    await payAtGateway(h, fake, s.tenantId, view.id, { fields });
    await reconcile.run({ tenantId: s.tenantId, intentId: view.id, step: 'manual' });
    return { due, intent: await intentRow(h, s.tenantId, view.id) };
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.sendIpn = false;
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    s = await onlineSchool(h, fake);
    reconcile = h.app.get(ReconcileService);

    // bKash ৳1 000, of which SSLCommerz passes ৳980 to the store: posted.
    const bkash = await paidOnline(100000, { store_amount: '980.00' });
    expect(bkash.intent.status).toBe('PAID');
    // A card ৳500 (store ৳485.50): posted, then voided (the same day: the void's day is its own,
    // the one it is made on, and a voided payment's void is never changed).
    const byCard = await paidOnline(50000, {
      card_type: 'VISA-Dutch Bangla',
      card_brand: 'VISA',
      store_amount: '485.50',
    });
    expect(byCard.intent.status).toBe('PAID');
    card = (
      await as('admin')
        .post(`/fees/payments/${byCard.intent.feePaymentId}/void`, { reason: 'paid by mistake' })
        .expect(200)
    ).body as FeeReceipt;
    // A risky ৳300 applied from review by an admin.
    const risky = await paidOnline(30000, { risk_level: '1' });
    expect(risky.intent.status).toBe('NEEDS_REVIEW');
    await as('admin')
      .post(`/fees/online-payments/${risky.intent.id}/apply`, {
        dueIds: [risky.due.id],
        applyPaisa: 30000,
        expectedOutstandingPaisa: 30000,
        note: 'the guardian confirmed it by phone',
        clientRequestId: randomUUID(),
      })
      .expect(201);
    // ৳200 in cash at the counter.
    const cash = await extraDue(h, s, child().id, { amountPaisa: 20000, dueDate: s.today });
    await as('accountant')
      .post('/fees/payments', {
        studentId: child().id,
        dueIds: [cash.id],
        amountPaisa: 20000,
        expectedOutstandingPaisa: 20000,
        clientRequestId: randomUUID(),
      })
      .expect(201);
  });

  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('review focus 6: the online report, the closing on each day, the collections and the summary agree', async () => {
    const day = s.today;
    const report = (
      await as('accountant').get(`/fees/reports/online-payments?from=${day}&to=${day}`).expect(200)
    ).body as OnlinePaymentsReport;
    const row = {
      initiated: { count: 3, amountPaisa: 180000 },
      open: { count: 0 },
      paid: { count: 2, amountPaisa: 130000 },
      failed: { count: 0 },
      expired: { count: 0 },
      // The voided card payment is back in review (VOIDED).
      review: { count: 1, amountPaisa: 50000 },
      refundedOutside: { count: 0, amountPaisa: 0 },
      dismissed: { count: 0 },
      // SSLCommerz's charges: ৳20 (bKash) + ৳14.50 (card) + nothing on the ৳300.
      received: { amountPaisa: 180000, storeAmountPaisa: 176550, chargesPaisa: 3450 },
    };
    expect(report.rows).toEqual([{ day, ...row }]);
    expect(report.total).toEqual(row);

    // The daily closing: the online line under no collector, not in cash in hand.
    const closing = (await as('admin').get(`/fees/closing?date=${day}`).expect(200))
      .body as FeeClosing;
    expect(closing.online).toEqual({
      count: 3,
      amountPaisa: 180000,
      byMethod: [
        { method: 'BKASH', count: 2, amountPaisa: 130000 },
        { method: 'CARD', count: 1, amountPaisa: 0 },
      ],
      voided: [expect.objectContaining({ id: card.id, amountPaisa: 50000 })],
      netPaisa: 130000,
    });
    expect(closing.collectors.map((c) => c.collected.amountPaisa)).toEqual([20000]);
    expect(closing.total).toEqual({
      collectedPaisa: 200000,
      voidedPaisa: 50000,
      netPaisa: 150000,
      cashInHandPaisa: 20000,
    });
    // The next day: nothing online, nothing voided (a closed day never changes).
    const next = (
      await as('admin')
        .get(`/fees/closing?date=${addDays(day, 1)}`)
        .expect(200)
    ).body as FeeClosing;
    expect(next.online).toEqual({
      count: 0,
      amountPaisa: 0,
      byMethod: [],
      voided: [],
      netPaisa: 0,
    });
    expect(next.total).toEqual({
      collectedPaisa: 0,
      voidedPaisa: 0,
      netPaisa: 0,
      cashInHandPaisa: 0,
    });

    // The collections report (money kept: the void left out) by method and by collector.
    const byMethod = (
      await as('accountant')
        .get(`/fees/reports/collections?from=${day}&to=${day}&groupBy=method`)
        .expect(200)
    ).body as FeeCollections;
    expect(byMethod.rows.map((r) => [r.key, r.count, r.amountPaisa])).toEqual([
      ['BKASH', 2, 130000],
      ['CASH', 1, 20000],
    ]);
    const byCollector = (
      await as('admin')
        .get(`/fees/reports/collections?from=${day}&to=${day}&groupBy=collector`)
        .expect(200)
    ).body as FeeCollections;
    expect(byCollector.rows.find((r) => r.key === 'ONLINE')).toMatchObject({
      count: 2,
      amountPaisa: 130000,
      nameEn: 'Online (SSLCommerz)',
    });
    // The closing's net for the day is the money kept that day.
    expect(byCollector.total.amountPaisa).toBe(closing.total.netPaisa);
    expect(closing.online!.netPaisa).toBe(
      byCollector.rows.find((r) => r.key === 'ONLINE')!.amountPaisa,
    );
    // The online report's paid money is the collections' online money for the day.
    expect(report.total.paid.amountPaisa).toBe(
      byCollector.rows.find((r) => r.key === 'ONLINE')!.amountPaisa,
    );

    // The dashboard: what waits for a person.
    const summary = (await as('admin').get('/fees/summary').expect(200)).body as FeeSummary;
    expect(summary).toMatchObject({ pendingSubmissions: 0, onlineToReview: 1 });
  });

  it("an accountant's own closing, or one collector's, has no online line", async () => {
    const own = (await as('accountant').get(`/fees/closing?date=${s.today}`).expect(200))
      .body as FeeClosing;
    expect(own.online).toBeNull();
    expect(own.total.collectedPaisa).toBe(20000);
    const collectors = (await as('admin').get(`/fees/closing?date=${s.today}`).expect(200))
      .body as FeeClosing;
    const one = (
      await as('admin')
        .get(`/fees/closing?date=${s.today}&collectorId=${collectors.collectors[0]!.collector.id}`)
        .expect(200)
    ).body as FeeClosing;
    expect(one.online).toBeNull();
  });

  it('the CSV: a BOM, ASCII digits, the totals; a year at most; staff only', async () => {
    const res = await as('admin')
      .get(`/fees/reports/online-payments/csv?from=${s.today}&to=${s.today}&locale=en`)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="online-payments-${s.today}-${s.today}.csv"`,
    );
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toMatch(/^Day,Started,/);
    expect(lines[1]).toBe(
      `${s.today},3,1800.00,0,2,1300.00,0,0,1,500.00,0,0.00,0,1800.00,1765.50,34.50`,
    );
    expect(lines.at(-1)).toMatch(/^Total,3,1800\.00,/);
    const bn = await as('admin')
      .get(`/fees/reports/online-payments/csv?from=${s.today}&to=${s.today}&locale=bn`)
      .expect(200);
    // Bangla headers, ASCII digits (files people re-use in other software).
    expect(bn.text).toMatch(/দিন/);
    expect(bn.text).not.toMatch(/[০-৯]/);
    await as('admin')
      .get(`/fees/reports/online-payments?from=${addDays(s.today, -400)}&to=${s.today}`)
      .expect(400);
    await as('teacher')
      .get(`/fees/reports/online-payments?from=${s.today}&to=${s.today}`)
      .expect(403);
    await http(h).get(`/fees/reports/online-payments?from=${s.today}&to=${s.today}`).expect(401);
  });
});
