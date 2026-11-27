import { randomUUID } from 'node:crypto';
import { newTranId } from '@jantrik/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient, type TenantTx } from '../src/index.js';
import { appClient, createTenant, ownerClient, randomPhone } from './helpers.js';

// Online payments, part 3 (sprint 1 P7b, docs/payments.md → The review queue): a person's
// decision on an online payment in review (applied to dues, refunded outside the app, or
// dismissed), and the one final decision on money no intent holds or that came twice
// (payment_signal_reviews). Money is never dismissed (P7b-E); applied + refunded outside is the
// validated amount; only a person's decision moves an intent out of review (S23).

const PRICED_ON = new Date('2026-10-20');

async function school(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const payer = await findOrCreateUser(tx, randomPhone(), 'Guardian');
    await tx.membership.create({ data: { tenantId, userId: payer, role: 'GUARDIAN' } });
    const admin = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: admin, role: 'ADMIN' } });
    const account = await tx.paymentGatewayAccount.create({
      data: { tenantId, provider: 'SSLCOMMERZ' },
    });
    const head = await tx.feeHead.create({
      data: {
        tenantId,
        nameBn: 'বেতন',
        nameEn: 'Tuition',
        kind: 'TUITION',
        frequency: 'MONTHLY',
        dueDay: 10,
      },
    });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `R-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
    });
    const due = await tx.feeDue.create({
      data: {
        tenantId,
        studentId: student.id,
        feeHeadId: head.id,
        academicYearId: year.id,
        periodKey: '2026-09',
        periodStart: new Date('2026-09-01'),
        dueDate: new Date('2026-09-10'),
        amountPaisa: 100000,
        fineType: 'NONE',
        fineAmountPaisa: 0,
      },
    });
    return { tenantId, payer, admin, accountId: account.id, studentId: student.id, dueId: due.id };
  });
}
type School = Awaited<ReturnType<typeof school>>;

describe('review decisions on online payments (P7b)', () => {
  let app: PrismaClient;
  let a: School;
  let b: School;
  let receiptNo = 700000 + Math.floor(Math.random() * 100000);

  const newIntent = (s: School) =>
    withTenant(app, s.tenantId, async (tx) => {
      const intent = await tx.paymentIntent.create({
        data: {
          tenantId: s.tenantId,
          accountId: s.accountId,
          studentId: s.studentId,
          payerUserId: s.payer,
          amountPaisa: 100000,
          pricedOn: PRICED_ON,
          tranId: newTranId(),
          clientRequestId: randomUUID(),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await tx.paymentIntentDue.create({
        data: {
          tenantId: s.tenantId,
          intentId: intent.id,
          studentId: s.studentId,
          dueId: s.dueId,
          plannedPrincipalPaisa: 100000,
          plannedFinePaisa: 0,
        },
      });
      return intent;
    });

  const sql = (s: School, text: string) =>
    withTenant(app, s.tenantId, (tx) => tx.$executeRawUnsafe(text));
  const bankTranId = () => `BT${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  /** An intent waiting for review: with its validated money (`amount`), or without any. */
  const inReview = async (
    s: School,
    opts: { amount?: number | null; money?: boolean; reasons?: string } = {},
  ) => {
    const intent = await newIntent(s);
    const trx = bankTranId();
    const money =
      opts.money === false
        ? ''
        : `, val_id = 'VAL${randomUUID().slice(0, 8)}', bank_tran_id = '${trx}',
           instrument = 'BKASH-BKash', method = 'BKASH', validated_currency = 'BDT', risk = 'HIGH',
           validated_amount_paisa = ${opts.amount === undefined ? 100000 : (opts.amount ?? 'NULL')}`;
    await sql(
      s,
      `UPDATE payment_intents SET status = 'NEEDS_REVIEW', review_reasons = '${opts.reasons ?? '{HIGH_RISK}'}',
         review_since = now(), closed_at = now() ${money} WHERE id = '${intent.id}'`,
    );
    return { ...intent, trx };
  };

  const resolved = (s: School) =>
    `resolved_by_id = '${s.admin}', resolved_at = now(), resolution_note = 'checked with the bank'`;

  /** A gateway payment for the intent, in the caller's transaction. */
  const gatewayPayment = (
    tx: TenantTx,
    s: School,
    intent: { id: string },
    opts: { amount: number; trxId: string; paidOn?: Date },
  ) =>
    tx.feePayment.create({
      data: {
        tenantId: s.tenantId,
        studentId: s.studentId,
        receiptYear: 2026,
        receiptNo: receiptNo++,
        method: 'BKASH',
        channel: 'GATEWAY',
        amountPaisa: opts.amount,
        paidOn: opts.paidOn ?? PRICED_ON,
        recordedOn: new Date('2026-10-22'),
        trxId: opts.trxId,
        collectedById: s.admin,
        clientRequestId: randomUUID(),
        paymentIntentId: intent.id,
      },
    });

  /**
   * Apply `amount` of the intent's money to its due (the rest refunded outside), as P7b does. A
   * reference already on the row is kept unless another is given.
   */
  const apply = (
    s: School,
    intent: { id: string; trx: string },
    opts: {
      amount: number;
      refunded?: number | null;
      reference?: string;
      payment?: number;
      paidOn?: Date;
    },
  ) =>
    withTenant(app, s.tenantId, async (tx) => {
      const p = await gatewayPayment(tx, s, intent, {
        amount: opts.payment ?? opts.amount,
        trxId: intent.trx,
        paidOn: opts.paidOn ?? new Date('2026-10-21'),
      });
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'PAID', fee_payment_id = '${p.id}', ${resolved(s)},
           applied_paisa = ${opts.amount}, refunded_outside_paisa = ${opts.refunded ?? 'NULL'},
           refund_reference = ${opts.reference ? `'${opts.reference}'` : 'refund_reference'}
         WHERE id = '${intent.id}'`,
      );
      return p;
    });

  /** The void of an applied payment, as the fee module's void and its hook do it (P7a-G). */
  const voidApplied = (s: School, intentId: string, paymentId: string) =>
    withTenant(app, s.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE fee_payments SET status = 'VOID', voided_at = now(), voided_by_id = '${s.admin}', void_reason = 'wrong dues' WHERE id = '${paymentId}'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{HIGH_RISK,VOIDED}', review_since = now() WHERE id = '${intentId}'`,
      );
    });

  /** A VALIDATE event (money), with a review reason or none. */
  const validateEvent = (
    s: School,
    opts: { reason?: 'UNMATCHED' | 'DUPLICATE' | null; valId?: string; intentId?: string | null },
  ) =>
    withTenant(app, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: {
          tenantId: s.tenantId,
          intentId: opts.intentId ?? null,
          kind: 'VALIDATE',
          outcome: 'VALID',
          tranId: 'JSOTHER0001',
          valId: opts.valId ?? `VAL${randomUUID().slice(0, 8)}`,
          fields: { status: 'VALID', amount: '1000.00', bank_tran_id: 'BTXOTHER01' },
          reviewReason: opts.reason === undefined ? 'UNMATCHED' : opts.reason,
          receivedAt: new Date(),
        },
      }),
    );

  const signalReview = (s: School, eventId: string, over: Record<string, unknown> = {}) =>
    withTenant(app, s.tenantId, (tx) =>
      tx.paymentSignalReview.create({
        data: {
          tenantId: s.tenantId,
          eventId,
          outcome: 'REFUNDED_OUTSIDE',
          amountPaisa: 100000,
          note: 'given back by bKash',
          resolvedById: s.admin,
          resolvedAt: new Date(),
          ...over,
        },
      }),
    );

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('refunded outside: the whole validated amount, with a note, nothing applied', async () => {
    const set = async (data: string) => {
      const intent = await inReview(a);
      return sql(a, `UPDATE payment_intents SET ${data} WHERE id = '${intent.id}'`);
    };
    await expect(
      set(`status = 'REFUNDED_OUTSIDE', refunded_outside_paisa = 100000`),
    ).rejects.toThrow(/payment_intents_refunded_outside|only a person/i);
    await expect(
      set(
        `status = 'REFUNDED_OUTSIDE', resolved_by_id = '${a.admin}', resolved_at = now(), refunded_outside_paisa = 100000`,
      ),
    ).rejects.toThrow(/payment_intents_resolution/);
    await expect(
      set(`status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 99999`),
    ).rejects.toThrow(/payment_intents_refunded_outside/);
    await expect(
      set(
        `status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 100000, applied_paisa = 1`,
      ),
    ).rejects.toThrow(/payment_intents_refunded_outside|payment_intents_applied/);
    await expect(
      set(
        `status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 100000, refund_reference = 'ref with spaces'`,
      ),
    ).rejects.toThrow(/payment_intents_refund_reference/);
    await expect(
      set(
        `status = 'REFUNDED_OUTSIDE', resolved_by_id = '${a.admin}', resolved_at = now(), resolution_note = 'no', refunded_outside_paisa = 100000`,
      ),
    ).rejects.toThrow(/payment_intents_resolution/);
    await set(
      `status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 100000, refund_reference = 'BK-2026/11.27_01'`,
    );
    // Money whose amount was not well-formed (P7a2-x13) can still be refunded: no amount then.
    const unknown = await inReview(a, { amount: null });
    await sql(
      a,
      `UPDATE payment_intents SET status = 'REFUNDED_OUTSIDE', ${resolved(a)} WHERE id = '${unknown.id}'`,
    );
    // Nothing to refund without validated money.
    const none = await inReview(a, { money: false, reasons: '{TRAN_ID_MISMATCH}' });
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'REFUNDED_OUTSIDE', ${resolved(a)} WHERE id = '${none.id}'`,
      ),
    ).rejects.toThrow(/payment_intents_refunded_outside/);
  });

  it('money is never dismissed: only an intent without validated money, with a note', async () => {
    const withMoney = await inReview(a);
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'DISMISSED', ${resolved(a)} WHERE id = '${withMoney.id}'`,
      ),
    ).rejects.toThrow(/payment_intents_dismissed/);
    const unknownAmount = await inReview(a, { amount: null });
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'DISMISSED', ${resolved(a)} WHERE id = '${unknownAmount.id}'`,
      ),
    ).rejects.toThrow(/payment_intents_dismissed/);
    const none = await inReview(a, { money: false, reasons: '{TRAN_ID_MISMATCH}' });
    await expect(
      sql(a, `UPDATE payment_intents SET status = 'DISMISSED' WHERE id = '${none.id}'`),
    ).rejects.toThrow(/payment_intents_dismissed|only a person/i);
    await sql(
      a,
      `UPDATE payment_intents SET status = 'DISMISSED', ${resolved(a)} WHERE id = '${none.id}'`,
    );
  });

  it('applied: its payment holds the applied amount; applied + refunded outside = the validated amount', async () => {
    const intent = await inReview(a);
    await expect(apply(a, intent, { amount: 80000 })).rejects.toThrow(/payment_intents_applied/);
    await expect(apply(a, intent, { amount: 80000, refunded: 30000 })).rejects.toThrow(
      /payment_intents_applied/,
    );
    await expect(apply(a, intent, { amount: 0, refunded: 100000, payment: 1 })).rejects.toThrow(
      /payment_intents_applied/,
    );
    // The payment's amount is the applied amount (checked at commit).
    await expect(
      apply(a, intent, { amount: 80000, refunded: 20000, payment: 90000 }),
    ).rejects.toThrow(/applied amount|amount/i);
    await apply(a, intent, { amount: 80000, refunded: 20000 });
    const row = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }),
    );
    expect(row).toMatchObject({
      status: 'PAID',
      appliedPaisa: 80000,
      refundedOutsidePaisa: 20000,
      resolvedById: a.admin,
      resolutionNote: 'checked with the bank',
    });
    // The whole amount applied: no refund.
    const whole = await inReview(a);
    await apply(a, whole, { amount: 100000 });
  });

  it('a gateway payment matches its intent: amount, TrxID and day (applied: the applied amount)', async () => {
    // Posted automatically (settle): the intent's amount, its bank_tran_id, its checkout day.
    const post = (opts: { amount?: number; trxId?: string; paidOn?: Date }) =>
      withTenant(app, a.tenantId, async (tx) => {
        const intent = await tx.paymentIntent.create({
          data: {
            tenantId: a.tenantId,
            accountId: a.accountId,
            studentId: a.studentId,
            payerUserId: a.payer,
            amountPaisa: 100000,
            pricedOn: PRICED_ON,
            tranId: newTranId(),
            clientRequestId: randomUUID(),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        await tx.paymentIntentDue.create({
          data: {
            tenantId: a.tenantId,
            intentId: intent.id,
            studentId: a.studentId,
            dueId: a.dueId,
            plannedPrincipalPaisa: 100000,
            plannedFinePaisa: 0,
          },
        });
        const trx = bankTranId();
        const p = await gatewayPayment(tx, a, intent, {
          amount: opts.amount ?? 100000,
          trxId: opts.trxId ?? trx,
          paidOn: opts.paidOn ?? PRICED_ON,
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'PAID',
            feePaymentId: p.id,
            closedAt: new Date(),
            valId: `VAL${randomUUID().slice(0, 8)}`,
            bankTranId: trx,
            method: 'BKASH',
            validatedAmountPaisa: 100000,
            risk: 'LOW',
          },
        });
        return intent.id;
      });
    await expect(post({ amount: 99999 })).rejects.toThrow(/match its intent/i);
    await expect(post({ trxId: bankTranId() })).rejects.toThrow(/match its intent/i);
    await expect(post({ paidOn: new Date('2026-10-21') })).rejects.toThrow(/match its intent/i);
    const settled = await post({});
    // From the intent's side too: a PAID intent changed under its payment (here by the schema
    // owner, past the column grants) is refused at commit.
    const owner = ownerClient();
    try {
      for (const change of [`amount_paisa = 99999`, `priced_on = DATE '2026-10-21'`]) {
        await expect(
          withTenant(owner, a.tenantId, (tx) =>
            tx.$executeRawUnsafe(`UPDATE payment_intents SET ${change} WHERE id = '${settled}'`),
          ),
          change,
        ).rejects.toThrow(/match its intent/i);
      }
    } finally {
      await owner.$disconnect();
    }
    // Back in review only without its payment (a void); applied only with a new one.
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', review_reasons = '{VOIDED}', review_since = now() WHERE id = '${settled}'`,
      ),
    ).rejects.toThrow(/holds no payment|payment_intents_paid/i);
    // Applied from review: the applied amount, the intent's bank_tran_id, a day from the checkout
    // day to the day it was recorded.
    const early = await inReview(a);
    await expect(
      apply(a, early, { amount: 100000, paidOn: new Date('2026-10-19') }),
    ).rejects.toThrow(/match its intent/i);
    const late = await inReview(a);
    await expect(
      apply(a, late, { amount: 100000, paidOn: new Date('2026-10-23') }),
    ).rejects.toThrow(/match its intent|fee_payments_dates/i);
    const otherTrx = await inReview(a);
    await expect(apply(a, { ...otherTrx, trx: bankTranId() }, { amount: 100000 })).rejects.toThrow(
      /match its intent/i,
    );
  });

  it('only a person moves an intent out of review, and the decision is written only then', async () => {
    const intent = await inReview(a, { money: false, reasons: '{TRAN_ID_MISMATCH}' });
    // A decision's columns written while it stays in review (or anywhere else): refused.
    await expect(
      sql(a, `UPDATE payment_intents SET ${resolved(a)} WHERE id = '${intent.id}'`),
    ).rejects.toThrow(/only as it leaves review/i);
    const open = await newIntent(a);
    await expect(
      sql(a, `UPDATE payment_intents SET refund_reference = 'X1' WHERE id = '${open.id}'`),
    ).rejects.toThrow(/only as it leaves review/i);
    // Out of review without a decision: refused.
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'DISMISSED', resolution_note = 'abc' WHERE id = '${intent.id}'`,
      ),
    ).rejects.toThrow(/only a person|payment_intents_resolution/i);
    await sql(
      a,
      `UPDATE payment_intents SET status = 'DISMISSED', ${resolved(a)} WHERE id = '${intent.id}'`,
    );
    // A decided intent's decision never changes.
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET resolution_note = 'changed later' WHERE id = '${intent.id}'`,
      ),
    ).rejects.toThrow(/only as it leaves review/i);
    // The check columns may be written at any time.
    await sql(
      a,
      `UPDATE payment_intents SET last_checked_at = now(), last_check_outcome = 'NO_SUCCESS' WHERE id = '${intent.id}'`,
    );
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET last_check_outcome = 'no success' WHERE id = '${intent.id}'`,
      ),
    ).rejects.toThrow(/payment_intents_last_check/);
    await expect(
      sql(a, `UPDATE payment_intents SET last_checked_at = NULL WHERE id = '${intent.id}'`),
    ).rejects.toThrow(/payment_intents_last_check/);
  });

  it('back in review (a late success after a dismissal, a void after an apply): the decision is cleared', async () => {
    const dismissed = await inReview(a, { money: false, reasons: '{TRAN_ID_MISMATCH}' });
    await sql(
      a,
      `UPDATE payment_intents SET status = 'DISMISSED', ${resolved(a)} WHERE id = '${dismissed.id}'`,
    );
    await sql(
      a,
      `UPDATE payment_intents SET status = 'NEEDS_REVIEW', review_reasons = '{TRAN_ID_MISMATCH,LATE_SUCCESS}' WHERE id = '${dismissed.id}'`,
    );
    const again = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentIntent.findUniqueOrThrow({ where: { id: dismissed.id } }),
    );
    expect(again).toMatchObject({
      status: 'NEEDS_REVIEW',
      resolvedById: null,
      resolvedAt: null,
      resolutionNote: null,
    });

    const applied = await inReview(a);
    const payment = await apply(a, applied, { amount: 60000, refunded: 40000 });
    await voidApplied(a, applied.id, payment.id);
    // The applied part is cleared; the money already given back outside stays given back
    // (review round 1, finding 1: "refunded outside" is final, P7b-N).
    expect(
      await withTenant(app, a.tenantId, (tx) =>
        tx.paymentIntent.findUniqueOrThrow({ where: { id: applied.id } }),
      ),
    ).toMatchObject({
      status: 'NEEDS_REVIEW',
      appliedPaisa: null,
      refundedOutsidePaisa: 40000,
      resolvedAt: null,
      resolutionNote: null,
    });
    // Applied again: a new live payment, for the money still to decide.
    await apply(a, applied, { amount: 60000, refunded: 40000 });
  });

  it('a void after a partial apply keeps the refund: the money is never applied twice (review round 1, finding 1)', async () => {
    // ৳1 200 in review: ৳800 applied and ৳400 given back outside, then the payment is voided.
    const intent = await inReview(a, { amount: 120000 });
    const first = await apply(a, intent, { amount: 80000, refunded: 40000, reference: 'BK-RF-1' });
    await voidApplied(a, intent.id, first.id);
    expect(
      await withTenant(app, a.tenantId, (tx) =>
        tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ),
    ).toMatchObject({
      status: 'NEEDS_REVIEW',
      appliedPaisa: null,
      refundedOutsidePaisa: 40000,
      refundReference: 'BK-RF-1',
      resolvedAt: null,
    });
    // The whole ৳1 200 again, with or without the refund: refused (records of ৳1 600 for ৳1 200).
    await expect(apply(a, intent, { amount: 120000 })).rejects.toThrow(
      /payment_intents_applied|refunded outside/i,
    );
    await expect(apply(a, intent, { amount: 120000, refunded: 40000 })).rejects.toThrow(
      /payment_intents_applied|refunded outside/i,
    );
    // The refund never shrinks, not even with the amounts adding up.
    await expect(apply(a, intent, { amount: 100000, refunded: 20000 })).rejects.toThrow(
      /refunded outside/i,
    );
    // The ৳800 still to decide: applied again.
    await apply(a, intent, { amount: 80000, refunded: 40000 });

    // Or the rest refunded too: the whole validated amount is then refunded outside.
    const other = await inReview(a, { amount: 120000 });
    const p = await apply(a, other, { amount: 80000, refunded: 40000 });
    await voidApplied(a, other.id, p.id);
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 80000 WHERE id = '${other.id}'`,
      ),
    ).rejects.toThrow(/payment_intents_refunded_outside|refunded outside/i);
    await sql(
      a,
      `UPDATE payment_intents SET status = 'REFUNDED_OUTSIDE', ${resolved(a)}, refunded_outside_paisa = 120000 WHERE id = '${other.id}'`,
    );
  });

  it('payment_signal_reviews: one final decision per review event, of this institute only', async () => {
    const event = await validateEvent(a, {});
    await signalReview(a, event.id);
    await expect(signalReview(a, event.id)).rejects.toThrow(/unique/i);
    // Another institute's event: the composite key refuses it.
    const theirs = await validateEvent(b, {});
    await expect(signalReview(a, theirs.id)).rejects.toThrow(/foreign key|violates/i);
    // Each institute sees only its own decisions; no context sees none.
    await signalReview(b, theirs.id);
    const seen = await withTenant(app, a.tenantId, (tx) => tx.paymentSignalReview.findMany());
    expect(seen.map((r) => r.eventId)).toEqual([event.id]);
    expect(await app.paymentSignalReview.count()).toBe(0);
  });

  it('payment_signal_reviews: an event with a review reason only (checked at commit)', async () => {
    const plain = await validateEvent(a, { reason: null });
    await expect(signalReview(a, plain.id)).rejects.toThrow(/review reason/i);
    const query = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: { tenantId: a.tenantId, kind: 'QUERY', outcome: 'VALID', receivedAt: new Date() },
      }),
    );
    await expect(signalReview(a, query.id)).rejects.toThrow(/review reason/i);
  });

  it('payment_signal_reviews: the formats, and money dismissed only as a repeat record', async () => {
    const check = async (over: Record<string, unknown>, constraint: string) => {
      const event = await validateEvent(a, {});
      await expect(signalReview(a, event.id, over), JSON.stringify(over)).rejects.toThrow(
        new RegExp(constraint),
      );
    };
    await check({ outcome: 'APPLIED', amountPaisa: null }, 'payment_signal_reviews_outcome');
    await check({ note: 'ab' }, 'payment_signal_reviews_note');
    await check({ note: 'x'.repeat(501) }, 'payment_signal_reviews_note');
    await check({ amountPaisa: 0 }, 'payment_signal_reviews_amount');
    await check({ outcome: 'DISMISSED' }, 'payment_signal_reviews_amount');
    await check({ refundReference: 'has space' }, 'payment_signal_reviews_refund_reference');
    await check(
      { outcome: 'DISMISSED', amountPaisa: null, refundReference: 'R1' },
      'payment_signal_reviews_refund_reference',
    );
    // Refunded with an unknown amount (not a well-formed amount): allowed.
    await signalReview(a, (await validateEvent(a, {})).id, { amountPaisa: null });

    // The only record of some money cannot be dismissed (P7b-E).
    const only = await validateEvent(a, {});
    await expect(
      signalReview(a, only.id, { outcome: 'DISMISSED', amountPaisa: null }),
    ).rejects.toThrow(/money is never dismissed/i);
    // A second record of the same money (the same val_id): dismissed, while the first stands.
    const valId = `VAL${randomUUID().slice(0, 8)}`;
    const first = await validateEvent(a, { valId });
    const second = await validateEvent(a, { valId });
    await signalReview(a, second.id, { outcome: 'DISMISSED', amountPaisa: null });
    // The first can then not be dismissed too: it would leave the money nowhere.
    await expect(
      signalReview(a, first.id, { outcome: 'DISMISSED', amountPaisa: null }),
    ).rejects.toThrow(/money is never dismissed/i);
    await signalReview(a, first.id);
    // Money an intent holds: a repeat record of it may be dismissed.
    const held = await inReview(a);
    const heldRow = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentIntent.findUniqueOrThrow({ where: { id: held.id } }),
    );
    const repeat = await validateEvent(a, {
      valId: heldRow.valId!,
      intentId: held.id,
      reason: 'DUPLICATE',
    });
    await signalReview(a, repeat.id, { outcome: 'DISMISSED', amountPaisa: null });
  });

  it('two connections dismiss the two records of one payment at once: one wins, the money stays recorded', async () => {
    const valId = `VAL${randomUUID().slice(0, 8)}`;
    const events = [await validateEvent(a, { valId }), await validateEvent(a, { valId })];
    let inserted = 0;
    let checked = 0;
    let bothInserted!: () => void;
    let bothChecked!: () => void;
    const barrier = new Promise<void>((resolve) => (bothInserted = resolve));
    const checkedBarrier = new Promise<void>((resolve) => (bothChecked = resolve));
    // Each inserts its dismissal, waits for the other, has the commit-time check run now, and
    // waits (up to a second) for the other's check before committing: without a lock each sees
    // the other record still standing; with it, the second check waits for the first commit.
    const dismiss = (eventId: string) =>
      withTenant(app, a.tenantId, async (tx) => {
        await tx.paymentSignalReview.create({
          data: {
            tenantId: a.tenantId,
            eventId,
            outcome: 'DISMISSED',
            note: 'the same payment twice',
            resolvedById: a.admin,
            resolvedAt: new Date(),
          },
        });
        if (++inserted === 2) bothInserted();
        await barrier;
        await tx.$executeRawUnsafe(`SET CONSTRAINTS payment_signal_reviews_check IMMEDIATE`);
        if (++checked === 2) bothChecked();
        await Promise.race([checkedBarrier, new Promise((resolve) => setTimeout(resolve, 1000))]);
      });
    const results = await Promise.allSettled(events.map((e) => dismiss(e.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/money is never dismissed/i);
    const dismissed = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentSignalReview.count({
        where: { eventId: { in: events.map((e) => e.id) }, outcome: 'DISMISSED' },
      }),
    );
    expect(dismissed).toBe(1);
  });

  it('money is refunded outside once: never a second record of it, nor money an intent holds (review round 1, finding 2)', async () => {
    const valId = `VAL${randomUUID().slice(0, 8)}`;
    const first = await validateEvent(a, { valId });
    const second = await validateEvent(a, { valId, reason: 'DUPLICATE' });
    await signalReview(a, first.id);
    await expect(signalReview(a, second.id)).rejects.toThrow(/already refunded/i);
    // The second record is a repeat of the refunded one: dismissed.
    await signalReview(a, second.id, { outcome: 'DISMISSED', amountPaisa: null });
    // Money an intent holds is decided on the intent (applied or refunded there), never here.
    const held = await inReview(a);
    const heldRow = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentIntent.findUniqueOrThrow({ where: { id: held.id } }),
    );
    const repeat = await validateEvent(a, {
      valId: heldRow.valId!,
      intentId: held.id,
      reason: 'DUPLICATE',
    });
    await expect(signalReview(a, repeat.id)).rejects.toThrow(/payment's own/i);

    // Two connections refund the two records of one payment at once: one wins.
    const twice = `VAL${randomUUID().slice(0, 8)}`;
    const events = [
      await validateEvent(a, { valId: twice }),
      await validateEvent(a, { valId: twice }),
    ];
    let inserted = 0;
    let bothInserted!: () => void;
    const barrier = new Promise<void>((resolve) => (bothInserted = resolve));
    const refund = (eventId: string) =>
      withTenant(app, a.tenantId, async (tx) => {
        await tx.paymentSignalReview.create({
          data: {
            tenantId: a.tenantId,
            eventId,
            outcome: 'REFUNDED_OUTSIDE',
            amountPaisa: 100000,
            note: 'given back by bKash',
            resolvedById: a.admin,
            resolvedAt: new Date(),
          },
        });
        if (++inserted === 2) bothInserted();
        await barrier;
        await tx.$executeRawUnsafe(`SET CONSTRAINTS payment_signal_reviews_check IMMEDIATE`);
      });
    const results = await Promise.allSettled(events.map((e) => refund(e.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason),
    ).toMatch(/already refunded/i);
  });

  it('a live gateway payment is never detached from its intent (review round 1, finding 3; P1-J10)', async () => {
    // The reviewer's probe, as jantrik_app (an SQL injection inside the institute): an applied
    // intent moved back to review "voided" while its payment stays live, then refunded outside.
    const detach = (id: string) =>
      `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL,
         review_reasons = review_reasons || '{VOIDED}', review_since = now() WHERE id = '${id}'`;
    const intent = await inReview(a);
    const payment = await apply(a, intent, { amount: 100000 });
    await expect(sql(a, detach(intent.id))).rejects.toThrow(/live gateway payment|void it first/i);
    await expect(
      withTenant(app, a.tenantId, async (tx) => {
        await tx.$executeRawUnsafe(detach(intent.id));
        await tx.$executeRawUnsafe(
          `UPDATE payment_intents SET status = 'REFUNDED_OUTSIDE', ${resolved(a)},
             refunded_outside_paisa = 100000 WHERE id = '${intent.id}'`,
        );
      }),
    ).rejects.toThrow(/live gateway payment|void it first/i);
    expect(
      await withTenant(app, a.tenantId, (tx) =>
        tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ),
    ).toMatchObject({ status: 'PAID', feePaymentId: payment.id });
  });

  it('payment_signal_reviews and the decisions are history: no UPDATE, no DELETE', async () => {
    const event = await validateEvent(a, {});
    await signalReview(a, event.id);
    for (const statement of [
      `UPDATE payment_signal_reviews SET note = 'changed'`,
      `DELETE FROM payment_signal_reviews`,
      `UPDATE payment_intents SET tenant_id = tenant_id`,
    ]) {
      await expect(sql(a, statement), statement).rejects.toThrow(/permission denied/i);
    }
  });
});
