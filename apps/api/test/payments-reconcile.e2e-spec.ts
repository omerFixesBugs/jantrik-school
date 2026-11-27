import { getQueueToken } from '@nestjs/bullmq';
import { withTenant } from '@jantrik/db';
import type { Queue } from 'bullmq';
import { ConfirmService } from '../src/payments/confirm.service.js';
import {
  PAYMENTS_OPEN_KEY,
  PAYMENTS_QUEUE,
  RECONCILE_DELAYS_MS,
  reconcileJobId,
  type ReconcileStep,
} from '../src/payments/payments.constants.js';
import { PaymentJobError } from '../src/payments/confirm.service.js';
import { ReconcileService } from '../src/payments/reconcile.service.js';
import { FakeClock } from './support/clock.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { createHarness, type Harness } from './support/harness.js';
import {
  api,
  childFees,
  extraDue,
  intentRow,
  ipnFields,
  onlineSchool,
  payAtGateway,
  postIpn,
  PUBLIC_API,
  PUBLIC_WEB,
  resetStartBudgets,
  startPayment,
  type OnlineSchool,
} from './support/payments.js';

// Reconciliation (sprint 1 P7b, Task 2, docs/payments.md → Reconciliation): SSLCommerz is asked
// about every online payment by our tran_id at +5 min, +30 min, +2 h and +25 h, so a lost IPN and
// a closed browser tab still end in a receipt or in review. A query answer never posts by itself:
// every success it lists goes through the validation API and settle, exactly as an IPN does
// (P7b-A). The steps are run directly here (BullMQ's own delays run on real time), with a fake
// clock and the fake SSLCommerz.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('online payments: reconciliation', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let s: OnlineSchool;
  let clock: FakeClock;
  let reconcile: ReconcileService;
  let confirm: ConfirmService;
  let queue: Queue;

  const child = () => s.students[0]!;
  const step = (intentId: string, n: ReconcileStep) =>
    reconcile.run({ tenantId: s.tenantId, intentId, step: n });
  const member = (intentId: string, n: ReconcileStep) => `${s.tenantId}:${intentId}:${n}`;
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
  const auditOf = (intentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'payment_intent', entityId: intentId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** A due of its own for the first child, and a payment for it waiting at the gateway. */
  const readyPayment = async (amountPaisa = 120000) => {
    const due = await extraDue(h, s, child().id, { amountPaisa, dueDate: s.today });
    const view = await startPayment(h, s.tokens.guardian, child().id, {
      dueIds: [due.id],
      expected: amountPaisa,
    });
    return { due, view, intent: await intentRow(h, s.tenantId, view.id) };
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    // Nothing reaches us by itself: no IPN, and no browser coming back.
    fake.sendIpn = false;
    clock = new FakeClock(new Date());
    h = await createHarness({
      clock,
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    s = await onlineSchool(h, fake);
    reconcile = h.app.get(ReconcileService);
    confirm = h.app.get(ConfirmService);
    queue = h.app.get<Queue>(getQueueToken(PAYMENTS_QUEUE));
  });

  beforeEach(async () => {
    clock.set(new Date());
    await resetStartBudgets(h);
    // Whatever a case left in progress, abandoned (one payment in progress per child).
    const view = await childFees(h, s.tokens.guardian, child().id);
    if (view.online.inProgress?.mine) {
      await api(h, s.tokens.guardian).post(
        `/me/children/${child().id}/fees/online-payments/${view.online.inProgress.intentId}/abandon`,
      );
    }
  });

  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('a new session schedules four queries (+5 min, +30 min, +2 h, +25 h) and lists them in payments:open', async () => {
    const { intent } = await readyPayment();
    expect(RECONCILE_DELAYS_MS.slice(0, 4)).toEqual([5 * MINUTE, 30 * MINUTE, 2 * HOUR, 25 * HOUR]);
    for (const [i, n] of ([1, 2, 3, 4] as const).entries()) {
      const due = intent.createdAt.getTime() + RECONCILE_DELAYS_MS[i]!;
      expect(Number(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, n)))).toBe(due);
      const job = await queue.getJob(reconcileJobId(intent.id, n));
      expect(job?.data).toEqual({ tenantId: s.tenantId, intentId: intent.id, step: n });
      expect(await job!.isDelayed()).toBe(true);
      expect(job!.opts.delay).toBeGreaterThan(RECONCILE_DELAYS_MS[i]! - MINUTE);
      expect(job!.opts.delay).toBeLessThanOrEqual(RECONCILE_DELAYS_MS[i]!);
    }
    // A session that failed gets none.
    await api(h, s.tokens.guardian).post(
      `/me/children/${child().id}/fees/online-payments/${intent.id}/abandon`,
    );
    fake.override('session', { status: 500 });
    const failed = await startPayment(h, s.tokens.guardian, child().id, { wait: 'NOT_PAID' });
    expect(await queue.getJob(reconcileJobId(failed.id, 1))).toBeUndefined();
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(failed.id, 1))).toBeNull();
  });

  it('the IPN and the return both lost: the +5 min query finds the payment; validated, posted once', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    clock.advance(5 * MINUTE);
    await step(intent.id, 1);
    const row = await intentRow(h, s.tenantId, intent.id);
    expect(row).toMatchObject({
      status: 'PAID',
      valId: t.valId,
      lastCheckOutcome: 'SUCCESS_FOUND',
    });
    expect(row.lastCheckedAt).toEqual(clock.now());
    expect(await paymentsOf(intent.id)).toHaveLength(1);
    // Asked by tran_id, then confirmed with the validation API (never from the query alone).
    expect((await eventsOf(intent.id)).map((e) => e.kind)).toEqual(['INIT', 'QUERY', 'VALIDATE']);
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 1))).toBeNull();
    // The later steps on a posted payment: nothing to do but +25 h (P7b-J).
    const before = fake.requests.length;
    await step(intent.id, 2);
    await step(intent.id, 3);
    expect(fake.requests.length).toBe(before);
    await step(intent.id, 4);
    expect(fake.requests.length).toBe(before + 1);
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it('PENDING: nothing until +25 h, then EXPIRED (audited); a success at +7 days goes to review, never a receipt', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id, { status: 'PENDING' });
    await step(intent.id, 1);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'PENDING',
    });
    clock.advance(3 * HOUR);
    await step(intent.id, 3);
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('REDIRECTED');
    clock.advance(22 * HOUR);
    await step(intent.id, 4);
    const expired = await intentRow(h, s.tenantId, intent.id);
    expect(expired).toMatchObject({ status: 'EXPIRED', lastCheckOutcome: 'PENDING' });
    expect(expired.closedAt).toEqual(clock.now());
    const audit = await auditOf(intent.id);
    expect(audit.at(-1)).toMatchObject({
      actorUserId: null,
      action: 'UPDATE',
      oldValues: { status: 'REDIRECTED' },
      newValues: { status: 'EXPIRED', by: 'RECONCILE', step: 4 },
    });
    // One last query at +7 days (P7b-K).
    const last = intent.createdAt.getTime() + 7 * 24 * HOUR;
    expect(RECONCILE_DELAYS_MS[4]).toBe(7 * 24 * HOUR);
    expect(Number(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 5)))).toBe(last);
    expect(await queue.getJob(reconcileJobId(intent.id, 5))).toBeTruthy();
    // The bKash payment completed late: review (LATE_SUCCESS), no payment, no receipt.
    t.status = 'VALID';
    clock.set(new Date(last));
    await step(intent.id, 5);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReasons: ['LATE_SUCCESS'],
      valId: t.valId,
      validatedAmountPaisa: 120000,
    });
    expect(await paymentsOf(intent.id)).toEqual([]);
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 5))).toBeNull();
  });

  it('only FAILED attempts: still open within the hour, FAILED after it; nothing at all at +25 h: EXPIRED', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id, { status: 'FAILED' });
    clock.advance(30 * MINUTE);
    await step(intent.id, 2);
    // The payer had the whole window to try again.
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'NO_SUCCESS',
    });
    clock.advance(90 * MINUTE);
    await step(intent.id, 3);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({ status: 'FAILED' });

    // Nothing ever attempted: no close before +25 h, EXPIRED then.
    clock.set(new Date());
    const quiet = (await readyPayment()).intent;
    clock.advance(2 * HOUR);
    await step(quiet.id, 3);
    expect(await intentRow(h, s.tenantId, quiet.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'NO_SUCCESS',
    });
    clock.advance(23 * HOUR);
    await step(quiet.id, 4);
    expect((await intentRow(h, s.tenantId, quiet.id)).status).toBe('EXPIRED');
    // Nothing pending: no +7 day query.
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(quiet.id, 5))).toBeNull();
  });

  it('review focus 1: a reconcile and the IPN for the same val_id at once make one payment', async () => {
    const { intent } = await readyPayment();
    const t = await payAtGateway(h, fake, s.tenantId, intent.id);
    expect((await postIpn(h, s.slug, ipnFields(t))).status).toBe(200);
    await Promise.all([
      step(intent.id, 1),
      confirm.run({ tenantId: s.tenantId, intentId: intent.id }),
      step(intent.id, 'manual'),
    ]);
    await vi.waitFor(async () => {
      expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
    });
    const payments = await paymentsOf(intent.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountPaisa).toBe(120000);
  });

  it('+25 h on a posted payment finds a second payment: a DUPLICATE item, the first payment untouched', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    await step(intent.id, 1);
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
    // The guardian paid again on the same session.
    const second = await payAtGateway(h, fake, s.tenantId, intent.id);
    clock.advance(25 * HOUR);
    await step(intent.id, 4);
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
    const duplicate = (await eventsOf(intent.id, 'VALIDATE')).find((e) => e.valId === second.valId);
    expect(duplicate).toMatchObject({ reviewReason: 'DUPLICATE' });
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it('a success with another amount is validated and reviewed (AMOUNT_MISMATCH); the query alone posts nothing', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id, {
      fields: { amount: '1199.99', currency_amount: '1199.99', store_amount: '1170.00' },
    });
    await step(intent.id, 1);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReasons: ['AMOUNT_MISMATCH'],
      validatedAmountPaisa: 119999,
    });
    expect(await paymentsOf(intent.id)).toEqual([]);

    // The query lists a success the validation API does not confirm: nothing is posted.
    const other = (await readyPayment()).intent;
    await payAtGateway(h, fake, s.tenantId, other.id);
    fake.override('validate', { json: { status: 'INVALID_TRANSACTION' } });
    await step(other.id, 1);
    expect(await intentRow(h, s.tenantId, other.id)).toMatchObject({ status: 'REDIRECTED' });
    expect(await paymentsOf(other.id)).toEqual([]);
  });

  it('an intent already in review: the query only records what it found (S23)', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id, { fields: { risk_level: '1' } });
    await step(intent.id, 1);
    const reviewed = await intentRow(h, s.tenantId, intent.id);
    expect(reviewed).toMatchObject({ status: 'NEEDS_REVIEW', reviewReasons: ['HIGH_RISK'] });
    clock.advance(30 * MINUTE);
    await step(intent.id, 2);
    clock.advance(25 * HOUR);
    await step(intent.id, 4);
    const after = await intentRow(h, s.tenantId, intent.id);
    expect(after).toMatchObject({ status: 'NEEDS_REVIEW', reviewReasons: ['HIGH_RISK'] });
    expect(after.lastCheckedAt).toEqual(clock.now());
    expect((await eventsOf(intent.id, 'QUERY')).length).toBe(3);
    expect(await paymentsOf(intent.id)).toEqual([]);
  });

  it('SSLCommerz down: the step fails with a code (BullMQ retries) and stays listed for the sweep', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    fake.override('query', { status: 503 });
    await expect(step(intent.id, 1)).rejects.toThrow(PaymentJobError);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'HTTP_STATUS',
    });
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 1))).not.toBeNull();
    // The validation API down after the query found it: also retried, nothing posted.
    fake.override('validate', { status: 502 });
    await expect(step(intent.id, 1)).rejects.toThrow(PaymentJobError);
    expect(await paymentsOf(intent.id)).toEqual([]);
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 1))).not.toBeNull();
    // Up again: posted, and the step is done.
    await step(intent.id, 1);
    expect((await intentRow(h, s.tenantId, intent.id)).status).toBe('PAID');
    expect(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 1))).toBeNull();
  });
});
