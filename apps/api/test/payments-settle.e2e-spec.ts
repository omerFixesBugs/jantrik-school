import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateToDb,
  newTranId,
  type FeeClosing,
  type FeeCollections,
  type FeeReceipt,
  type OnlinePaymentView,
} from '@jantrik/shared';
import { ConfirmService, PaymentJobError } from '../src/payments/confirm.service.js';
import { CheckoutService } from '../src/payments/checkout.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../src/payments/provider.js';
import { SettleService, type PaidOutcome } from '../src/payments/settle.service.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { ownerClient, platform, platformAdminCookie } from './support/platform.js';
import { createHarness, http, type Harness } from './support/harness.js';
import {
  api,
  childFees,
  enableAccount,
  extraDue,
  intentRow,
  ipnFields,
  onlineSchool,
  payAtGateway,
  postIpn,
  postReturn,
  PUBLIC_API,
  PUBLIC_WEB,
  redisDump,
  resetStartBudgets,
  startPayment,
  waitStatus,
  type OnlineSchool,
} from './support/payments.js';

// Confirmation and settle (sprint 1 P7a2, Tasks 13 and 16): every payment is confirmed with
// SSLCommerz's validation API and posted only when tran_id, BDT, the exact amount, low risk and
// the dues all match; anything else waits for review with the money recorded and no receipt (S23).
// The fake SSLCommerz stands in; signals are posted to the API's own public routes.

describe('online payments: confirmation and settle', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let s: OnlineSchool;
  let confirm: ConfirmService;
  let settle: SettleService;
  let checkout: CheckoutService;
  let provider: PaymentProvider;

  const child = () => s.students[0]!;
  const fees = (path: string) => `/me/children/${child().id}/fees${path}`;

  /** A due of its own for the first child, and a payment for it waiting at the gateway (READY). */
  const readyPayment = async (
    amountPaisa = 120000,
    studentId = child().id,
    token = s.tokens.guardian,
  ) => {
    const due = await extraDue(h, s, studentId, { amountPaisa, dueDate: s.today });
    const view = await startPayment(h, token, studentId, {
      dueIds: [due.id],
      expected: amountPaisa,
    });
    return { due, view, intent: await intentRow(h, s.tenantId, view.id) };
  };
  const paymentsOf = (intentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.findMany({ where: { paymentIntentId: intentId } }),
    );
  const eventsOf = (intentId: string | null, kind?: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({
        where: { intentId, ...(kind ? { kind: kind as never } : {}) },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  const receiptSms = () =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findMany({ where: { purpose: 'FEE_RECEIPT' } }),
    );
  /**
   * An intent for one due of the first child as if its checkout had happened earlier (priced on
   * `pricedOn`, created `ageMs` ago), with its gateway session made by the init job.
   */
  const earlierIntent = async (opts: {
    dueId: string;
    principal: number;
    fine: number;
    pricedOn: string;
    ageMs: number;
  }) => {
    const { account, payer } = await withTenant(h.prisma, s.tenantId, async (tx) => ({
      account: await tx.paymentGatewayAccount.findFirstOrThrow({ select: { id: true } }),
      payer: (
        await tx.guardian.findFirstOrThrow({
          where: { students: { some: { studentId: child().id } }, userId: { not: null } },
          select: { userId: true },
        })
      ).userId!,
    }));
    const createdAt = new Date(Date.now() - opts.ageMs);
    const intent = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const created = await tx.paymentIntent.create({
        data: {
          tenantId: s.tenantId,
          accountId: account.id,
          studentId: child().id,
          payerUserId: payer,
          amountPaisa: opts.principal + opts.fine,
          pricedOn: dateToDb(opts.pricedOn),
          tranId: newTranId(createdAt),
          clientRequestId: randomUUID(),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 3600_000),
        },
      });
      await tx.paymentIntentDue.create({
        data: {
          tenantId: s.tenantId,
          intentId: created.id,
          studentId: child().id,
          dueId: opts.dueId,
          plannedPrincipalPaisa: opts.principal,
          plannedFinePaisa: opts.fine,
        },
      });
      return created;
    });
    await checkout.runInit({ tenantId: s.tenantId, intentId: intent.id });
    return intentRow(h, s.tenantId, intent.id);
  };
  const validated = async (tranId: string, valId: string): Promise<PaidOutcome> => {
    const outcome = await provider.confirm(s.store, { tranId, valId });
    if (outcome.kind !== 'PAID') throw new Error(`not paid: ${outcome.kind}`);
    return outcome;
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.sendIpn = false;
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    s = await onlineSchool(h, fake);
    confirm = h.app.get(ConfirmService);
    settle = h.app.get(SettleService);
    checkout = h.app.get(CheckoutService);
    provider = h.app.get<PaymentProvider>(PAYMENT_PROVIDER);
  });

  beforeEach(async () => {
    await resetStartBudgets(h);
    // Whatever a failed case left in progress, abandoned.
    for (const [token, student] of [
      [s.tokens.guardian, s.students[0]!],
      [s.tokens.otherGuardian, s.students[2]!],
    ] as const) {
      const view = await childFees(h, token, student.id);
      if (view.online.inProgress?.mine) {
        await api(h, token).post(
          `/me/children/${student.id}/fees/online-payments/${view.online.inProgress.intentId}/abandon`,
        );
      }
    }
  });

  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('happy path: the IPN and the return make one gateway payment, one receipt, one SMS', async () => {
    const { intent, view } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    expect((await postIpn(h, s.slug, ipnFields(t))).status).toBe(200);
    const ret = await postReturn(h, s.slug, intent.tranId, 'success', ipnFields(t));
    expect(ret.status).toBe(303);
    const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
    expect(paid).toMatchObject({
      valId: t.valId,
      bankTranId: t.fields['bank_tran_id'],
      method: 'BKASH',
      instrument: 'BKASH-BKash',
      validatedAmountPaisa: 120000,
      validatedCurrency: 'BDT',
      risk: 'LOW',
      reviewReasons: [],
    });
    const [payment, ...more] = await paymentsOf(intent.id);
    expect(more).toEqual([]);
    expect(payment).toMatchObject({
      channel: 'GATEWAY',
      method: 'BKASH',
      trxId: t.fields['bank_tran_id'],
      amountPaisa: 120000,
      paidOn: intent.pricedOn,
      senderPhone: null,
      collectedById: intent.payerUserId,
      clientRequestId: intent.id,
      status: 'ACTIVE',
    });
    expect(paid.feePaymentId).toBe(payment!.id);
    // The guardian's page: PAID with the receipt.
    const page = (await api(h, s.tokens.guardian).get(fees(`/online-payments/${view.id}`)))
      .body as OnlinePaymentView;
    expect(page).toMatchObject({ state: 'PAID', receipt: { id: payment!.id } });
    // One receipt SMS (P7a-U), after the job is done.
    await vi.waitFor(
      async () =>
        expect((await receiptSms()).filter((l) => l.relatedId === payment!.id)).toHaveLength(1),
      { timeout: 5000 },
    );
    // Validated once: the second signal found the val_id done.
    expect(fake.transactions.find((x) => x.valId === t.valId)!.validatedCount).toBe(1);
  });

  it("Task 13: the receipt says online, with the bank's and our transaction IDs, and no collector", async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id, {
      fields: {
        card_type: 'DBBLMOBILEB-Dbbl Mobile Banking',
        bank_tran_id: '1709162025350IvUOK8nCTb6Uan',
      },
    });
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
    const receipt = (
      await api(h, s.tokens.guardian)
        .get(fees(`/payments/${paid.feePaymentId}`))
        .expect(200)
    ).body as FeeReceipt;
    expect(receipt).toMatchObject({
      channel: 'GATEWAY',
      method: 'ROCKET',
      trxId: '1709162025350IvUOK8nCTb6Uan',
      online: {
        tranId: intent.tranId,
        bankTranId: '1709162025350IvUOK8nCTb6Uan',
        instrument: 'DBBLMOBILEB-Dbbl Mobile Banking',
      },
      collectedBy: null,
      paidOn: s.today,
      amountPaisa: 120000,
    });
    // Staff see the same receipt.
    const staff = (
      await api(h, s.tokens.accountant).get(`/fees/payments/${paid.feePaymentId}`).expect(200)
    ).body as FeeReceipt;
    expect(staff.online?.tranId).toBe(intent.tranId);
    // The audit names the guardian as the actor of the payment.
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { entity: 'fee_payment', entityId: paid.feePaymentId! },
      }),
    );
    expect(audit).toMatchObject({ action: 'CREATE', actorUserId: intent.payerUserId });
    expect(audit.newValues).toMatchObject({ channel: 'GATEWAY', paymentIntentId: intent.id });
    // The daily closing lists no guardian as a collector (P7a-V).
    const closing = (await api(h, s.tokens.admin).get(`/fees/closing?date=${s.today}`).expect(200))
      .body as FeeClosing;
    expect(closing.collectors.map((c) => c.collector.id)).not.toContain(intent.payerUserId);
    // The collections report by collector has one online line, by method the Rocket label.
    const byCollector = (
      await api(h, s.tokens.admin)
        .get(`/fees/reports/collections?from=${s.today}&to=${s.today}&groupBy=collector`)
        .expect(200)
    ).body as FeeCollections;
    expect(byCollector.rows.find((r) => r.key === 'ONLINE')).toMatchObject({
      nameEn: 'Online (SSLCommerz)',
    });
    expect(byCollector.rows.map((r) => r.key)).not.toContain(intent.payerUserId);
    const byMethod = (
      await api(h, s.tokens.admin)
        .get(`/fees/reports/collections?from=${s.today}&to=${s.today}&groupBy=method`)
        .expect(200)
    ).body as FeeCollections;
    expect(byMethod.rows.find((r) => r.key === 'ROCKET')).toMatchObject({
      nameBn: 'রকেট',
      nameEn: 'Rocket',
    });
  });

  it('Task 13: voiding a gateway payment sends its intent back to review (VOIDED), in the same transaction', async () => {
    const { intent, due } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
    await api(h, s.tokens.admin)
      .post(`/fees/payments/${paid.feePaymentId}/void`, { reason: 'দুবার কাটা হয়েছে' })
      .expect(200);
    const after = await intentRow(h, s.tenantId, intent.id);
    expect(after).toMatchObject({
      status: 'NEEDS_REVIEW',
      feePaymentId: null,
      reviewReasons: ['VOIDED'],
      valId: t.valId,
    });
    // The due owes again; the same signal again posts nothing (it is in review).
    const ledger = await childFees(h, s.tokens.guardian, child().id);
    expect(ledger.ledger.dues.find((d) => d.id === due.id)!.balance.total).toBe(120000);
    await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
    expect((await paymentsOf(intent.id)).filter((p) => p.status === 'ACTIVE')).toHaveLength(0);
  });

  it('fail and cancel returns: closed once the query lists the failed or cancelled attempt; PENDING changes nothing', async () => {
    const failed = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, failed.intent.id, { status: 'FAILED' });
    await postReturn(h, s.slug, failed.intent.tranId, 'fail', { status: 'FAILED' }).expect(303);
    await waitStatus(h, s.tenantId, failed.intent.id, 'FAILED');

    const cancelled = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, cancelled.intent.id, { status: 'CANCELLED' });
    await postReturn(h, s.slug, cancelled.intent.tranId, 'cancel', { status: 'CANCELLED' }).expect(
      303,
    );
    await waitStatus(h, s.tenantId, cancelled.intent.id, 'CANCELLED');

    const pending = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, pending.intent.id, { status: 'PENDING' });
    await postReturn(h, s.slug, pending.intent.tranId, 'fail', { status: 'FAILED' }).expect(303);
    await vi.waitFor(async () =>
      expect((await eventsOf(pending.intent.id, 'QUERY')).length).toBeGreaterThan(0),
    );
    await confirm.run({ tenantId: s.tenantId, intentId: pending.intent.id });
    expect((await intentRow(h, s.tenantId, pending.intent.id)).status).toBe('REDIRECTED');
  });

  it('a forged fail or cancel return (the tran_id only, even by GET) closes nothing while the gateway lists no attempt; the real payment then posts', async () => {
    const { intent } = await readyPayment();
    // An <img> link on any page the guardian opens: GET, the tran_id from the return URL only.
    await http(h)
      .get(`/public/payments/sslcommerz/${s.slug}/return/${intent.tranId}/cancel`)
      .set('X-Forwarded-For', '10.9.8.31')
      .expect(303);
    await postReturn(h, s.slug, intent.tranId, 'fail', { status: 'FAILED' }, '10.9.8.32').expect(
      303,
    );
    await vi.waitFor(async () =>
      expect((await eventsOf(intent.id, 'QUERY')).length).toBeGreaterThan(0),
    );
    await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('REDIRECTED');
    // The guardian, still on the gateway's page, pays: a receipt, not a LATE_SUCCESS review.
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
    expect(paid.reviewReasons).toEqual([]);
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it("cancelled on the fake's payer page: the browser's return closes it CANCELLED, NOT_PAID, and a new checkout is allowed", async () => {
    const { intent, due } = await readyPayment();
    // The payer presses Cancel on the gateway's page (the fake: a CANCELLED attempt the query
    // lists), which sends the browser back to our cancel address with the attempt's fields.
    const res = await fetch(`${fake.url}/pay/${intent.sessionRef}/cancel`, { method: 'POST' });
    const html = (await res.text()).replace(/&#(\d+);/g, (_m, c: string) =>
      String.fromCharCode(Number(c)),
    );
    const action = /<form method="post" action="([^"]+)">/.exec(html)![1]!;
    expect(action).toBe(
      `${PUBLIC_API}/public/payments/sslcommerz/${s.slug}/return/${intent.tranId}/cancel`,
    );
    const fields = Object.fromEntries(
      [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    expect(fields['status']).toBe('CANCELLED');
    await postReturn(h, s.slug, intent.tranId, 'cancel', fields).expect(303);
    await waitStatus(h, s.tenantId, intent.id, 'CANCELLED');
    const page = (await api(h, s.tokens.guardian).get(fees(`/online-payments/${intent.id}`)))
      .body as OnlinePaymentView;
    expect(page.state).toBe('NOT_PAID');
    expect(await paymentsOf(intent.id)).toEqual([]);
    // "Start again": the same due may be paid online at once.
    const again = await startPayment(h, s.tokens.guardian, child().id, {
      dueIds: [due.id],
      expected: 120000,
    });
    expect(again.state).toBe('READY');
  });

  describe('the validation flood (P7a2-x24): made-up val_ids on a known tran_id', () => {
    /**
     * Returns stored as payment_signal_record stores them, in this order, with no confirm job
     * queued: the test runs confirm itself.
     */
    const storeReturns = (intent: { id: string; tranId: string }, valIds: string[]) =>
      withTenant(h.prisma, s.tenantId, (tx) =>
        tx.paymentGatewayEvent.createMany({
          data: valIds.map((valId, i) => ({
            tenantId: s.tenantId,
            intentId: intent.id,
            kind: 'RETURN' as const,
            outcome: 'SUCCESS',
            tranId: intent.tranId,
            valId,
            fields: {},
            sourceListed: false,
            receivedAt: new Date(Date.now() - 1000 + i),
          })),
        }),
      );
    const madeUp = (n: number) => {
      const tag = randomUUID().replace(/-/g, '').slice(0, 10);
      return Array.from({ length: n }, (_, i) => `VALFLOOD${tag}${i}`);
    };
    const validations = (valIds: string[]) =>
      fake.requests.filter((r) => r.api === 'validate' && valIds.includes(r.fields['val_id']!))
        .length;
    const queries = (tranId: string) =>
      fake.requests.filter((r) => r.api === 'query' && r.fields['tran_id'] === tranId).length;

    it('an open payment: 3 validated in a round, then the query by tran_id decides; it covers the rest for good', async () => {
      const { intent } = await readyPayment();
      const flood = madeUp(8);
      await storeReturns(intent, flood);
      const asked = queries(intent.tranId);
      await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
      expect(validations(flood)).toBe(3);
      expect(queries(intent.tranId)).toBe(asked + 1);
      // The query answered for every signal stored before it: none of them is validated again.
      await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
      expect(validations(flood)).toBe(3);
      expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('REDIRECTED');
      // The real payment still posts: the query lists it.
      await payAtGateway(h, fake, s.tenantId, intent.id);
      await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
      expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
      expect(validations(flood)).toBe(3);
    });

    it('a closed payment: new val_ids are not validated unless the query lists them', async () => {
      const { intent } = await readyPayment();
      const t = await payAtGateway(h, fake, s.tenantId, intent.id);
      await postIpn(h, s.slug, ipnFields(t)).expect(200);
      await waitStatus(h, s.tenantId, intent.id, 'PAID');
      const flood = madeUp(5);
      await storeReturns(intent, flood);
      await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
      expect(validations(flood)).toBe(0);
      expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
      expect(await paymentsOf(intent.id)).toHaveLength(1);
      // A real second payment of the same tran_id is listed by the query: validated, DUPLICATE.
      const again = await payAtGateway(h, fake, s.tenantId, intent.id);
      await storeReturns(intent, [again.valId]);
      await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
      const dup = (await eventsOf(intent.id, 'VALIDATE')).find((e) => e.valId === again.valId);
      expect(dup).toMatchObject({ reviewReason: 'DUPLICATE' });
      expect(validations(flood)).toBe(0);
      expect(await paymentsOf(intent.id)).toHaveLength(1);
    });
  });

  it('liveness: a val_id first answered PENDING is validated again once the gateway lists it VALID', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id, { status: 'PENDING' });
    // The validation API says the payment is still pending (and the query lists it so).
    fake.override('validate', { json: { status: 'PENDING', APIConnect: 'DONE' } });
    await postReturn(h, s.slug, intent.tranId, 'success', { val_id: t.valId }).expect(303);
    await vi.waitFor(async () => {
      expect((await eventsOf(intent.id, 'VALIDATE')).map((e) => e.outcome)).toEqual(['PENDING']);
      expect((await eventsOf(intent.id, 'QUERY')).length).toBeGreaterThan(0);
    });
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('REDIRECTED');
    // The payment completes at the gateway; the next confirm (a heal, a late IPN) posts it.
    t.status = 'VALID';
    await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it('review focus 1: three settle runs at once for one val_id → one payment, one receipt number', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    const outcome = await validated(intent.tranId, t.valId);
    const results = await Promise.all(
      [0, 1, 2].map(() => settle.settlePaid(s.tenantId, intent.id, intent.payerUserId, outcome)),
    );
    expect(results.sort()).toEqual(['NOTHING', 'NOTHING', 'POST']);
    const payments = await paymentsOf(intent.id);
    expect(payments).toHaveLength(1);
    expect(await eventsOf(intent.id, 'VALIDATE')).toHaveLength(3);
    // The next receipt follows it: no number was used up by the two runs that changed nothing.
    const next = await extraDue(h, s, s.students[1]!.id, { amountPaisa: 5000, dueDate: s.today });
    const cash = await api(h, s.tokens.accountant)
      .post('/fees/payments', {
        studentId: s.students[1]!.id,
        dueIds: [next.id],
        amountPaisa: 5000,
        expectedOutstandingPaisa: 5000,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    expect((cash.body as FeeReceipt).receiptNumber).toBe(
      `${payments[0]!.receiptYear}-${String(payments[0]!.receiptNo + 1).padStart(6, '0')}`,
    );
  });

  it('review focus 2: paid at the counter while paying online → the online money waits for review', async () => {
    const { intent, due } = await readyPayment();
    // The counter saw the payment in progress, and still took cash.
    const ledger = (
      await api(h, s.tokens.accountant).get(`/fees/students/${child().id}/ledger`).expect(200)
    ).body as { dues: { id: string; onlinePending: boolean }[] };
    expect(ledger.dues.find((d) => d.id === due.id)!.onlinePending).toBe(true);
    const counter = await api(h, s.tokens.accountant)
      .post('/fees/payments', {
        studentId: child().id,
        dueIds: [due.id],
        amountPaisa: 120000,
        expectedOutstandingPaisa: 120000,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    const smsBefore = (await receiptSms()).length;
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const review = await waitStatus(h, s.tenantId, intent.id, 'NEEDS_REVIEW');
    expect(review).toMatchObject({
      reviewReasons: ['DUES_CHANGED'],
      validatedAmountPaisa: 120000,
      bankTranId: t.fields['bank_tran_id'],
      feePaymentId: null,
    });
    expect(await paymentsOf(intent.id)).toEqual([]);
    // The counter's payment stands; no second receipt, no second SMS.
    const counterPayment = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.findUniqueOrThrow({ where: { id: counter.body.id } }),
    );
    expect(counterPayment.status).toBe('ACTIVE');
    await new Promise((r) => setTimeout(r, 300));
    expect((await receiptSms()).length).toBe(smsBefore);
    // The guardian is told the school is checking it.
    const page = (await api(h, s.tokens.guardian).get(fees(`/online-payments/${intent.id}`)))
      .body as OnlinePaymentView;
    expect(page.state).toBe('CHECKING');
    expect(JSON.stringify(page)).not.toContain('DUES_CHANGED');
  });

  it('review focus 2, the other order: paid online first → the counter gets 409 DUES_CHANGED', async () => {
    const { intent, due } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    await waitStatus(h, s.tenantId, intent.id, 'PAID');
    const res = await api(h, s.tokens.accountant).post('/fees/payments', {
      studentId: child().id,
      dueIds: [due.id],
      amountPaisa: 120000,
      expectedOutstandingPaisa: 120000,
      clientRequestId: randomUUID(),
    });
    expect([409, 422]).toContain(res.status);
  });

  describe('review focus 3: mismatches never post', () => {
    it.each([
      ['amount 1199.99', { amount: '1199.99' }, 'AMOUNT_MISMATCH'],
      ['currency_amount 1201.00', { currency_amount: '1201.00' }, 'AMOUNT_MISMATCH'],
      ['a grouped amount', { amount: '1,200.00' }, 'AMOUNT_MISMATCH'],
      ['currency USD', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
      ['currency_type USD', { currency_type: 'USD' }, 'CURRENCY_MISMATCH'],
      ['no bank_tran_id', { bank_tran_id: undefined }, 'TRAN_ID_MISMATCH'],
      ['risk_level 1', { risk_level: '1' }, 'HIGH_RISK'],
      ['no risk_level', { risk_level: undefined }, 'HIGH_RISK'],
    ])('%s → NEEDS_REVIEW %s, no payment, no receipt, no SMS', async (_label, fields, reason) => {
      const { intent } = await readyPayment();
      const smsBefore = (await receiptSms()).length;
      const t = await payAtGateway(h, fake, s.tenantId, intent.id, { fields });
      await postIpn(h, s.slug, ipnFields(t)).expect(200);
      const row = await waitStatus(h, s.tenantId, intent.id, 'NEEDS_REVIEW');
      expect(row.reviewReasons).toContain(reason);
      expect(row.valId).toBe(t.valId);
      expect(await paymentsOf(intent.id)).toEqual([]);
      expect((await receiptSms()).length).toBe(smsBefore);
    });

    it('another tran_id in the validation answer → TRAN_ID_MISMATCH, no money recorded on it', async () => {
      const { intent } = await readyPayment();
      const t = await payAtGateway(h, fake, s.tenantId, intent.id);
      t.tranId = newTranId();
      await postReturn(h, s.slug, intent.tranId, 'success', { val_id: t.valId }).expect(303);
      const row = await waitStatus(h, s.tenantId, intent.id, 'NEEDS_REVIEW');
      expect(row).toMatchObject({
        reviewReasons: ['TRAN_ID_MISMATCH'],
        valId: null,
        validatedAmountPaisa: null,
      });
      const [event] = await eventsOf(intent.id, 'VALIDATE');
      expect(event).toMatchObject({ reviewReason: 'UNMATCHED', tranId: t.tranId });
    });

    it('a fine waived meanwhile → DUES_CHANGED', async () => {
      const due = await extraDue(h, s, child().id, {
        amountPaisa: 100000,
        dueDate: addDays(s.today, -3),
        finePerDayPaisa: 1000,
      });
      const view = await startPayment(h, s.tokens.guardian, child().id, {
        dueIds: [due.id],
        expected: 103000,
      });
      await api(h, s.tokens.admin)
        .post(`/fees/dues/${due.id}/waive-fine`, { amountPaisa: 1000, reason: 'দেরি মাফ' })
        .expect(200);
      const t = await payAtGateway(h, fake, s.tenantId, view.id);
      await postIpn(h, s.slug, ipnFields(t)).expect(200);
      const row = await waitStatus(h, s.tenantId, view.id, 'NEEDS_REVIEW');
      expect(row.reviewReasons).toEqual(['DUES_CHANGED']);
    });
  });

  it('review focus 4: a made-up val_id posts nothing; another intent’s val_id is a TRAN_ID_MISMATCH here and posts there', async () => {
    const first = await readyPayment();
    await postReturn(h, s.slug, first.intent.tranId, 'success', { val_id: 'VALMADEUP0001' }).expect(
      303,
    );
    await vi.waitFor(async () =>
      expect((await eventsOf(first.intent.id, 'VALIDATE')).map((e) => e.outcome)).toContain(
        'INVALID',
      ),
    );
    expect((await intentRow(h, s.tenantId, first.intent.id)).status).toBe('REDIRECTED');
    expect(await paymentsOf(first.intent.id)).toEqual([]);
    await api(h, s.tokens.guardian)
      .post(fees(`/online-payments/${first.intent.id}/abandon`))
      .expect(200);

    // The third child's payment, paid; its val_id replayed on the first child's return.
    const other = await readyPayment(120000, s.students[2]!.id, s.tokens.otherGuardian);
    const mine = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, other.intent.id);
    await postReturn(h, s.slug, mine.intent.tranId, 'success', { val_id: t.valId }).expect(303);
    const review = await waitStatus(h, s.tenantId, mine.intent.id, 'NEEDS_REVIEW');
    expect(review).toMatchObject({ reviewReasons: ['TRAN_ID_MISMATCH'], valId: null });
    expect(await paymentsOf(mine.intent.id)).toEqual([]);
    // The other intent's own signal still posts it (SSLCommerz now says VALIDATED).
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    await waitStatus(h, s.tenantId, other.intent.id, 'PAID');
    expect(await paymentsOf(other.intent.id)).toHaveLength(1);
  });

  it("review focus 5: B's tran_id at A is an unmatched event; checked with A's store: INVALID or UNMATCHED", async () => {
    const b = await onlineSchool(h, fake);
    const bView = await startPayment(h, b.tokens.guardian, b.students[0]!.id);
    const bIntent = await intentRow(h, b.tenantId, bView.id);
    const bt = fake.pay(bIntent.sessionRef!);
    // B's IPN sent to A's address: stored at A with no intent; A's store does not know the val_id.
    await postIpn(h, s.slug, ipnFields(bt)).expect(200);
    await vi.waitFor(async () => {
      const unmatched = await eventsOf(null);
      const v = unmatched.find((e) => e.kind === 'VALIDATE' && e.valId === bt.valId);
      expect(v).toMatchObject({ outcome: 'INVALID', reviewReason: null });
    });
    expect((await intentRow(h, b.tenantId, bView.id)).status).toBe('REDIRECTED');
    expect(await paymentsOf(bView.id)).toEqual([]);
    // A payment of A's own store that names no intent of A: UNMATCHED, for P7b's queue.
    const sessionRes = await provider.createCheckout(s.store, {
      tranId: newTranId(),
      amountPaisa: 5000,
      intentId: randomUUID(),
      urls: {
        success: 'https://x/s',
        fail: 'https://x/f',
        cancel: 'https://x/c',
        ipn: 'https://x/i',
      },
      customer: {
        name: 'X',
        phone: '01700000000',
        email: 'x@x',
        address: 'N/A',
        city: 'N/A',
        postcode: 'N/A',
        country: 'Bangladesh',
      },
    });
    if (sessionRes.kind !== 'OK') throw new Error('no session');
    const stray = fake.pay(sessionRes.sessionRef);
    await postIpn(h, s.slug, ipnFields(stray)).expect(200);
    await vi.waitFor(async () => {
      const v = (await eventsOf(null)).find(
        (e) => e.kind === 'VALIDATE' && e.valId === stray.valId,
      );
      expect(v).toMatchObject({ reviewReason: 'UNMATCHED', outcome: 'VALID', intentId: null });
    });
    // Nothing at B either.
    const bEvents = await withTenant(h.prisma, b.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({ where: { valId: { in: [bt.valId, stray.valId] } } }),
    );
    expect(bEvents).toEqual([]);
  });

  it('review focus 8: priced at 23:55, paid at 00:05 the next day with a per-day fine → posted, the fine to the checkout day', async () => {
    const yesterday = addDays(s.today, -1);
    const due = await extraDue(h, s, child().id, {
      amountPaisa: 50000,
      dueDate: addDays(s.today, -5),
      finePerDayPaisa: 1000,
    });
    // As if the checkout had happened yesterday evening: 4 days late then, 5 today.
    const intent = await earlierIntent({
      dueId: due.id,
      principal: 50000,
      fine: 4000,
      pricedOn: yesterday,
      ageMs: 10 * 60_000,
    });
    expect(intent.status).toBe('REDIRECTED');
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
    const [payment] = await paymentsOf(intent.id);
    expect(payment).toMatchObject({
      amountPaisa: 54000,
      paidOn: dateToDb(yesterday),
      recordedOn: dateToDb(s.today),
    });
    const allocation = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePaymentAllocation.findFirstOrThrow({ where: { paymentId: paid.feePaymentId! } }),
    );
    expect(allocation).toMatchObject({ principalPaisa: 50000, finePaisa: 4000 });
    // The fine stopped on the checkout day: nothing more is owed.
    const ledger = await childFees(h, s.tokens.guardian, child().id);
    expect(ledger.ledger.dues.find((d) => d.id === due.id)!.balance.total).toBe(0);
  });

  it('late: abandoned, then paid → LATE_SUCCESS; a second payment after PAID → a DUPLICATE event', async () => {
    const { intent } = await readyPayment();
    await api(h, s.tokens.guardian)
      .post(fees(`/online-payments/${intent.id}/abandon`))
      .expect(200);
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    await postIpn(h, s.slug, ipnFields(t)).expect(200);
    const late = await waitStatus(h, s.tenantId, intent.id, 'NEEDS_REVIEW');
    expect(late).toMatchObject({ reviewReasons: ['LATE_SUCCESS'], valId: t.valId });
    expect(await paymentsOf(intent.id)).toEqual([]);

    const second = await readyPayment();
    const first = await payAtGateway(h, fake, s.tenantId, second.intent.id);
    await postIpn(h, s.slug, ipnFields(first)).expect(200);
    await waitStatus(h, s.tenantId, second.intent.id, 'PAID');
    const again = await payAtGateway(h, fake, s.tenantId, second.intent.id);
    await postIpn(h, s.slug, ipnFields(again)).expect(200);
    await vi.waitFor(async () => {
      const dup = (await eventsOf(second.intent.id, 'VALIDATE')).find(
        (e) => e.valId === again.valId,
      );
      expect(dup).toMatchObject({ reviewReason: 'DUPLICATE' });
    });
    expect(await paymentsOf(second.intent.id)).toHaveLength(1);
    expect((await intentRow(h, s.tenantId, second.intent.id)).valId).toBe(first.valId);
  });

  it('the validation API down: the job fails with a code (retried); then up: posted once', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    // The signal is stored; the worker's own run may take the first override.
    fake.override('validate', { status: 500 });
    fake.override('validate', { status: 500 });
    await postReturn(h, s.slug, intent.tranId, 'success', { val_id: t.valId }).expect(303);
    await vi.waitFor(async () =>
      expect((await eventsOf(intent.id, 'VALIDATE')).map((e) => e.outcome)).toContain(
        'HTTP_STATUS',
      ),
    );
    await expect(confirm.run({ tenantId: s.tenantId, intentId: intent.id })).rejects.toBeInstanceOf(
      PaymentJobError,
    );
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('REDIRECTED');
    await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
    await waitStatus(h, s.tenantId, intent.id, 'PAID');
    await confirm.run({ tenantId: s.tenantId, intentId: intent.id });
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it('suspended, FEES off, or the guardian unlinked after the checkout: still posted, the payer the actor (P7a-O, P7a-R)', async () => {
    const cookie = await platformAdminCookie(h);
    const p = () => platform(h, cookie);
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    // The guardian unlinked from the child (as the owner role: the app never deletes a link),
    // FEES switched off and the institute suspended, all after the checkout.
    const owner = ownerClient();
    const links = await withTenant(owner, s.tenantId, (tx) =>
      tx.studentGuardian.findMany({ where: { studentId: child().id } }),
    );
    await withTenant(owner, s.tenantId, (tx) =>
      tx.studentGuardian.deleteMany({ where: { studentId: child().id } }),
    );
    await p()
      .put(`/platform/institutes/${s.tenantId}/modules/FEES`)
      .send({ enabled: false })
      .expect(200);
    await p()
      .post(`/platform/institutes/${s.tenantId}/suspend`)
      .send({ reason: 'test' })
      .expect(200);
    try {
      await postIpn(h, s.slug, ipnFields(t)).expect(200);
      const paid = await waitStatus(h, s.tenantId, intent.id, 'PAID');
      const [payment] = await paymentsOf(intent.id);
      expect(payment).toMatchObject({ collectedById: intent.payerUserId, id: paid.feePaymentId });
    } finally {
      await p()
        .post(`/platform/institutes/${s.tenantId}/reactivate`)
        .send({ reason: 'test' })
        .expect(200);
      await p()
        .put(`/platform/institutes/${s.tenantId}/modules/FEES`)
        .send({ enabled: true })
        .expect(200);
      await withTenant(owner, s.tenantId, (tx) => tx.studentGuardian.createMany({ data: links }));
      await owner.$disconnect();
    }
  });

  it('review focus 6: a sentinel password reaches SSLCommerz and nothing else (checkout, a failed validation, a duplicate)', async () => {
    const logged: string[] = [];
    const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
    const spies = levels.map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args
            .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a)))
            .join(' '),
        );
      }),
    );
    const SENTINEL = `Sentinel-${randomUUID()}`;
    try {
      const x = await onlineSchool(h, fake);
      await enableAccount(h, fake, x.tokens.owner, {
        storeId: 'sentinel0042',
        storePassword: SENTINEL,
      });
      const bodies: string[] = [];
      const due = await extraDue(h, x, x.students[0]!.id, {
        amountPaisa: 120000,
        dueDate: x.today,
      });
      const view = await startPayment(h, x.tokens.guardian, x.students[0]!.id, {
        dueIds: [due.id],
        expected: 120000,
      });
      bodies.push(JSON.stringify(view));
      const row = await intentRow(h, x.tenantId, view.id);
      const t = fake.pay(row.sessionRef!);
      // A failed validation (500 whose body names the password), then the payment, then a
      // second payment (a DUPLICATE).
      fake.override('validate', { status: 500, raw: `upstream said ${SENTINEL}` });
      await postIpn(h, x.slug, ipnFields(t)).expect(200);
      await vi.waitFor(async () => {
        const ev = await withTenant(h.prisma, x.tenantId, (tx) =>
          tx.paymentGatewayEvent.findMany({ where: { intentId: view.id, kind: 'VALIDATE' } }),
        );
        expect(ev.length).toBeGreaterThan(0);
      });
      await confirm.run({ tenantId: x.tenantId, intentId: view.id }).catch(() => undefined);
      await waitStatus(h, x.tenantId, view.id, 'PAID');
      const dup = fake.pay(row.sessionRef!);
      await postIpn(h, x.slug, ipnFields(dup)).expect(200);
      await vi.waitFor(async () => {
        const ev = await withTenant(h.prisma, x.tenantId, (tx) =>
          tx.paymentGatewayEvent.findFirst({ where: { valId: dup.valId, kind: 'VALIDATE' } }),
        );
        expect(ev?.reviewReason).toBe('DUPLICATE');
      });
      bodies.push(
        (
          await api(h, x.tokens.guardian).get(
            `/me/children/${x.students[0]!.id}/fees/online-payments/${view.id}`,
          )
        ).text,
        (await api(h, x.tokens.owner).get('/fees/online-payments/account')).text,
      );

      // The positive control: SSLCommerz (the fake) was sent it.
      expect(fake.requests.some((r) => r.fields['store_passwd'] === SENTINEL)).toBe(true);
      expect(bodies.join('\n')).not.toContain(SENTINEL);
      expect(logged.join('\n')).not.toContain(SENTINEL);
      const db = await withTenant(h.prisma, x.tenantId, async (tx) => ({
        audit: await tx.auditLog.findMany(),
        sms: await tx.smsLog.findMany(),
        events: await tx.paymentGatewayEvent.findMany(),
        intents: await tx.paymentIntent.findMany(),
      }));
      expect(JSON.stringify(db)).not.toContain(SENTINEL);
      const redis = await redisDump(h.redis);
      expect(redis).not.toContain(SENTINEL);
      expect(redis).not.toContain('sentinel0042');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('heal on read: an open payment whose signals were all lost is asked about from its page', async () => {
    const due = await extraDue(h, s, child().id, { amountPaisa: 60000, dueDate: s.today });
    const intent = await earlierIntent({
      dueId: due.id,
      principal: 60000,
      fine: 0,
      pricedOn: s.today,
      ageMs: 5 * 60_000,
    });
    fake.pay(intent.sessionRef!);
    // No return, no IPN: reading the page asks the gateway (a query, then the validation).
    const page = (
      await api(h, s.tokens.guardian)
        .get(fees(`/online-payments/${intent.id}`))
        .expect(200)
    ).body as OnlinePaymentView;
    expect(page.state).toBe('READY');
    await waitStatus(h, s.tenantId, intent.id, 'PAID');
    expect((await eventsOf(intent.id, 'QUERY')).length).toBe(1);
    // Read again at once: no second heal within the minute.
    await api(h, s.tokens.guardian)
      .get(fees(`/online-payments/${intent.id}`))
      .expect(200);
    expect((await eventsOf(intent.id, 'QUERY')).length).toBe(1);
  });
});
