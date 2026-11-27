import { getQueueToken } from '@nestjs/bullmq';
import { withTenant } from '@jantrik/db';
import type { Queue } from 'bullmq';
import { ConfirmService } from '../src/payments/confirm.service.js';
import {
  PAYMENTS_OPEN_KEY,
  PAYMENTS_QUEUE,
  RECONCILE_JOB,
  RECONCILE_DELAYS_MS,
  reconcileJobId,
  type ReconcileStep,
} from '../src/payments/payments.constants.js';
import { PaymentJobError } from '../src/payments/confirm.service.js';
import { ReconcileService } from '../src/payments/reconcile.service.js';
import { FeeDuesProcessor } from '../src/fees/dues/fee-dues.processor.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
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
  waitStatus,
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
  // ─────────────────────────── Healing (Task 3, P7b-B) ───────────────────────────

  /** Forget an intent's scheduled steps in Redis (the jobs). */
  const loseJobs = async (intentId: string) => {
    for (const n of [1, 2, 3, 4, 5, 'manual'] as const) {
      await (await queue.getJob(reconcileJobId(intentId, n)))?.remove();
    }
  };
  const members = async () => h.redis.zrange(PAYMENTS_OPEN_KEY, 0, -1);

  it('the jobs lost from Redis: the sweep adds the overdue steps again; the payment is posted once', async () => {
    await h.redis.del(PAYMENTS_OPEN_KEY);
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    await loseJobs(intent.id);
    // Not overdue yet (due at +5 min, swept 2 minutes after that): nothing.
    clock.advance(6 * MINUTE);
    await reconcile.sweep();
    expect(await queue.getJob(reconcileJobId(intent.id, 1))).toBeUndefined();
    clock.advance(2 * MINUTE);
    await reconcile.sweep();
    await waitStatus(h, s.tenantId, intent.id, 'PAID');
    expect(await paymentsOf(intent.id)).toHaveLength(1);
    // Only the overdue step: the others keep their places in the list, with no job yet.
    expect(await queue.getJob(reconcileJobId(intent.id, 2))).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await members()).toEqual([
        member(intent.id, 2),
        member(intent.id, 3),
        member(intent.id, 4),
      ]),
    );
    // A second sweep after the step is done adds nothing.
    await reconcile.sweep();
    expect(await queue.getJob(reconcileJobId(intent.id, 1))).toBeUndefined();
    expect(await paymentsOf(intent.id)).toHaveLength(1);
    // A step listed more than 8 days ago is dropped (the last, +25 h, as well 10 days on).
    clock.advance(10 * 24 * HOUR);
    await reconcile.sweep();
    await loseJobs(intent.id);
    expect(await members()).toEqual([]);
  });

  it("payments:open itself lost: the nightly run lists each institute's open payments again, in its own context", async () => {
    const other = await onlineSchool(h, fake);
    const otherDue = await extraDue(h, other, other.students[0]!.id, {
      amountPaisa: 50000,
      dueDate: other.today,
    });
    const theirs = await startPayment(h, other.tokens.guardian, other.students[0]!.id, {
      dueIds: [otherDue.id],
      expected: 50000,
    });
    const open = (await readyPayment()).intent;
    await h.redis.del(PAYMENTS_OPEN_KEY);
    for (const id of [open.id, theirs.id]) await loseJobs(id);
    clock.advance(3 * HOUR);
    const created = open.createdAt.getTime();

    // One institute, as the nightly run visits it: only its own payments, the latest step due
    // now and the later ones at their times.
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).filter((m) => m.includes(open.id))).toEqual([
      member(open.id, 3),
      member(open.id, 4),
    ]);
    expect(Number(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(open.id, 4)))).toBe(
      created + 25 * HOUR,
    );
    expect((await members()).some((m) => m.includes(theirs.id))).toBe(false);
    await vi.waitFor(async () =>
      expect((await intentRow(h, s.tenantId, open.id)).lastCheckedAt).toEqual(clock.now()),
    );

    // The nightly fee run does it for every institute it visits.
    await h.redis.del(PAYMENTS_OPEN_KEY);
    await loseJobs(open.id);
    await h.app.get(FeeDuesProcessor).generateAll();
    expect(await members()).toEqual(
      expect.arrayContaining([member(open.id, 4), `${other.tenantId}:${theirs.id}:4`]),
    );
    await loseJobs(open.id);
    await loseJobs(theirs.id);
  });

  it('a posted payment is listed again for +25 h; one PENDING at +25 h for +7 days; a young one not at all', async () => {
    const paid = (await readyPayment()).intent;
    await payAtGateway(h, fake, s.tenantId, paid.id);
    await step(paid.id, 1);
    await h.redis.del(PAYMENTS_OPEN_KEY);
    await loseJobs(paid.id);
    clock.advance(3 * HOUR);
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).filter((m) => m.includes(paid.id))).toEqual([member(paid.id, 4)]);

    clock.set(new Date());
    const pending = (await readyPayment()).intent;
    await payAtGateway(h, fake, s.tenantId, pending.id, { status: 'PENDING' });
    clock.advance(25 * HOUR);
    await step(pending.id, 4);
    expect((await intentRow(h, s.tenantId, pending.id)).status).toBe('EXPIRED');
    await h.redis.del(PAYMENTS_OPEN_KEY);
    await loseJobs(pending.id);
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).filter((m) => m.includes(pending.id))).toEqual([
      member(pending.id, 5),
    ]);

    // Younger than an hour: its own jobs still stand; nothing listed again.
    clock.set(new Date());
    const young = (await readyPayment()).intent;
    await h.redis.del(PAYMENTS_OPEN_KEY);
    clock.advance(30 * MINUTE);
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).some((m) => m.includes(young.id))).toBe(false);
  });

  it('an open payment whose latest step already ran is not listed again (no query every night)', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    // SSLCommerz lists a success its validation API does not confirm: nothing to post, nothing to
    // close (never when in doubt); the +25 h step ran.
    fake.override('validate', { json: { status: 'INVALID_TRANSACTION' } });
    clock.advance(25 * HOUR);
    await step(intent.id, 4);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'SUCCESS_FOUND',
    });
    await h.redis.del(PAYMENTS_OPEN_KEY);
    await loseJobs(intent.id);
    clock.advance(HOUR);
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).some((m) => m.includes(intent.id))).toBe(false);
    // Staff can still ask about it ("check now").
    await api(h, s.tokens.guardian).post(
      `/me/children/${child().id}/fees/online-payments/${intent.id}/abandon`,
    );
  });

  it('heal on read (the review page): an open payment overdue by 10 minutes is asked about, once a minute per institute', async () => {
    const { intent } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    await loseJobs(intent.id);
    const budget = `rl:pay-review-heal:${s.tenantId}`;
    await h.redis.del(budget);
    const heal = () => h.app.get(TenantJobRunner).run(s.tenantId, () => reconcile.healOverdue());
    // Step 1 is due at +5 min: not overdue by 10 minutes yet.
    clock.advance(14 * MINUTE);
    await heal();
    expect(await queue.getJob(reconcileJobId(intent.id, 1))).toBeUndefined();
    await h.redis.del(budget);
    clock.advance(2 * MINUTE);
    const add = vi.spyOn(queue, 'add');
    try {
      await heal();
      await waitStatus(h, s.tenantId, intent.id, 'PAID');
      expect(add.mock.calls.filter((c) => c[0] === RECONCILE_JOB)).toHaveLength(1);
      // Within the minute: nothing more, whatever is overdue.
      const later = (await readyPayment()).intent;
      await loseJobs(later.id);
      clock.advance(20 * MINUTE);
      const before = add.mock.calls.length;
      await heal();
      expect(add.mock.calls.length).toBe(before);
    } finally {
      add.mockRestore();
    }
  });

  it("heal on read (the guardian's page, P7a) still asks about a payment whose signals were lost", async () => {
    const { intent, view } = await readyPayment();
    await payAtGateway(h, fake, s.tenantId, intent.id);
    await loseJobs(intent.id);
    clock.advance(2 * MINUTE);
    await api(h, s.tokens.guardian)
      .get(`/me/children/${child().id}/fees/online-payments/${view.id}`)
      .expect(200);
    await waitStatus(h, s.tenantId, intent.id, 'PAID');
    expect(await paymentsOf(intent.id)).toHaveLength(1);
  });

  it('an undocumented status is unknown, never "no success": nothing closed on it, asked again at +7 days (review round 1, hardening d)', async () => {
    const { intent } = await readyPayment();
    // A status SSLCommerz does not document (the client reads it as OTHER).
    await payAtGateway(h, fake, s.tenantId, intent.id, { status: 'PROCESSING' });
    clock.advance(2 * HOUR);
    await step(intent.id, 3);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'REDIRECTED',
      lastCheckOutcome: 'UNKNOWN',
    });
    clock.advance(23 * HOUR);
    await step(intent.id, 4);
    expect(await intentRow(h, s.tenantId, intent.id)).toMatchObject({
      status: 'EXPIRED',
      lastCheckOutcome: 'UNKNOWN',
    });
    // As a PENDING one: once more at +7 days, listed again by the nightly run after a loss.
    const last = intent.createdAt.getTime() + 7 * 24 * HOUR;
    expect(Number(await h.redis.zscore(PAYMENTS_OPEN_KEY, member(intent.id, 5)))).toBe(last);
    await h.redis.del(PAYMENTS_OPEN_KEY);
    await loseJobs(intent.id);
    await reconcile.requeueTenant(s.tenantId);
    expect((await members()).filter((m) => m.includes(intent.id))).toEqual([member(intent.id, 5)]);
    await loseJobs(intent.id);
  });
});
