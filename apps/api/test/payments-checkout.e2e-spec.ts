import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  ONLINE_MAX_PAISA,
  newTranId,
  ONLINE_MIN_PAISA,
  TRAN_ID_PATTERN,
  type OnlinePaymentView,
} from '@jantrik/shared';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../src/payments/payments.config.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { createHarness, type Harness } from './support/harness.js';
import {
  api,
  childFees,
  extraDue,
  intentRow,
  onlineSchool,
  owed,
  PUBLIC_API,
  PUBLIC_WEB,
  resetStartBudgets,
  startPayment,
  type OnlineSchool,
} from './support/payments.js';

// Guardians start an online payment for chosen dues in full; the server sets the amount and makes
// the SSLCommerz session in a job (sprint 1 P7a2, Task 14, S22). The fake SSLCommerz stands in.

describe('online payments: checkout', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let config: PaymentsConfig;
  let s: OnlineSchool;

  const path = (studentId: string) => `/me/children/${studentId}/fees/online-payments`;
  const start = (token: string, studentId: string, body: Record<string, unknown>) =>
    api(h, token).post(path(studentId), { clientRequestId: randomUUID(), ...body });
  const guardian = () => api(h, s.tokens.guardian);
  const child = () => s.students[0]!.id;

  /** Abandon whatever is in progress for the child, so the next case can start. */
  const clearChild = async (studentId = child(), token = s.tokens.guardian) => {
    const view = await childFees(h, token, studentId);
    if (view.online.inProgress?.mine) {
      await api(h, token)
        .post(`${path(studentId)}/${view.online.inProgress.intentId}/abandon`)
        .expect(200);
    }
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.sendIpn = false;
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    config = h.app.get<PaymentsConfig>(PAYMENTS_CONFIG);
    s = await onlineSchool(h, fake);
  });

  beforeEach(async () => {
    await resetStartBudgets(h);
  });

  afterEach(() => {
    config.apiPublicUrl = PUBLIC_API;
    config.webPublicUrl = PUBLIC_WEB;
    config.sslcommerzBaseUrl = fake.url;
  });

  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('S22: the amount is what the chosen dues owe today in full, fines included; the snapshot matches', async () => {
    const all = await owed(h, s.tokens.guardian, child());
    expect(all.dueIds.length).toBeGreaterThanOrEqual(2);
    const view = await startPayment(h, s.tokens.guardian, child());
    expect(view).toMatchObject({ state: 'READY', amountPaisa: all.total, mine: true });
    expect(view.tranId).toMatch(TRAN_ID_PATTERN);
    expect(view.checkoutUrl).toMatch(new RegExp(`^${fake.url}/pay/`));
    // The last month's due carries its fine (a per-day fine at its cap by now).
    const fees = await childFees(h, s.tokens.guardian, child());
    const dues = fees.ledger.dues.filter((d) => all.dueIds.includes(d.id));
    expect(view.dues.map((d) => [d.id, d.principalPaisa, d.finePaisa]).sort()).toEqual(
      dues.map((d) => [d.id, d.balance.principal, d.balance.fine]).sort(),
    );
    expect(view.dues.some((d) => d.finePaisa > 0)).toBe(true);
    const row = await intentRow(h, s.tenantId, view.id);
    expect(row).toMatchObject({
      status: 'REDIRECTED',
      amountPaisa: all.total,
      currency: 'BDT',
      pricedOn: new Date(`${s.today}T00:00:00.000Z`),
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(60 * 60_000);
    // SSLCommerz was sent our amount, tran_id and addresses, the guardian as the payer.
    const session = fake.sessions.get(row.sessionRef!)!;
    const amount = `${Math.floor(all.total / 100)}.${String(all.total % 100).padStart(2, '0')}`;
    expect(session.fields).toMatchObject({
      total_amount: amount,
      currency: 'BDT',
      tran_id: row.tranId,
      success_url: `${PUBLIC_API}/public/payments/sslcommerz/${s.slug}/return/${row.tranId}/success`,
      fail_url: `${PUBLIC_API}/public/payments/sslcommerz/${s.slug}/return/${row.tranId}/fail`,
      cancel_url: `${PUBLIC_API}/public/payments/sslcommerz/${s.slug}/return/${row.tranId}/cancel`,
      ipn_url: `${PUBLIC_API}/public/payments/sslcommerz/${s.slug}/ipn`,
      cus_name: 'Karim',
      cus_phone: s.students[0]!.phone.replace(/^\+88/, ''),
      cus_country: 'Bangladesh',
      value_a: view.id,
      product_name: 'School fees',
    });
    // An INIT event and an audit row naming the guardian.
    const events = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({ where: { intentId: view.id } }),
    );
    expect(events).toEqual([expect.objectContaining({ kind: 'INIT', outcome: 'OK' })]);
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'payment_intent', entityId: view.id } }),
    );
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));
    expect(audit.find((a) => a.action === 'CREATE')!.newValues).toMatchObject({
      amountPaisa: all.total,
      tranId: row.tranId,
    });
    await clearChild();
  });

  it('S22: never an amount from the client; a stale total is 409 with the real one', async () => {
    const { dueIds, total } = await owed(h, s.tokens.guardian, child());
    const withAmount = await start(s.tokens.guardian, child(), {
      dueIds,
      expectedAmountPaisa: total,
      amountPaisa: 1000,
    });
    expect(withAmount.status).toBe(400);
    const stale = await start(s.tokens.guardian, child(), {
      dueIds,
      expectedAmountPaisa: total - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'DUES_CHANGED', amountPaisa: total });
  });

  it("another child's due, a cancelled one, a paid one, another family's child: 404 or 422", async () => {
    const mine = await owed(h, s.tokens.guardian, child());
    const sibling = await owed(h, s.tokens.guardian, s.students[1]!.id);
    // The sibling's due on this child's payment.
    expect(
      (
        await start(s.tokens.guardian, child(), {
          dueIds: [mine.dueIds[0], sibling.dueIds[0]],
          expectedAmountPaisa: 1,
        })
      ).status,
    ).toBe(404);
    // Another family's child.
    const other = s.students[2]!.id;
    const others = await owed(h, s.tokens.otherGuardian, other);
    expect(
      (
        await start(s.tokens.guardian, other, {
          dueIds: others.dueIds,
          expectedAmountPaisa: others.total,
        })
      ).status,
    ).toBe(404);
    // A cancelled due.
    const fees = await childFees(h, s.tokens.guardian, s.students[1]!.id);
    const cancelled = fees.ledger.dues.find((d) => d.status === 'OPEN')!;
    await api(h, s.tokens.admin)
      .post(`/fees/dues/${cancelled.id}/cancel`, { reason: 'ভুল করে তৈরি' })
      .expect(200);
    expect(
      (
        await start(s.tokens.guardian, s.students[1]!.id, {
          dueIds: [cancelled.id],
          expectedAmountPaisa: cancelled.balance.total,
        })
      ).status,
    ).toBe(404);
    // A due paid at the counter: nothing owed.
    const paid = sibling.dueIds.find((id) => id !== cancelled.id)!;
    const ledger = await childFees(h, s.tokens.guardian, s.students[1]!.id);
    const owedNow = ledger.ledger.dues.find((d) => d.id === paid)!.balance.total;
    await api(h, s.tokens.accountant)
      .post('/fees/payments', {
        studentId: s.students[1]!.id,
        dueIds: [paid],
        amountPaisa: owedNow,
        expectedOutstandingPaisa: owedNow,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    const nothing = await start(s.tokens.guardian, s.students[1]!.id, {
      dueIds: [paid],
      expectedAmountPaisa: 0,
    });
    expect(nothing.status).toBe(422);
    expect(nothing.body.code).toBe('NOTHING_DUE');
  });

  it('staff never start a payment for a guardian (no staff payment links): 403', async () => {
    const { dueIds, total } = await owed(h, s.tokens.guardian, child());
    for (const token of [s.tokens.owner, s.tokens.admin, s.tokens.accountant, s.tokens.teacher]) {
      const res = await start(token, child(), { dueIds, expectedAmountPaisa: total });
      expect(res.status).toBe(403);
    }
  });

  it('below ৳10 (or above ৳5 lakh) cannot be paid online: 422 with the range', async () => {
    // A due of ৳9.99 for the third child.
    const other = s.students[2]!;
    const due = await extraDue(h, s, other.id, { amountPaisa: 999, dueDate: s.today });
    const res = await start(s.tokens.otherGuardian, other.id, {
      dueIds: [due.id],
      expectedAmountPaisa: 999,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'ONLINE_AMOUNT_OUT_OF_RANGE',
      minPaisa: ONLINE_MIN_PAISA,
      maxPaisa: ONLINE_MAX_PAISA,
    });
  });

  it('a retry with the same request id is the same payment; with other dues, 422', async () => {
    const { dueIds, total } = await owed(h, s.tokens.guardian, child());
    const clientRequestId = randomUUID();
    const body = { dueIds, expectedAmountPaisa: total, clientRequestId };
    const first = (await guardian().post(path(child()), body).expect(201))
      .body as OnlinePaymentView;
    const again = (await guardian().post(path(child()), body).expect(201))
      .body as OnlinePaymentView;
    expect(again.id).toBe(first.id);
    const other = await guardian().post(path(child()), { ...body, dueIds: [dueIds[0]] });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_MISMATCH');
    await clearChild();
  });

  it('one payment in progress per child (P7a-F): 409 until abandoned or an hour has passed', async () => {
    const first = await startPayment(h, s.tokens.guardian, child());
    const { dueIds, total } = await owed(h, s.tokens.guardian, child());
    const second = await start(s.tokens.guardian, child(), { dueIds, expectedAmountPaisa: total });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: 'PAYMENT_IN_PROGRESS',
      intentId: first.id,
      mine: true,
    });
    expect(JSON.stringify(second.body)).not.toMatch(/Karim|করিম/);
    // The guardian's fees page says so.
    const fees = await childFees(h, s.tokens.guardian, child());
    expect(fees.online).toEqual({
      available: true,
      inProgress: { intentId: first.id, mine: true, createdAt: expect.any(String) },
    });
    // Another guardian may not abandon it; the payer may.
    await api(h, s.tokens.otherGuardian)
      .post(`${path(child())}/${first.id}/abandon`)
      .expect(404);
    const abandoned = (
      await guardian()
        .post(`${path(child())}/${first.id}/abandon`)
        .expect(200)
    ).body as OnlinePaymentView;
    expect(abandoned.state).toBe('NOT_PAID');
    expect((await guardian().post(`${path(child())}/${first.id}/abandon`)).status).toBe(409);
    // Allowed again.
    await startPayment(h, s.tokens.guardian, child());
    await clearChild();
    // An unfinished payment older than an hour no longer blocks (P7b expires it).
    const { dueIds: ids, total: amount } = await owed(h, s.tokens.guardian, child());
    const row = await intentRow(h, s.tenantId, first.id);
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const old = await tx.paymentIntent.create({
        data: {
          tenantId: s.tenantId,
          accountId: row.accountId,
          studentId: child(),
          payerUserId: row.payerUserId,
          amountPaisa: amount,
          pricedOn: row.pricedOn,
          tranId: newTranId(Date.now() - 2 * 3600_000),
          clientRequestId: randomUUID(),
          createdAt: new Date(Date.now() - 2 * 3600_000),
          expiresAt: new Date(Date.now() - 3600_000),
        },
      });
      const fees = await childFees(h, s.tokens.guardian, child());
      await tx.paymentIntentDue.createMany({
        data: fees.ledger.dues
          .filter((d) => ids.includes(d.id))
          .map((d) => ({
            tenantId: s.tenantId,
            intentId: old.id,
            studentId: child(),
            dueId: d.id,
            plannedPrincipalPaisa: d.balance.principal,
            plannedFinePaisa: d.balance.fine,
          })),
      });
    });
    await startPayment(h, s.tokens.guardian, child());
    await clearChild();
  });

  it('init: SSLCommerz refuses or does not answer → NOT_PAID with the code, no retry; the owner sees it', async () => {
    fake.override('session', { json: { status: 'FAILED', failedreason: 'Invalid data' } });
    const failed = await startPayment(h, s.tokens.guardian, child(), { wait: 'NOT_PAID' });
    expect(await intentRow(h, s.tenantId, failed.id)).toMatchObject({
      status: 'FAILED',
      initError: 'INVALID_REQUEST',
    });
    const sessions = fake.requests.filter((r) => r.api === 'session').length;
    fake.override('session', { status: 500 });
    const down = await startPayment(h, s.tokens.guardian, child(), { wait: 'NOT_PAID' });
    expect(await intentRow(h, s.tenantId, down.id)).toMatchObject({ initError: 'HTTP_STATUS' });
    // One attempt each.
    expect(fake.requests.filter((r) => r.api === 'session').length).toBe(sessions + 1);
    const account = (await api(h, s.tokens.owner).get('/fees/online-payments/account').expect(200))
      .body;
    expect(account.lastFailure).toMatchObject({ code: 'HTTP_STATUS' });
    // A failed one blocks nothing.
    const ok = await startPayment(h, s.tokens.guardian, child());
    expect(ok.state).toBe('READY');
    await clearChild();
  });

  it('online payment off: the account off, or no public address → 422, and not offered', async () => {
    const { dueIds, total } = await owed(h, s.tokens.guardian, child());
    for (const change of [() => (config.apiPublicUrl = null), () => (config.webPublicUrl = null)]) {
      change();
      const res = await start(s.tokens.guardian, child(), { dueIds, expectedAmountPaisa: total });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ONLINE_PAYMENTS_OFF');
      expect((await childFees(h, s.tokens.guardian, child())).online.available).toBe(false);
      config.apiPublicUrl = PUBLIC_API;
      config.webPublicUrl = PUBLIC_WEB;
    }
    await api(h, s.tokens.owner).post('/fees/online-payments/account/disable').expect(200);
    try {
      const res = await start(s.tokens.guardian, child(), { dueIds, expectedAmountPaisa: total });
      expect(res.body.code).toBe('ONLINE_PAYMENTS_OFF');
      expect((await childFees(h, s.tokens.guardian, child())).online.available).toBe(false);
    } finally {
      await api(h, s.tokens.owner).post('/fees/online-payments/account/enable').expect(200);
    }
  });

  it('the counter sees the dues of a payment in progress (onlinePending) and still takes cash', async () => {
    const view = await startPayment(h, s.tokens.guardian, child());
    const ledger = (
      await api(h, s.tokens.accountant).get(`/fees/students/${child()}/ledger`).expect(200)
    ).body as { dues: { id: string; onlinePending: boolean }[] };
    for (const d of ledger.dues) {
      expect(d.onlinePending, d.id).toBe(view.dues.some((v) => v.id === d.id));
    }
    await clearChild();
    const after = (
      await api(h, s.tokens.accountant).get(`/fees/students/${child()}/ledger`).expect(200)
    ).body as { dues: { onlinePending: boolean }[] };
    expect(after.dues.every((d) => !d.onlinePending)).toBe(true);
  });

  it('the payment view: any guardian of the child sees it, the gateway page only the payer', async () => {
    const view = await startPayment(h, s.tokens.guardian, child());
    // The other guardian is not the child's: 404.
    await api(h, s.tokens.otherGuardian)
      .get(`${path(child())}/${view.id}`)
      .expect(404);
    // An unknown intent, or this one under another child: 404.
    await guardian()
      .get(`${path(child())}/${randomUUID()}`)
      .expect(404);
    await guardian()
      .get(`${path(s.students[1]!.id)}/${view.id}`)
      .expect(404);
    await clearChild();
  });
});
