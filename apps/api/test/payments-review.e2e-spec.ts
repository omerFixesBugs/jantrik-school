import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateToDb,
  newTranId,
  type FeeLedger,
  type FeeReceipt,
  type OnlinePaymentCheckQueued,
  type OnlinePaymentList,
  type OnlinePaymentStaffView,
  type OnlinePaymentsReport,
  type OnlinePaymentView,
  type PaymentReviewQueue,
} from '@jantrik/shared';
import { CheckoutService } from '../src/payments/checkout.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../src/payments/provider.js';
import { ReconcileService } from '../src/payments/reconcile.service.js';
import { SettleService, type PaidOutcome } from '../src/payments/settle.service.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { createHarness, http, randomIp, type Harness } from './support/harness.js';
import {
  api,
  childFees,
  extraDue,
  intentRow,
  onlineSchool,
  payAtGateway,
  PUBLIC_API,
  PUBLIC_WEB,
  resetStartBudgets,
  startPayment,
  type OnlineSchool,
} from './support/payments.js';

// The review queue (sprint 1 P7b, Task 4, docs/payments.md → The review queue): an owner or admin
// applies the money of an online payment in review to chosen dues, records it as refunded outside
// the app, or dismisses what holds no money; an accountant only sees the queue (P7b-D). Each action
// is audited, runs under the student's lock and the intent's row lock, and makes one decision.
// Money is never dismissed (P7b-E); unmatched or duplicate money is never applied (P7b-H).

const NOTE = 'checked with the guardian and the bank';

describe('online payments: the review queue', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let s: OnlineSchool;
  let reconcile: ReconcileService;
  let settle: SettleService;
  let checkout: CheckoutService;
  let provider: PaymentProvider;

  const child = () => s.students[0]!;
  const as = (role: 'owner' | 'admin' | 'accountant' | 'teacher' | 'guardian') =>
    api(h, s.tokens[role]);
  const items = (path = '') => `/fees/online-payments${path}`;
  const paymentsOf = (intentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.findMany({
        where: { paymentIntentId: intentId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const auditOf = (entity: string, entityId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity, entityId }, orderBy: { createdAt: 'asc' } }),
    );
  const staffView = async (intentId: string) =>
    (
      await as('admin')
        .get(items(`/${intentId}`))
        .expect(200)
    ).body as OnlinePaymentStaffView;
  const guardianView = async (intentId: string, studentId = child().id) =>
    (
      await as('guardian')
        .get(`/me/children/${studentId}/fees/online-payments/${intentId}`)
        .expect(200)
    ).body as OnlinePaymentView;
  const validated = async (tranId: string, valId: string): Promise<PaidOutcome> => {
    const outcome = await provider.confirm(s.store, { tranId, valId });
    if (outcome.kind !== 'PAID') throw new Error(`not paid: ${outcome.kind}`);
    return outcome;
  };

  /** A due of its own and a payment for it at the gateway (READY). */
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
    return { due, intent: await intentRow(h, s.tenantId, view.id) };
  };

  /** A paid payment SSLCommerz reported with these fields, found by a check: in review or PAID. */
  const paidOnline = async (
    opts: { amountPaisa?: number; fields?: Record<string, string | undefined> } = {},
  ) => {
    const { due, intent } = await readyPayment(opts.amountPaisa);
    const t = await payAtGateway(h, fake, s.tenantId, intent.id, { fields: opts.fields });
    await reconcile.run({ tenantId: s.tenantId, intentId: intent.id, step: 'manual' });
    return { due, t, intent: await intentRow(h, s.tenantId, intent.id) };
  };
  /** In review as HIGH_RISK, holding the money (৳1 200 by default). */
  const risky = (amountPaisa = 120000) =>
    paidOnline({ amountPaisa, fields: { risk_level: '1', risk_title: 'Risky' } });

  const apply = (
    intentId: string,
    body: Record<string, unknown>,
    role: 'owner' | 'admin' = 'admin',
  ) =>
    as(role).post(items(`/${intentId}/apply`), {
      note: NOTE,
      clientRequestId: randomUUID(),
      ...body,
    });

  /**
   * An intent of the first child for one due as if its checkout had happened on `pricedOn`, with
   * its gateway session made by the init job (two minutes old: before reconciliation's first step).
   */
  const earlierIntent = async (opts: { dueId: string; amountPaisa: number; pricedOn: string }) => {
    const { account, payer } = await withTenant(h.prisma, s.tenantId, async (tx) => ({
      account: await tx.paymentGatewayAccount.findFirstOrThrow({ select: { id: true } }),
      payer: (
        await tx.guardian.findFirstOrThrow({
          where: { students: { some: { studentId: child().id } }, userId: { not: null } },
          select: { userId: true },
        })
      ).userId!,
    }));
    const createdAt = new Date(Date.now() - 2 * 60_000);
    const intent = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const created = await tx.paymentIntent.create({
        data: {
          tenantId: s.tenantId,
          accountId: account.id,
          studentId: child().id,
          payerUserId: payer,
          amountPaisa: opts.amountPaisa,
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
          plannedPrincipalPaisa: opts.amountPaisa,
          plannedFinePaisa: 0,
        },
      });
      return created;
    });
    await checkout.runInit({ tenantId: s.tenantId, intentId: intent.id });
    return intentRow(h, s.tenantId, intent.id);
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.sendIpn = false;
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    s = await onlineSchool(h, fake);
    reconcile = h.app.get(ReconcileService);
    settle = h.app.get(SettleService);
    checkout = h.app.get(CheckoutService);
    provider = h.app.get<PaymentProvider>(PAYMENT_PROVIDER);
  });

  beforeEach(async () => {
    await resetStartBudgets(h);
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

  it('the queue: intents in review with their reasons and the money items; staff of this institute only', async () => {
    const r = await risky();
    expect(r.intent.status).toBe('NEEDS_REVIEW');
    // Money received twice for a posted payment: a DUPLICATE item.
    const posted = await paidOnline({ amountPaisa: 50000 });
    expect(posted.intent.status).toBe('PAID');
    const second = fake.pay(posted.intent.sessionRef!);
    await reconcile.run({ tenantId: s.tenantId, intentId: posted.intent.id, step: 4 });

    const queue = (await as('accountant').get(items('/review')).expect(200))
      .body as PaymentReviewQueue;
    const item = queue.intents.find((i) => i.id === r.intent.id)!;
    expect(item).toMatchObject({
      status: 'NEEDS_REVIEW',
      reasons: ['HIGH_RISK'],
      amountPaisa: 120000,
      money: { valId: r.t.valId, amountPaisa: 120000, method: 'BKASH', risk: 'HIGH' },
      student: { id: child().id },
      actions: { apply: true, refundOutside: true, dismiss: false },
    });
    expect(item.dues).toEqual([
      expect.objectContaining({
        id: r.due.id,
        principalPaisa: 120000,
        now: expect.objectContaining({ status: 'OPEN', totalPaisa: 120000 }),
      }),
    ]);
    const signal = queue.signals.find((x) => x.intent?.id === posted.intent.id)!;
    expect(signal).toMatchObject({
      reason: 'DUPLICATE',
      money: { valId: second.valId, amountPaisa: 50000 },
      canDismiss: false,
      decision: null,
    });
    expect(queue.count).toBe(queue.intents.length + queue.signals.length);
    // The fee tabs' badge asks for the number alone.
    expect((await as('accountant').get(items('/review/count')).expect(200)).body).toEqual({
      count: queue.count,
    });
    // Oldest first.
    const since = queue.intents.map((i) => i.reviewSince!);
    expect([...since].sort()).toEqual(since);

    // The list and the detail.
    const list = (
      await as('accountant')
        .get(items(`?status=NEEDS_REVIEW&q=${r.intent.tranId}`))
        .expect(200)
    ).body as OnlinePaymentList;
    expect(list.rows.map((row) => row.id)).toEqual([r.intent.id]);
    const byCode = (
      await as('admin')
        .get(items(`?q=${child().code}`))
        .expect(200)
    ).body as OnlinePaymentList;
    expect(byCode.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([r.intent.id, posted.intent.id]),
    );
    const detail = await staffView(r.intent.id);
    expect(detail.events!.map((e) => e.kind)).toEqual(['INIT', 'QUERY', 'VALIDATE']);
    expect(JSON.stringify(detail)).not.toMatch(/card_no|verify_sign|store_passwd|01711XXXXXX/);

    // Teachers and guardians: nothing.
    await as('teacher').get(items('/review')).expect(403);
    await as('guardian').get(items('/review')).expect(403);
    await as('guardian')
      .get(items(`/${r.intent.id}`))
      .expect(403);
    // Another institute sees none of it.
    const other = await onlineSchool(h, fake);
    const theirs = (await api(h, other.tokens.admin).get(items('/review')).expect(200))
      .body as PaymentReviewQueue;
    expect(theirs.intents).toEqual([]);
    expect(theirs.signals).toEqual([]);
    await api(h, other.tokens.admin)
      .get(items(`/${r.intent.id}`))
      .expect(404);
    await api(h, other.tokens.admin)
      .post(items(`/${r.intent.id}/apply`), {
        dueIds: [r.due.id],
        applyPaisa: 120000,
        expectedOutstandingPaisa: 120000,
        note: NOTE,
        clientRequestId: randomUUID(),
      })
      .expect(404);
    await api(h, other.tokens.admin)
      .post(items(`/signals/${signal.eventId}/refunded-outside`), { note: NOTE })
      .expect(404);
  });

  it("review focus 2: paid at the counter while paying online; the money applied to next month, on the gateway's day", async () => {
    const yesterday = addDays(s.today, -1);
    const due = await extraDue(h, s, child().id, { amountPaisa: 100000, dueDate: yesterday });
    const intent = await earlierIntent({ dueId: due.id, amountPaisa: 100000, pricedOn: yesterday });
    // The accountant takes the due in cash while the guardian pays it online.
    await as('accountant')
      .post('/fees/payments', {
        studentId: child().id,
        dueIds: [due.id],
        amountPaisa: 100000,
        expectedOutstandingPaisa: 100000,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    const t = fake.pay(intent.sessionRef!, { fields: { tran_date: `${s.today} 09:15:00` } });
    await reconcile.run({ tenantId: s.tenantId, intentId: intent.id, step: 'manual' });
    const item = await staffView(intent.id);
    expect(item).toMatchObject({
      status: 'NEEDS_REVIEW',
      reasons: ['DUES_CHANGED'],
      money: { amountPaisa: 100000 },
    });
    // The due it was for is paid now (then: ৳1 000; now: nothing).
    expect(item.dues[0]).toMatchObject({ principalPaisa: 100000, now: { totalPaisa: 0 } });

    const ledger = (await as('admin').get(`/fees/students/${child().id}/ledger`).expect(200))
      .body as FeeLedger;
    const next = ledger.upcoming.find((u) => u.headId === s.tuition.id)!;
    const res = await apply(intent.id, {
      advance: [{ headId: next.headId, periodKey: next.periodKey }],
      applyPaisa: 100000,
      expectedOutstandingPaisa: next.amountPaisa - next.concessionPaisa,
      note: 'paid at the counter as well: applied to next month',
    }).expect(201);
    const receipt = res.body as FeeReceipt;
    expect(receipt).toMatchObject({
      channel: 'GATEWAY',
      method: 'BKASH',
      amountPaisa: 100000,
      // The day SSLCommerz took the money (P7b-F), not the checkout day.
      paidOn: s.today,
      online: { tranId: intent.tranId, bankTranId: t.fields['bank_tran_id'] },
      collectedBy: null,
    });
    expect(receipt.lines.map((l) => l.periodKey)).toEqual([next.periodKey]);
    const [payment, ...more] = await paymentsOf(intent.id);
    expect(more).toEqual([]);
    expect(payment).toMatchObject({ id: receipt.id, status: 'ACTIVE', amountPaisa: 100000 });
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'PAID',
      feePaymentId: receipt.id,
      appliedPaisa: 100000,
      refundedOutsidePaisa: null,
      resolutionNote: 'paid at the counter as well: applied to next month',
    });
    // The counter's payment of the first due stands; nothing applied twice.
    const view = await guardianView(intent.id);
    expect(view).toMatchObject({ state: 'PAID', receipt: { id: receipt.id } });
  });

  it("the browser test's flow: the counter sees the payment in progress and takes the due; the payer's return finds it to check; applied ahead; the guardian sees the receipt", async () => {
    // As apps/web/e2e/payments-review.spec.ts does it, through the API (the guardian on the
    // gateway's page, the accountant at the counter, the admin in the queue).
    const { due, intent } = await readyPayment(90000);
    const ledger = (await as('accountant').get(`/fees/students/${child().id}/ledger`).expect(200))
      .body as FeeLedger;
    const pending = ledger.dues.filter((d) => d.onlinePending);
    expect(pending.map((d) => d.id)).toEqual([due.id]);
    await as('accountant')
      .post('/fees/payments', {
        studentId: child().id,
        dueIds: [due.id],
        amountPaisa: pending[0]!.balance.total,
        expectedOutstandingPaisa: pending[0]!.balance.total,
        clientRequestId: randomUUID(),
      })
      .expect(201);

    // Paid on the gateway's page: the browser comes back (the IPN is off in this file).
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    const back = await http(h)
      .post(`/public/payments/sslcommerz/${s.slug}/return/${intent.tranId}/success`)
      .set('X-Forwarded-For', randomIp())
      .type('form')
      .send({ tran_id: t.tranId, val_id: t.valId, status: 'VALID' });
    expect(back.status).toBe(303);
    expect(back.headers['location']).toBe(
      `${PUBLIC_WEB}/children/${child().id}/fees/pay/${intent.id}?from=gateway`,
    );
    await vi.waitFor(async () => expect((await guardianView(intent.id)).state).toBe('CHECKING'), {
      timeout: 15_000,
      interval: 100,
    });
    const queue = (await as('admin').get(items('/review')).expect(200)).body as PaymentReviewQueue;
    const item = queue.intents.find((i) => i.id === intent.id)!;
    expect(item).toMatchObject({
      reasons: ['DUES_CHANGED'],
      money: { amountPaisa: 90000 },
      actions: { apply: true },
    });

    // The last period offered (a month ahead), the rest of the money refunded if it is less.
    const now = (await as('admin').get(`/fees/students/${child().id}/ledger`).expect(200))
      .body as FeeLedger;
    const ahead = now.upcoming.at(-1)!;
    const owed = ahead.amountPaisa - ahead.concessionPaisa;
    const applying = Math.min(90000, owed);
    const receipt = (
      await apply(intent.id, {
        advance: [{ headId: ahead.headId, periodKey: ahead.periodKey }],
        applyPaisa: applying,
        expectedOutstandingPaisa: owed,
        ...(applying < 90000 ? { refundOutside: { reference: 'SSL-RF-0001' } } : {}),
      }).expect(201)
    ).body as FeeReceipt;
    expect(receipt.lines.map((l) => l.periodKey)).toEqual([ahead.periodKey]);
    expect(await guardianView(intent.id)).toMatchObject({
      state: 'PAID',
      receipt: { id: receipt.id, receiptNumber: receipt.receiptNumber },
    });
    // Nothing in progress is left for the child.
    expect((await childFees(h, s.tokens.guardian, child().id)).online.inProgress).toBeNull();
  });

  it('less than the money: the rest must be recorded as refunded outside in the same action (P7b-E)', async () => {
    const r = await risky(120000);
    const small = await extraDue(h, s, child().id, { amountPaisa: 80000, dueDate: s.today });
    const body = { dueIds: [small.id], applyPaisa: 80000, expectedOutstandingPaisa: 80000 };
    const refused = await apply(r.intent.id, body).expect(422);
    expect(refused.body).toMatchObject({ code: 'REMAINDER_NEEDS_REFUND', remainderPaisa: 40000 });
    // More than the money, or than the dues owe: refused.
    expect((await apply(r.intent.id, { ...body, applyPaisa: 120001 }).expect(422)).body.code).toBe(
      'AMOUNT_EXCEEDS_MONEY',
    );
    expect(
      (
        await apply(r.intent.id, {
          ...body,
          applyPaisa: 90000,
          refundOutside: { reference: 'BK-RF-1' },
        }).expect(422)
      ).body.code,
    ).toBe('AMOUNT_EXCEEDS_DUE');
    // What the dues owe moved since it was shown: 409.
    expect(
      (await apply(r.intent.id, { ...body, expectedOutstandingPaisa: 70000 }).expect(409)).body,
    ).toMatchObject({ code: 'DUES_CHANGED', outstandingPaisa: 80000 });
    const receipt = (
      await apply(r.intent.id, { ...body, refundOutside: { reference: 'BK-RF-2026/11' } }).expect(
        201,
      )
    ).body as FeeReceipt;
    expect(receipt.amountPaisa).toBe(80000);
    expect(await intentRow(h, s.tenantId, r.intent.id)).toMatchObject({
      status: 'PAID',
      appliedPaisa: 80000,
      refundedOutsidePaisa: 40000,
      refundReference: 'BK-RF-2026/11',
    });
    // The intent's own due was not paid by it.
    const fees = await childFees(h, s.tokens.guardian, child().id);
    expect(fees.ledger.dues.find((d) => d.id === r.due.id)?.status).toBe('OPEN');
  });

  it('HIGH_RISK applied after a note; AMOUNT_MISMATCH applied as part of a due; CURRENCY_MISMATCH only refunded', async () => {
    const r = await risky();
    await apply(r.intent.id, {
      dueIds: [r.due.id],
      applyPaisa: 120000,
      expectedOutstandingPaisa: 120000,
      note: 'ok',
    }).expect(400);
    await apply(r.intent.id, {
      dueIds: [r.due.id],
      applyPaisa: 120000,
      expectedOutstandingPaisa: 120000,
    }).expect(201);

    const short = await paidOnline({
      fields: { amount: '1199.99', currency_amount: '1199.99', store_amount: '1170.00' },
    });
    expect(short.intent.status).toBe('NEEDS_REVIEW');
    expect(short.intent.reviewReasons).toEqual(['AMOUNT_MISMATCH']);
    const receipt = (
      await apply(short.intent.id, {
        dueIds: [short.due.id],
        applyPaisa: 119999,
        expectedOutstandingPaisa: 120000,
      }).expect(201)
    ).body as FeeReceipt;
    expect(receipt.amountPaisa).toBe(119999);
    const ledger = (await childFees(h, s.tokens.guardian, child().id)).ledger;
    expect(ledger.dues.find((d) => d.id === short.due.id)).toMatchObject({
      status: 'OPEN',
      balance: expect.objectContaining({ total: 1 }),
    });

    const foreign = await paidOnline({ fields: { currency: 'USD' } });
    expect(foreign.intent.reviewReasons).toContain('CURRENCY_MISMATCH');
    expect(
      (
        await apply(foreign.intent.id, {
          dueIds: [foreign.due.id],
          applyPaisa: 120000,
          expectedOutstandingPaisa: 120000,
        }).expect(422)
      ).body.code,
    ).toBe('CURRENCY_NOT_APPLICABLE');
    await as('admin')
      .post(items(`/${foreign.intent.id}/refunded-outside`), {
        note: 'paid in dollars by mistake; refunded by SSLCommerz',
        reference: 'SSL-RF-0001',
      })
      .expect(200);
    expect(await intentRow(h, s.tenantId, foreign.intent.id)).toMatchObject({
      status: 'REFUNDED_OUTSIDE',
      refundedOutsidePaisa: 120000,
      refundReference: 'SSL-RF-0001',
      appliedPaisa: null,
    });
    expect((await guardianView(foreign.intent.id)).state).toBe('REFUNDED');
    expect(await paymentsOf(foreign.intent.id)).toEqual([]);
  });

  it('review focus 3: two people decide at once, or a late payment arrives: exactly one decision', async () => {
    // Two admins apply the same item.
    const a = await risky();
    const both = await Promise.all(
      (['owner', 'admin'] as const).map((role) =>
        apply(
          a.intent.id,
          { dueIds: [a.due.id], applyPaisa: 120000, expectedOutstandingPaisa: 120000 },
          role,
        ),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.status === 409)!.body.code).toBe('ALREADY_RESOLVED');
    expect(await paymentsOf(a.intent.id)).toHaveLength(1);

    // An admin applies while a second payment for the same session is settled.
    const b = await risky();
    const late = fake.pay(b.intent.sessionRef!);
    const outcome = await validated(b.intent.tranId, late.valId);
    const [applied] = await Promise.all([
      apply(b.intent.id, {
        dueIds: [b.due.id],
        applyPaisa: 120000,
        expectedOutstandingPaisa: 120000,
      }),
      settle.settlePaid(s.tenantId, b.intent.id, b.intent.payerUserId, outcome),
    ]);
    expect(applied.status).toBe(201);
    expect(await paymentsOf(b.intent.id)).toHaveLength(1);
    const duplicates = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({
        where: { intentId: b.intent.id, reviewReason: 'DUPLICATE' },
      }),
    );
    expect(duplicates.map((e) => e.valId)).toEqual([late.valId]);

    // One refunds outside while another applies.
    const c = await risky();
    const decided = await Promise.all([
      apply(c.intent.id, {
        dueIds: [c.due.id],
        applyPaisa: 120000,
        expectedOutstandingPaisa: 120000,
      }),
      as('owner').post(items(`/${c.intent.id}/refunded-outside`), { note: NOTE }),
    ]);
    const statuses = decided.map((r) => r.status);
    expect(statuses.filter((x) => x === 409)).toHaveLength(1);
    expect(statuses.filter((x) => x === 200 || x === 201)).toHaveLength(1);
    const row = await intentRow(h, s.tenantId, c.intent.id);
    expect(['PAID', 'REFUNDED_OUTSIDE']).toContain(row.status);
    expect(await paymentsOf(c.intent.id)).toHaveLength(row.status === 'PAID' ? 1 : 0);
  });

  it('review focus 5: money is never dismissed; without money only after a fresh check found nothing; a later success comes back', async () => {
    const r = await risky();
    expect(
      (
        await as('admin')
          .post(items(`/${r.intent.id}/dismiss`), { note: NOTE })
          .expect(422)
      ).body.code,
    ).toBe('HAS_MONEY');

    // Another payment's money sent to this one: in review with no money of its own.
    const mine = await readyPayment(70000);
    const theirs = await readyPayment(60000, s.students[2]!.id, s.tokens.otherGuardian);
    const t = await payAtGateway(h, fake, s.tenantId, theirs.intent.id);
    await settle.settlePaid(
      s.tenantId,
      mine.intent.id,
      mine.intent.payerUserId,
      await validated(theirs.intent.tranId, t.valId),
    );
    expect(await intentRow(h, s.tenantId, mine.intent.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReasons: ['TRAN_ID_MISMATCH'],
      valId: null,
    });
    const dismiss = () =>
      as('admin').post(items(`/${mine.intent.id}/dismiss`), { note: 'not a payment of ours' });
    expect((await dismiss().expect(409)).body.code).toBe('CHECK_FIRST');
    await as('accountant')
      .post(items(`/${mine.intent.id}/dismiss`), { note: NOTE })
      .expect(403);

    // Check now (an accountant may): once a minute; the page waits for the answer.
    const queued = (
      await as('accountant')
        .post(items(`/${mine.intent.id}/check`))
        .expect(202)
    ).body as OnlinePaymentCheckQueued;
    await as('admin')
      .post(items(`/${mine.intent.id}/check`))
      .expect(429);
    await vi.waitFor(
      async () => {
        const view = await staffView(mine.intent.id);
        expect(view.lastCheck!.at >= queued.requestedAt).toBe(true);
        expect(view.lastCheck!.outcome).toBe('NO_SUCCESS');
        expect(view.actions).toMatchObject({ dismiss: true, dismissReady: true });
      },
      { timeout: 15_000, interval: 100 },
    );
    await dismiss().expect(200);
    const dismissed = await intentRow(h, s.tenantId, mine.intent.id);
    expect(dismissed).toMatchObject({
      status: 'DISMISSED',
      resolutionNote: 'not a payment of ours',
    });
    expect((await guardianView(mine.intent.id)).state).toBe('NOT_PAID');
    expect((await auditOf('payment_intent', mine.intent.id)).at(-1)).toMatchObject({
      action: 'UPDATE',
      oldValues: { status: 'NEEDS_REVIEW', reasons: ['TRAN_ID_MISMATCH'] },
      newValues: { status: 'DISMISSED', action: 'DISMISS', note: 'not a payment of ours' },
    });
    // Its due is free again: the guardian may pay it.
    const again = await startPayment(h, s.tokens.guardian, child().id, {
      dueIds: [mine.due.id],
      expected: 70000,
      wait: false,
    });
    await as('guardian').post(
      `/me/children/${child().id}/fees/online-payments/${again.id}/abandon`,
    );

    // The payer did pay after all: a success after a dismissal goes back to review.
    const paid = await payAtGateway(h, fake, s.tenantId, mine.intent.id);
    await reconcile.run({ tenantId: s.tenantId, intentId: mine.intent.id, step: 'manual' });
    const back = await staffView(mine.intent.id);
    expect(back).toMatchObject({
      status: 'NEEDS_REVIEW',
      reasons: ['TRAN_ID_MISMATCH', 'LATE_SUCCESS'],
      money: { valId: paid.valId, amountPaisa: 70000 },
      decision: null,
    });
  });

  it('money items: refunded outside or dismissed as a repeat record, once; never applied', async () => {
    const posted = await paidOnline({ amountPaisa: 50000 });
    const second = fake.pay(posted.intent.sessionRef!);
    const outcome = await validated(posted.intent.tranId, second.valId);
    // Two signals validated the same second payment: one item (review round 1, finding 2).
    await settle.settlePaid(s.tenantId, posted.intent.id, posted.intent.payerUserId, outcome);
    await settle.settlePaid(s.tenantId, posted.intent.id, posted.intent.payerUserId, outcome);
    const duplicates = () =>
      withTenant(h.prisma, s.tenantId, (tx) =>
        tx.paymentGatewayEvent.findMany({
          where: { intentId: posted.intent.id, reviewReason: 'DUPLICATE' },
          orderBy: { receivedAt: 'asc' },
        }),
      );
    expect(await duplicates()).toHaveLength(1);
    // Two records of it all the same (made before that rule, or by two sources): each is an item.
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: {
          tenantId: s.tenantId,
          intentId: posted.intent.id,
          kind: 'VALIDATE',
          outcome: 'VALIDATED',
          tranId: posted.intent.tranId,
          valId: second.valId,
          fields: { amount: '500.00', bank_tran_id: 'BTXTWICE001' },
          reviewReason: 'DUPLICATE',
          receivedAt: new Date(),
        },
      }),
    );
    const events = await duplicates();
    expect(events).toHaveLength(2);
    const signal = (eventId: string, action: string) => items(`/signals/${eventId}/${action}`);

    await as('accountant')
      .post(signal(events[0]!.id, 'refunded-outside'), { note: NOTE })
      .expect(403);
    await as('admin').post(signal(events[0]!.id, 'apply'), { note: NOTE }).expect(404);
    // Two admins dismiss the two records at once: one stands (money is never dismissed).
    const both = await Promise.all(
      events.map((e, i) =>
        as(i === 0 ? 'owner' : 'admin').post(signal(e.id, 'dismiss'), {
          note: 'the same payment recorded twice',
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(both.find((r) => r.status === 422)!.body.code).toBe('HAS_MONEY');
    const left = events[both.findIndex((r) => r.status === 422)]!;
    await as('admin')
      .post(signal(left.id, 'refunded-outside'), {
        note: 'paid twice; refunded through the merchant panel',
        reference: 'SSL-RF-0002',
      })
      .expect(200);
    for (const action of ['refunded-outside', 'dismiss']) {
      expect(
        (await as('admin').post(signal(left.id, action), { note: NOTE }).expect(409)).body.code,
      ).toBe('ALREADY_RESOLVED');
    }
    const reviews = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentSignalReview.findMany({
        where: { eventId: { in: events.map((e) => e.id) } },
      }),
    );
    expect(reviews.map((r) => r.outcome).sort()).toEqual(['DISMISSED', 'REFUNDED_OUTSIDE']);
    expect(reviews.find((r) => r.outcome === 'REFUNDED_OUTSIDE')).toMatchObject({
      amountPaisa: 50000,
      refundReference: 'SSL-RF-0002',
    });
    expect((await auditOf('payment_signal_review', left.id)).at(-1)).toMatchObject({
      action: 'CREATE',
      newValues: { outcome: 'REFUNDED_OUTSIDE', amountPaisa: 50000, reference: 'SSL-RF-0002' },
    });
    // Off the queue now.
    const queue = (await as('admin').get(items('/review')).expect(200)).body as PaymentReviewQueue;
    expect(queue.signals.some((x) => events.some((e) => e.id === x.eventId))).toBe(false);
    // The posted payment is untouched.
    expect(await paymentsOf(posted.intent.id)).toHaveLength(1);
  });

  it('one payment is refunded outside once: two settles of one second payment at once, then refund each record (review round 1, finding 2)', async () => {
    const posted = await paidOnline({ amountPaisa: 50000 });
    const second = fake.pay(posted.intent.sessionRef!);
    const outcome = await validated(posted.intent.tranId, second.valId);
    // An IPN's confirm and "check now" validate the same second payment at once.
    await Promise.all([
      settle.settlePaid(s.tenantId, posted.intent.id, posted.intent.payerUserId, outcome),
      settle.settlePaid(s.tenantId, posted.intent.id, posted.intent.payerUserId, outcome),
    ]);
    const records = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({
        where: { kind: 'VALIDATE', valId: second.valId },
        orderBy: { receivedAt: 'asc' },
      }),
    );
    expect(records).toHaveLength(2);
    const refunds = [];
    for (const record of records) {
      refunds.push(
        await as('admin').post(items(`/signals/${record.id}/refunded-outside`), {
          note: 'paid twice; refunded through the merchant panel',
        }),
      );
    }
    expect(refunds.map((r) => r.status).filter((x) => x === 200)).toHaveLength(1);
    const reviews = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentSignalReview.count({
        where: { outcome: 'REFUNDED_OUTSIDE', event: { valId: second.valId } },
      }),
    );
    expect(reviews).toBe(1);

    // A second record of money already refunded (however it came to be): refused, 409.
    const extra = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: {
          tenantId: s.tenantId,
          intentId: posted.intent.id,
          kind: 'VALIDATE',
          outcome: 'VALIDATED',
          tranId: posted.intent.tranId,
          valId: second.valId,
          fields: { amount: '500.00', bank_tran_id: 'BTXEXTRA001' },
          reviewReason: 'DUPLICATE',
          receivedAt: new Date(),
        },
      }),
    );
    expect(
      (
        await as('admin')
          .post(items(`/signals/${extra.id}/refunded-outside`), { note: NOTE })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_REFUNDED');
    // It is a repeat record of the refunded one: dismissed.
    await as('admin')
      .post(items(`/signals/${extra.id}/dismiss`), { note: 'the same payment recorded again' })
      .expect(200);
    // Money a payment of ours holds is never refunded as an item either.
    const held = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: {
          tenantId: s.tenantId,
          intentId: posted.intent.id,
          kind: 'VALIDATE',
          outcome: 'VALIDATED',
          tranId: posted.intent.tranId,
          valId: posted.intent.valId,
          fields: { amount: '500.00' },
          reviewReason: 'DUPLICATE',
          receivedAt: new Date(),
        },
      }),
    );
    expect(
      (
        await as('admin')
          .post(items(`/signals/${held.id}/refunded-outside`), { note: NOTE })
          .expect(409)
      ).body.code,
    ).toBe('HELD_BY_PAYMENT');
  });

  it('a void of an applied payment sends it back to review (VOIDED); applied again, one live payment', async () => {
    const r = await risky();
    const first = (
      await apply(r.intent.id, {
        dueIds: [r.due.id],
        applyPaisa: 120000,
        expectedOutstandingPaisa: 120000,
      }).expect(201)
    ).body as FeeReceipt;
    await as('admin').post(`/fees/payments/${first.id}/void`, { reason: 'wrong due' }).expect(200);
    const back = await staffView(r.intent.id);
    expect(back).toMatchObject({
      status: 'NEEDS_REVIEW',
      reasons: ['HIGH_RISK', 'VOIDED'],
      decision: null,
      payment: null,
    });
    const again = (
      await apply(r.intent.id, {
        dueIds: [r.due.id],
        applyPaisa: 120000,
        expectedOutstandingPaisa: 120000,
      }).expect(201)
    ).body as FeeReceipt;
    expect(again.id).not.toBe(first.id);
    const payments = await paymentsOf(r.intent.id);
    expect(payments.map((p) => p.status)).toEqual(['VOID', 'ACTIVE']);
  });

  it('a void after a partial apply keeps the refund: only the money left may be applied or refunded (review round 1, finding 1)', async () => {
    const report = async () =>
      (
        (
          await as('admin')
            .get(`/fees/reports/online-payments?from=${s.today}&to=${s.today}`)
            .expect(200)
        ).body as OnlinePaymentsReport
      ).total;
    const before = await report();
    // ৳1 200 in review: ৳800 applied to a smaller due, ৳400 given back outside; then voided.
    const r = await risky(120000);
    const small = await extraDue(h, s, child().id, { amountPaisa: 80000, dueDate: s.today });
    const first = (
      await apply(r.intent.id, {
        dueIds: [small.id],
        applyPaisa: 80000,
        expectedOutstandingPaisa: 80000,
        refundOutside: { reference: 'BK-RF-1' },
      }).expect(201)
    ).body as FeeReceipt;
    await as('admin').post(`/fees/payments/${first.id}/void`, { reason: 'wrong due' }).expect(200);
    expect(await staffView(r.intent.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      decision: null,
      refundedOutside: { amountPaisa: 40000, reference: 'BK-RF-1' },
    });
    expect(await intentRow(h, s.tenantId, r.intent.id)).toMatchObject({
      appliedPaisa: null,
      refundedOutsidePaisa: 40000,
      refundReference: 'BK-RF-1',
    });
    // The whole ৳1 200 again: refused (the records would cover ৳1 600 for ৳1 200).
    expect(
      (
        await apply(r.intent.id, {
          dueIds: [r.due.id],
          applyPaisa: 120000,
          expectedOutstandingPaisa: 120000,
        }).expect(422)
      ).body,
    ).toMatchObject({ code: 'AMOUNT_EXCEEDS_MONEY', moneyPaisa: 80000 });
    // The report keeps the refund; what waits is the ৳800 left.
    const voided = await report();
    expect(voided.refundedOutside.amountPaisa - before.refundedOutside.amountPaisa).toBe(40000);
    expect(voided.review.amountPaisa - before.review.amountPaisa).toBe(80000);
    expect(voided.received.amountPaisa - before.received.amountPaisa).toBe(120000);
    // The ৳800 left: applied again.
    const again = (
      await apply(r.intent.id, {
        dueIds: [r.due.id],
        applyPaisa: 80000,
        expectedOutstandingPaisa: 120000,
      }).expect(201)
    ).body as FeeReceipt;
    expect(again.amountPaisa).toBe(80000);
    expect(await intentRow(h, s.tenantId, r.intent.id)).toMatchObject({
      status: 'PAID',
      appliedPaisa: 80000,
      refundedOutsidePaisa: 40000,
      refundReference: 'BK-RF-1',
    });
    const after = await report();
    expect(after.refundedOutside.amountPaisa - before.refundedOutside.amountPaisa).toBe(40000);
    expect(after.paid.amountPaisa - before.paid.amountPaisa).toBe(80000);
    expect(after.review.amountPaisa - before.review.amountPaisa).toBe(0);

    // Or the rest given back too: the whole money is then refunded outside, the rest audited.
    const o = await risky(120000);
    const part = (
      await apply(o.intent.id, {
        dueIds: [small.id],
        applyPaisa: 80000,
        expectedOutstandingPaisa: 80000,
        refundOutside: { reference: 'BK-RF-2' },
      }).expect(201)
    ).body as FeeReceipt;
    await as('admin').post(`/fees/payments/${part.id}/void`, { reason: 'wrong due' }).expect(200);
    await as('admin')
      .post(items(`/${o.intent.id}/refunded-outside`), { note: NOTE, reference: 'BK-RF-3' })
      .expect(200);
    expect(await intentRow(h, s.tenantId, o.intent.id)).toMatchObject({
      status: 'REFUNDED_OUTSIDE',
      refundedOutsidePaisa: 120000,
      refundReference: 'BK-RF-3',
    });
    expect((await auditOf('payment_intent', o.intent.id)).at(-1)).toMatchObject({
      newValues: { status: 'REFUNDED_OUTSIDE', refundedOutsidePaisa: 120000, restPaisa: 80000 },
    });
  });

  it('a retried apply gets the same receipt; each decision is audited; the guardian sees it', async () => {
    const r = await risky();
    const body = {
      dueIds: [r.due.id],
      applyPaisa: 120000,
      expectedOutstandingPaisa: 120000,
      clientRequestId: randomUUID(),
    };
    const first = (await apply(r.intent.id, body).expect(201)).body as FeeReceipt;
    const retried = (await apply(r.intent.id, body).expect(201)).body as FeeReceipt;
    expect(retried).toMatchObject({ id: first.id, replayed: true });
    // The same request id for another payment: refused.
    const other = await risky();
    expect((await apply(other.intent.id, body).expect(422)).body.code).toBe('IDEMPOTENCY_MISMATCH');
    const audit = await auditOf('payment_intent', r.intent.id);
    expect(audit.at(-1)).toMatchObject({
      actorUserId: expect.any(String),
      action: 'UPDATE',
      oldValues: { status: 'NEEDS_REVIEW', reasons: ['HIGH_RISK'] },
      newValues: {
        status: 'PAID',
        action: 'APPLY',
        paymentId: first.id,
        appliedPaisa: 120000,
        refundedOutsidePaisa: null,
        dueIds: [r.due.id],
        note: NOTE,
      },
    });
    expect(await auditOf('fee_payment', first.id)).toEqual([
      expect.objectContaining({ action: 'CREATE' }),
    ]);
    expect(await guardianView(r.intent.id)).toMatchObject({
      state: 'PAID',
      receipt: { id: first.id, receiptNumber: first.receiptNumber },
    });
    // Refund outside is audited too.
    await as('owner')
      .post(items(`/${other.intent.id}/refunded-outside`), { note: NOTE, reference: 'R-1' })
      .expect(200);
    expect((await auditOf('payment_intent', other.intent.id)).at(-1)).toMatchObject({
      oldValues: { status: 'NEEDS_REVIEW' },
      newValues: {
        status: 'REFUNDED_OUTSIDE',
        action: 'REFUND_OUTSIDE',
        refundedOutsidePaisa: 120000,
        reference: 'R-1',
        note: NOTE,
      },
    });
  });
});
