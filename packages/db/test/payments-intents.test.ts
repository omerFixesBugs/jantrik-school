import { randomUUID } from 'node:crypto';
import { newTranId } from '@jantrik/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient, type TenantTx } from '../src/index.js';
import { appClient, createTenant, ownerClient, randomPhone } from './helpers.js';

// Online payments, part 2 (sprint 1 P7a2, docs/payments.md → Database): payment intents (one per
// attempt), the dues each pays with what they owed (the snapshot), the append-only gateway
// events, and a gateway payment tied to exactly one live intent (S22, S23).

const PRICED_ON = new Date('2026-10-20');
const BANK_TRAN_SAMPLE = '1709162025350IvUOK8nCTb6Uan';

async function school(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const payer = await findOrCreateUser(tx, randomPhone(), 'Guardian');
    await tx.membership.create({ data: { tenantId, userId: payer, role: 'GUARDIAN' } });
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
    const students = await Promise.all(
      ['1', '2'].map((n) =>
        tx.student.create({
          data: { tenantId, studentCode: `G${n}-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
        }),
      ),
    );
    const due = (studentId: string, month: string) =>
      tx.feeDue.create({
        data: {
          tenantId,
          studentId,
          feeHeadId: head.id,
          academicYearId: year.id,
          periodKey: `2026-${month}`,
          periodStart: new Date(`2026-${month}-01`),
          dueDate: new Date(`2026-${month}-10`),
          amountPaisa: 100000,
          fineType: 'NONE',
          fineAmountPaisa: 0,
        },
      });
    const dues = [
      [await due(students[0]!.id, '09'), await due(students[0]!.id, '10')],
      [await due(students[1]!.id, '09')],
    ];
    return {
      tenantId,
      payer,
      accountId: account.id,
      studentIds: students.map((s) => s.id),
      dueIds: dues.map((list) => list.map((d) => d.id)),
    };
  });
}
type School = Awaited<ReturnType<typeof school>>;

describe('payment intents, their dues, gateway events and gateway payments', () => {
  let app: PrismaClient;
  let a: School;
  let b: School;
  let receiptNo = 500000 + Math.floor(Math.random() * 100000);

  const intentData = (s: School, over: Record<string, unknown> = {}) => ({
    tenantId: s.tenantId,
    accountId: s.accountId,
    studentId: s.studentIds[0]!,
    payerUserId: s.payer,
    amountPaisa: 100000,
    pricedOn: PRICED_ON,
    tranId: newTranId(),
    clientRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000),
    ...over,
  });

  /** A new intent for the first student's September due, its snapshot in the same transaction. */
  const newIntent = (
    s: School,
    over: Record<string, unknown> = {},
    dues: { dueId: string; principal: number; fine: number }[] = [
      { dueId: s.dueIds[0]![0]!, principal: 100000, fine: 0 },
    ],
  ) =>
    withTenant(app, s.tenantId, async (tx) => {
      const intent = await tx.paymentIntent.create({ data: intentData(s, over) });
      await tx.paymentIntentDue.createMany({
        data: dues.map((d) => ({
          tenantId: s.tenantId,
          intentId: intent.id,
          studentId: intent.studentId,
          dueId: d.dueId,
          plannedPrincipalPaisa: d.principal,
          plannedFinePaisa: d.fine,
        })),
      });
      return intent;
    });

  const sql = (s: School, text: string) =>
    withTenant(app, s.tenantId, (tx) => tx.$executeRawUnsafe(text));

  const gatewayPayment = (
    tx: TenantTx,
    s: School,
    intent: { id: string; studentId: string; amountPaisa: number },
    over: Record<string, unknown> = {},
  ) =>
    tx.feePayment.create({
      data: {
        tenantId: s.tenantId,
        studentId: intent.studentId,
        receiptYear: 2026,
        receiptNo: receiptNo++,
        method: 'BKASH',
        channel: 'GATEWAY',
        amountPaisa: intent.amountPaisa,
        paidOn: PRICED_ON,
        recordedOn: PRICED_ON,
        trxId: `BT${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        collectedById: s.payer,
        clientRequestId: randomUUID(),
        paymentIntentId: intent.id,
        ...over,
      },
    });

  /** The intent's validated money, as settle records it. */
  const facts = (trxId: string, amount = 100000) => ({
    valId: `VAL${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    bankTranId: trxId,
    instrument: 'BKASH-BKash',
    method: 'BKASH' as const,
    validatedAmountPaisa: amount,
    storeAmountPaisa: amount - 2500,
    validatedCurrency: 'BDT',
    risk: 'LOW',
  });

  /** Post a gateway payment for the intent and mark it PAID, in one transaction. */
  const pay = (s: School, intent: { id: string; studentId: string; amountPaisa: number }) =>
    withTenant(app, s.tenantId, async (tx) => {
      const payment = await gatewayPayment(tx, s, intent);
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'PAID',
          feePaymentId: payment.id,
          closedAt: new Date(),
          ...facts(payment.trxId!, intent.amountPaisa),
        },
      });
      return payment;
    });

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('the gateway channel and the online methods exist (S21)', async () => {
    const owner = ownerClient();
    try {
      const rows = await owner.$queryRaw<{ type: string; values: string[] }[]>`
        SELECT t.typname::text AS type,
               array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('fee_payment_channel', 'fee_payment_method', 'payment_intent_status',
                            'payment_review_reason', 'payment_event_kind')
        GROUP BY 1 ORDER BY 1`;
      expect(rows).toEqual([
        { type: 'fee_payment_channel', values: ['COUNTER', 'MOBILE_MANUAL', 'GATEWAY'] },
        {
          type: 'fee_payment_method',
          values: ['CASH', 'BKASH', 'NAGAD', 'ROCKET', 'CARD', 'OTHER_ONLINE'],
        },
        { type: 'payment_event_kind', values: ['INIT', 'RETURN', 'IPN', 'VALIDATE', 'QUERY'] },
        {
          type: 'payment_intent_status',
          values: [
            'CREATED',
            'REDIRECTED',
            'PAID',
            'FAILED',
            'CANCELLED',
            'EXPIRED',
            'NEEDS_REVIEW',
            'REFUNDED_OUTSIDE',
            'DISMISSED',
          ],
        },
        {
          type: 'payment_review_reason',
          values: [
            'AMOUNT_MISMATCH',
            'CURRENCY_MISMATCH',
            'TRAN_ID_MISMATCH',
            'HIGH_RISK',
            'DUES_CHANGED',
            'LATE_SUCCESS',
            'DUPLICATE',
            'UNMATCHED',
            'VOIDED',
          ],
        },
      ]);
    } finally {
      await owner.$disconnect();
    }
  });

  it('each institute sees only its own intents, dues and events; no context sees none', async () => {
    const intent = await newIntent(a);
    await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayEvent.create({
        data: {
          tenantId: a.tenantId,
          intentId: intent.id,
          kind: 'INIT',
          outcome: 'OK',
          tranId: intent.tranId,
          receivedAt: new Date(),
        },
      }),
    );
    await newIntent(b);
    for (const model of ['paymentIntent', 'paymentIntentDue', 'paymentGatewayEvent'] as const) {
      const rows = (await withTenant(app, b.tenantId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx[model] as any).findMany({ select: { tenantId: true } }),
      )) as { tenantId: string }[];
      expect(
        rows.every((r) => r.tenantId === b.tenantId),
        model,
      ).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (app[model] as any).count(), model).toBe(0);
    }
    // B cannot write a row for A, nor point at A's intent.
    await expect(
      withTenant(app, b.tenantId, (tx) => tx.paymentIntent.create({ data: intentData(a) })),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.paymentGatewayEvent.create({
          data: { tenantId: b.tenantId, intentId: intent.id, kind: 'INIT', receivedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("an intent pays its own child's dues only, and of its own institute", async () => {
    // The second student's due on the first student's intent.
    await expect(
      newIntent(a, {}, [{ dueId: a.dueIds[1]![0]!, principal: 100000, fine: 0 }]),
    ).rejects.toThrow(/foreign key/i);
    // Another institute's due.
    await expect(
      newIntent(a, {}, [{ dueId: b.dueIds[0]![0]!, principal: 100000, fine: 0 }]),
    ).rejects.toThrow(/foreign key/i);
    // Another institute's account.
    await expect(newIntent(a, { accountId: b.accountId })).rejects.toThrow(/foreign key/i);
  });

  it("an intent's dues add up to its amount, checked at commit", async () => {
    await expect(
      newIntent(a, { amountPaisa: 150000 }, [
        { dueId: a.dueIds[0]![0]!, principal: 100000, fine: 0 },
      ]),
    ).rejects.toThrow(/add up to its amount/i);
    // An intent with no dues at all.
    await expect(newIntent(a, {}, [])).rejects.toThrow(/add up to its amount/i);
    // Two dues with a fine add up.
    const ok = await newIntent(a, { amountPaisa: 205000 }, [
      { dueId: a.dueIds[0]![0]!, principal: 100000, fine: 5000 },
      { dueId: a.dueIds[0]![1]!, principal: 100000, fine: 0 },
    ]);
    expect(ok.status).toBe('CREATED');
    // A due added later breaks the sum: refused.
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.paymentIntentDue.create({
          data: {
            tenantId: a.tenantId,
            intentId: ok.id,
            studentId: ok.studentId,
            dueId: a.dueIds[0]![0]!,
            plannedPrincipalPaisa: 1,
            plannedFinePaisa: 0,
          },
        }),
      ),
    ).rejects.toThrow(/unique|add up/i);
    await expect(
      newIntent(a, { amountPaisa: 1000 }, [{ dueId: a.dueIds[0]![0]!, principal: 0, fine: 0 }]),
    ).rejects.toThrow(/payment_intent_dues_amounts/);
  });

  it('the stored formats: amount, currency, our tran_id, the request id once', async () => {
    for (const [over, constraint] of [
      [{ amountPaisa: 999 }, 'payment_intents_amount'],
      [{ amountPaisa: 50_000_001 }, 'payment_intents_amount'],
      [{ currency: 'USD' }, 'payment_intents_currency'],
      [{ tranId: 'TX123' }, 'payment_intents_tran_id'],
      [{ tranId: `JS${'I'.repeat(26)}` }, 'payment_intents_tran_id'],
      [{ expiresAt: new Date('2020-01-01') }, 'payment_intents_expires'],
    ] as const) {
      await expect(newIntent(a, over), JSON.stringify(over)).rejects.toThrow(
        new RegExp(constraint),
      );
    }
    // Created empty: no state, money or payment from the start.
    for (const over of [
      { status: 'PAID' },
      { status: 'REDIRECTED', sessionRef: 'S', checkoutUrl: 'https://sandbox.sslcommerz.com/x' },
      { valId: 'VAL1' },
      { reviewReasons: ['HIGH_RISK'] },
    ]) {
      await expect(newIntent(a, over), JSON.stringify(over)).rejects.toThrow(/created empty/i);
    }
    const first = await newIntent(a);
    await expect(newIntent(a, { clientRequestId: first.clientRequestId })).rejects.toThrow(
      /unique/i,
    );
    await expect(newIntent(a, { tranId: first.tranId })).rejects.toThrow(/unique/i);
  });

  it('PAID needs a payment, NEEDS_REVIEW a reason, REDIRECTED the session; closed with a time', async () => {
    const intent = await newIntent(a);
    const set = (data: string) =>
      sql(a, `UPDATE payment_intents SET ${data} WHERE id = '${intent.id}'`);
    await expect(set(`status = 'REDIRECTED'`)).rejects.toThrow(/payment_intents_redirected/);
    await expect(
      set(`status = 'REDIRECTED', session_ref = 'S1', checkout_url = 'http://evil.example/x'`),
    ).rejects.toThrow(/payment_intents_checkout_url/);
    await set(
      `status = 'REDIRECTED', session_ref = 'S1', checkout_url = 'https://sandbox.sslcommerz.com/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=S1'`,
    );
    await expect(set(`status = 'NEEDS_REVIEW', closed_at = now()`)).rejects.toThrow(
      /payment_intents_review/,
    );
    await expect(
      set(`status = 'NEEDS_REVIEW', review_reasons = '{HIGH_RISK}', review_since = now()`),
    ).rejects.toThrow(/payment_intents_closed/);
    await expect(set(`status = 'PAID', closed_at = now()`)).rejects.toThrow(/payment_intents_paid/);
    // Money facts never come without the validation ID they were validated under.
    await expect(set(`validated_amount_paisa = 100000`)).rejects.toThrow(
      /payment_intents_facts_with_val_id/,
    );
    await expect(set(`val_id = 'VAL1', risk = 'MEDIUM'`)).rejects.toThrow(
      /payment_intents_facts_format/,
    );
    await expect(
      set(`val_id = 'VAL1', validated_amount_paisa = 100, store_amount_paisa = 200`),
    ).rejects.toThrow(/payment_intents_facts_format/);
    await set(
      `status = 'NEEDS_REVIEW', review_reasons = '{HIGH_RISK}', review_since = now(), closed_at = now()`,
    );
  });

  it('the state moves only along the table (docs/payments.md → States)', async () => {
    const expectMove = async (from: 'CREATED' | 'PAID', sqlSet: string, ok: boolean) => {
      const intent = await newIntent(a);
      if (from === 'PAID') await pay(a, intent);
      const run = sql(a, `UPDATE payment_intents SET ${sqlSet} WHERE id = '${intent.id}'`);
      if (ok) await run;
      else await expect(run, sqlSet).rejects.toThrow(/cannot move/i);
    };
    await expectMove('CREATED', `status = 'REFUNDED_OUTSIDE', closed_at = now()`, false);
    await expectMove('CREATED', `status = 'DISMISSED', closed_at = now()`, false);
    await expectMove('CREATED', `status = 'CANCELLED', closed_at = now()`, true);
    await expectMove('PAID', `status = 'FAILED'`, false);
    await expectMove('PAID', `status = 'CANCELLED'`, false);
    // A failed or cancelled one may only go to review (a late success).
    const late = await newIntent(a);
    await sql(
      a,
      `UPDATE payment_intents SET status = 'FAILED', closed_at = now() WHERE id = '${late.id}'`,
    );
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'REDIRECTED', closed_at = NULL, session_ref = 'S', checkout_url = 'https://sandbox.sslcommerz.com/x' WHERE id = '${late.id}'`,
      ),
    ).rejects.toThrow(/cannot move/i);
    await sql(
      a,
      `UPDATE payment_intents SET status = 'NEEDS_REVIEW', review_reasons = '{LATE_SUCCESS}', review_since = now() WHERE id = '${late.id}'`,
    );
  });

  it('the money an intent stands for is written once and never changes', async () => {
    const intent = await newIntent(a);
    const set = (data: string) =>
      sql(a, `UPDATE payment_intents SET ${data} WHERE id = '${intent.id}'`);
    await set(`val_id = 'VAL1', validated_amount_paisa = 100000, bank_tran_id = 'BTX123456'`);
    for (const change of [
      `val_id = 'VAL2'`,
      `val_id = NULL`,
      `validated_amount_paisa = 99999`,
      `bank_tran_id = 'BTX999999'`,
      // A fact still empty cannot be filled in later either.
      `risk = 'LOW'`,
      `method = 'BKASH'`,
    ]) {
      await expect(set(change), change).rejects.toThrow(/never changes/i);
    }
  });

  it('a payment is set only as the intent becomes PAID, and cleared only by a void', async () => {
    const intent = await newIntent(a);
    const payment = await pay(a, intent);
    // Cleared without VOIDED (or with another reason): refused.
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{DUPLICATE}', review_since = now() WHERE id = '${intent.id}'`,
      ),
    ).rejects.toThrow(/only when it was voided/i);
    // A void moves the intent to review with VOIDED, in the same transaction.
    await withTenant(app, a.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE fee_payments SET status = 'VOID', voided_at = now(), voided_by_id = '${a.payer}', void_reason = 'paid twice' WHERE id = '${payment.id}'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{VOIDED}', review_since = now() WHERE id = '${intent.id}'`,
      );
    });
    // A payment is never set on an intent that does not become PAID with it.
    const other = await newIntent(a);
    await expect(
      withTenant(app, a.tenantId, async (tx) => {
        const p = await gatewayPayment(tx, a, other);
        await tx.$executeRawUnsafe(
          `UPDATE payment_intents SET fee_payment_id = '${p.id}' WHERE id = '${other.id}'`,
        );
      }),
    ).rejects.toThrow(/only as it becomes PAID|payment_intents_paid/i);
  });

  it('at commit: a PAID intent holds its own live gateway payment, and the other way round', async () => {
    // A gateway payment whose intent is not PAID with it.
    const open = await newIntent(a);
    await expect(withTenant(app, a.tenantId, (tx) => gatewayPayment(tx, a, open))).rejects.toThrow(
      /needs its intent PAID/i,
    );
    // A voided gateway payment its intent still holds.
    const paid = await newIntent(a);
    const payment = await pay(a, paid);
    await expect(
      sql(
        a,
        `UPDATE fee_payments SET status = 'VOID', voided_at = now(), voided_by_id = '${a.payer}', void_reason = 'paid twice' WHERE id = '${payment.id}'`,
      ),
    ).rejects.toThrow(/cannot stay on its intent/i);
    // A PAID intent holding a counter payment, or a gateway payment of another intent.
    const third = await newIntent(a);
    await expect(
      withTenant(app, a.tenantId, async (tx) => {
        const cash = await tx.feePayment.create({
          data: {
            tenantId: a.tenantId,
            studentId: third.studentId,
            receiptYear: 2026,
            receiptNo: receiptNo++,
            method: 'CASH',
            channel: 'COUNTER',
            amountPaisa: 100000,
            paidOn: PRICED_ON,
            recordedOn: PRICED_ON,
            collectedById: a.payer,
            clientRequestId: randomUUID(),
          },
        });
        await tx.paymentIntent.update({
          where: { id: third.id },
          data: {
            status: 'PAID',
            feePaymentId: cash.id,
            closedAt: new Date(),
            ...facts('BTX0001'),
          },
        });
      }),
    ).rejects.toThrow(/own live gateway payment/i);
  });

  it('at commit: an intent never lets go of a live gateway payment that names it (P7a2-x25)', async () => {
    const intent = await newIntent(a);
    const payment = await pay(a, intent);
    // The review's probe: the intent sent to review as if voided, its payment left ACTIVE.
    await expect(
      sql(
        a,
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{VOIDED}', review_since = now() WHERE id = '${intent.id}'`,
      ),
    ).rejects.toThrow(/live gateway payment keeps its intent PAID/i);
    const row = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }),
    );
    expect(row).toMatchObject({ status: 'PAID', feePaymentId: payment.id });
    // The void itself, in the same transaction: allowed (P7a-G).
    await withTenant(app, a.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE fee_payments SET status = 'VOID', voided_at = now(), voided_by_id = '${a.payer}', void_reason = 'paid twice' WHERE id = '${payment.id}'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{VOIDED}', review_since = now() WHERE id = '${intent.id}'`,
      );
    });
  });

  it("at commit: a gateway payment is its intent's money: the amount, the bank's transaction ID, the checkout day (P7a2-x28)", async () => {
    /** A gateway payment (with `over`) and its intent PAID with it, the intent's facts as settle writes them. */
    const payWith = (intent: { id: string; studentId: string; amountPaisa: number }, over = {}) =>
      withTenant(app, a.tenantId, async (tx) => {
        const trx = `BT${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const payment = await gatewayPayment(tx, a, intent, { trxId: trx, ...over });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'PAID',
            feePaymentId: payment.id,
            closedAt: new Date(),
            ...facts(trx, intent.amountPaisa),
          },
        });
      });
    for (const over of [
      // The review's probe: ৳0.01 for a ৳1,000 intent.
      { amountPaisa: 1 },
      { amountPaisa: 100001 },
      { trxId: 'BTXSOMEOTHER0001' },
      { paidOn: new Date('2026-10-19') },
    ]) {
      const intent = await newIntent(a);
      await expect(payWith(intent, over), JSON.stringify(over)).rejects.toThrow(
        /must be its intent's money/i,
      );
    }
    await payWith(await newIntent(a));
  });

  it('fee_payments: a gateway payment has a gateway method, a TrxID, no sender, and an intent', async () => {
    const intent = await newIntent(a);
    const tryPayment = (over: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) => gatewayPayment(tx, a, intent, over));
    await expect(tryPayment({ paymentIntentId: null })).rejects.toThrow(/fee_payments_channel/);
    await expect(tryPayment({ senderPhone: '+8801711000001' })).rejects.toThrow(
      /fee_payments_channel/,
    );
    await expect(tryPayment({ method: 'CASH' })).rejects.toThrow(/fee_payments_channel/);
    await expect(tryPayment({ trxId: null })).rejects.toThrow(/fee_payments_channel/);
    await expect(tryPayment({ trxId: 'abc' })).rejects.toThrow(/fee_payments_trx_id/);
    // The counter's and a manual transfer's never name an intent.
    for (const over of [
      { channel: 'COUNTER', method: 'CASH', trxId: null },
      {
        channel: 'MOBILE_MANUAL',
        method: 'BKASH',
        trxId: 'BFH7KJ2L9Q',
        senderPhone: '+8801711000001',
      },
    ]) {
      await expect(tryPayment(over), JSON.stringify(over)).rejects.toThrow(/fee_payments_channel/);
    }
    // SSLCommerz's bank_tran_id: accepted for the gateway, still refused for a manual transfer.
    await expect(
      tryPayment({
        channel: 'MOBILE_MANUAL',
        method: 'BKASH',
        trxId: BANK_TRAN_SAMPLE,
        senderPhone: '+8801711000001',
        paymentIntentId: null,
      }),
    ).rejects.toThrow(/fee_payments_trx_id/);
    await withTenant(app, a.tenantId, async (tx) => {
      const p = await gatewayPayment(tx, a, intent, { trxId: BANK_TRAN_SAMPLE });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'PAID',
          feePaymentId: p.id,
          closedAt: new Date(),
          ...facts(BANK_TRAN_SAMPLE),
        },
      });
    });
    // The same bank_tran_id on another live payment of that method: refused.
    const second = await newIntent(a);
    await expect(
      withTenant(app, a.tenantId, async (tx) => {
        const p = await gatewayPayment(tx, a, second, { trxId: BANK_TRAN_SAMPLE });
        await tx.paymentIntent.update({
          where: { id: second.id },
          data: {
            status: 'PAID',
            feePaymentId: p.id,
            closedAt: new Date(),
            ...facts(BANK_TRAN_SAMPLE),
          },
        });
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('one live payment per intent; a voided one makes room for another (P7a-G)', async () => {
    const intent = await newIntent(a);
    const first = await pay(a, intent);
    // A second live payment for the same intent, even with the intent's own lock bypassed.
    await expect(
      withTenant(app, a.tenantId, (tx) => gatewayPayment(tx, a, intent)),
    ).rejects.toThrow(/unique/i);
    await withTenant(app, a.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE fee_payments SET status = 'VOID', voided_at = now(), voided_by_id = '${a.payer}', void_reason = 'paid twice' WHERE id = '${first.id}'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'NEEDS_REVIEW', fee_payment_id = NULL, review_reasons = '{VOIDED}', review_since = now() WHERE id = '${intent.id}'`,
      );
    });
    // Applied again from review (P7b's action, a person's decision with the applied amount), the
    // same money: one live, one void.
    await withTenant(app, a.tenantId, async (tx) => {
      const again = await gatewayPayment(tx, a, intent, { trxId: first.trxId });
      await tx.$executeRawUnsafe(
        `UPDATE payment_intents SET status = 'PAID', fee_payment_id = '${again.id}',
           resolved_by_id = '${a.payer}', resolved_at = now(), resolution_note = 'applied again',
           applied_paisa = ${intent.amountPaisa} WHERE id = '${intent.id}'`,
      );
    });
  });

  it('two connections insert a gateway payment for one intent at once: one wins (review focus 1)', async () => {
    const intent = await newIntent(a);
    const results = await Promise.allSettled([pay(a, intent), pay(a, intent)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/unique|cannot move|only as it becomes PAID/i);
    const payments = await withTenant(app, a.tenantId, (tx) =>
      tx.feePayment.count({ where: { paymentIntentId: intent.id } }),
    );
    expect(payments).toBe(1);
  });

  it('events: whitelisted string fields only, our formats, review reasons on VALIDATE only', async () => {
    const intent = await newIntent(a);
    const event = (data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.paymentGatewayEvent.create({
          data: {
            tenantId: a.tenantId,
            intentId: intent.id,
            kind: 'VALIDATE',
            receivedAt: new Date(),
            ...data,
          },
        }),
      );
    await event({
      outcome: 'VALID',
      valId: 'VAL1',
      fields: { status: 'VALID', amount: '1000.00' },
    });
    const refused: [Record<string, unknown>, string][] = [
      [{ fields: { card_no: '01711XXXXXX' } }, 'fields'],
      [{ fields: { verify_sign: 'abc' } }, 'fields'],
      [{ fields: { amount: 1000 } }, 'fields'],
      [{ fields: { status: { nested: 'VALID' } } }, 'fields'],
      [{ fields: ['VALID'] }, 'fields'],
      [{ fields: { risk_title: 'x'.repeat(101) } }, 'fields'],
      [{ tranId: "JS'1" }, 'refs'],
      [{ valId: 'v'.repeat(51) }, 'refs'],
      [{ outcome: 'not a code' }, 'outcome'],
      [{ kind: 'INIT', reviewReason: 'DUPLICATE' }, 'review'],
      [{ reviewReason: 'HIGH_RISK' }, 'review'],
      [{ sourceListed: true }, 'source'],
      [{ kind: 'RETURN', outcome: 'PAID' }, 'return'],
    ];
    for (const [data, constraint] of refused) {
      await expect(event(data), JSON.stringify(data).slice(0, 80)).rejects.toThrow(
        new RegExp(`payment_gateway_events_${constraint}`),
      );
    }
    // Every whitelisted field at its longest fits.
    const longest = Object.fromEntries(
      [
        'status',
        'tran_date',
        'amount',
        'store_amount',
        'currency',
        'currency_type',
        'currency_amount',
        'bank_tran_id',
        'card_type',
        'card_brand',
        'risk_level',
        'risk_title',
        'error',
      ].map((k) => [k, 'x'.repeat(100)]),
    );
    await event({ fields: longest });
    await expect(
      event({ fields: { error: 'x'.repeat(100), risk_title: 'é'.repeat(100) } }),
    ).resolves.toBeTruthy();
    // 5 KB in one value: refused.
    await expect(event({ fields: { error: 'x'.repeat(5000) } })).rejects.toThrow(
      /payment_gateway_events_fields/,
    );
    await event({ reviewReason: 'UNMATCHED', intentId: null, outcome: 'VALID', valId: 'VAL9' });
  });

  it('no DELETE anywhere; an intent keeps its amount, tran_id, child and payer; events never change', async () => {
    const intent = await newIntent(a);
    for (const statement of [
      `DELETE FROM payment_intents`,
      `DELETE FROM payment_intent_dues`,
      `DELETE FROM payment_gateway_events`,
      `UPDATE payment_intents SET amount_paisa = 1000 WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET tran_id = tran_id WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET student_id = student_id WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET payer_user_id = payer_user_id WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET account_id = account_id WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET priced_on = priced_on WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET expires_at = expires_at WHERE id = '${intent.id}'`,
      `UPDATE payment_intents SET client_request_id = client_request_id WHERE id = '${intent.id}'`,
      `UPDATE payment_intent_dues SET planned_fine_paisa = 0`,
      `UPDATE payment_gateway_events SET outcome = 'OK'`,
      `UPDATE fee_payments SET payment_intent_id = NULL`,
    ]) {
      await expect(sql(a, statement), statement).rejects.toThrow(/permission denied/i);
    }
  });
});
