import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** The receipt counter upsert the API uses: gap-free because it rolls back with the payment. */
async function nextReceiptNo(tx: Parameters<Parameters<typeof withTenant>[2]>[0], year: number) {
  const [row] = await tx.$queryRaw<{ seq: number }[]>`
    INSERT INTO fee_receipt_counters (id, tenant_id, year, next_value, updated_at)
    VALUES (gen_random_uuid(), app_current_tenant_id(), ${year}, 2, now())
    ON CONFLICT (tenant_id, year)
      DO UPDATE SET next_value = fee_receipt_counters.next_value + 1, updated_at = now()
    RETURNING next_value - 1 AS seq`;
  return row!.seq;
}

/** A tenant with two students, a due each, and one cash payment allocated to the first. */
async function school(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const userId = await findOrCreateUser(tx, randomPhone(), 'Accountant');
    await tx.membership.create({ data: { tenantId, userId, role: 'ACCOUNTANT' } });
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
          data: { tenantId, studentCode: `P${n}-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
        }),
      ),
    );
    const dues = await Promise.all(
      students.map((s) =>
        tx.feeDue.create({
          data: {
            tenantId,
            studentId: s.id,
            feeHeadId: head.id,
            academicYearId: year.id,
            periodKey: '2026-09',
            periodStart: new Date('2026-09-01'),
            dueDate: new Date('2026-09-10'),
            amountPaisa: 100000,
            fineType: 'NONE',
            fineAmountPaisa: 0,
          },
        }),
      ),
    );
    const payment = await tx.feePayment.create({
      data: {
        tenantId,
        studentId: students[0]!.id,
        receiptYear: 2026,
        receiptNo: await nextReceiptNo(tx, 2026),
        method: 'CASH',
        channel: 'COUNTER',
        amountPaisa: 60000,
        paidOn: new Date('2026-10-20'),
        recordedOn: new Date('2026-10-20'),
        collectedById: userId,
        clientRequestId: randomUUID(),
      },
    });
    await tx.feePaymentAllocation.create({
      data: {
        tenantId,
        paymentId: payment.id,
        studentId: students[0]!.id,
        dueId: dues[0]!.id,
        principalPaisa: 60000,
        finePaisa: 0,
      },
    });
    return {
      tenantId,
      userId,
      studentIds: students.map((s) => s.id),
      dueIds: dues.map((d) => d.id),
      paymentId: payment.id,
    };
  });
}

const TABLES = ['feeReceiptCounter', 'feePayment', 'feePaymentAllocation'] as const;

describe('fee payment tables', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;

  const payment = (over: Record<string, unknown> = {}) => ({
    tenantId: a.tenantId,
    studentId: a.studentIds[1]!,
    receiptYear: 2026,
    receiptNo: 900000 + Math.floor(Math.random() * 99999),
    method: 'CASH' as const,
    channel: 'COUNTER' as const,
    amountPaisa: 100,
    paidOn: new Date('2026-10-20'),
    recordedOn: new Date('2026-10-20'),
    collectedById: a.userId,
    clientRequestId: randomUUID(),
    ...over,
  });
  const createPayment = (over: Record<string, unknown> = {}) =>
    withTenant(app, a.tenantId, (tx) => tx.feePayment.create({ data: payment(over) }));

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it.each(TABLES)('%s: each tenant sees only its own rows; no context sees none', async (model) => {
    const rows = (await withTenant(app, a.tenantId, (tx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx[model] as any).findMany({ select: { tenantId: true } }),
    )) as { tenantId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === a.tenantId)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (app[model] as any).count()).toBe(0);
  });

  it("a payment cannot be allocated to another student's due, or across tenants", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feePaymentAllocation.create({
          data: {
            tenantId: a.tenantId,
            paymentId: a.paymentId,
            studentId: a.studentIds[0]!,
            dueId: a.dueIds[1]!, // the other student's due
            principalPaisa: 100,
            finePaisa: 0,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(createPayment({ studentId: b.studentIds[0]! })).rejects.toThrow(/foreign key/i);
  });

  it('payments are never edited or deleted: only voided, once, with a reason', async () => {
    for (const sql of [
      `UPDATE fee_payments SET amount_paisa = 1`,
      `UPDATE fee_payments SET student_id = '${a.studentIds[1]}'`,
      `UPDATE fee_payments SET receipt_no = 1`,
      `UPDATE fee_payment_allocations SET principal_paisa = 1`,
      `DELETE FROM fee_payments`,
      `DELETE FROM fee_payment_allocations`,
      `DELETE FROM fee_receipt_counters`,
    ]) {
      await expect(withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
        /permission denied/i,
      );
    }
    const p = await createPayment();
    const voidIt = (data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) => tx.feePayment.update({ where: { id: p.id }, data }));
    await expect(
      voidIt({ status: 'VOID', voidedAt: new Date(), voidedById: a.userId }),
    ).rejects.toThrow(/fee_payments_void/);
    await voidIt({
      status: 'VOID',
      voidedAt: new Date(),
      voidedById: a.userId,
      voidReason: 'ভুল ছাত্র',
    });
    await expect(
      voidIt({ status: 'ACTIVE', voidedAt: null, voidedById: null, voidReason: null }),
    ).rejects.toThrow(/can only be voided/i);
    await expect(voidIt({ voidReason: 'অন্য কারণ লিখে দিলাম' })).rejects.toThrow(
      /can only be voided/i,
    );
  });

  it('a transaction ID is used once per method by live payments; again after a void', async () => {
    const mobile = (trxId: string, method = 'BKASH') => ({
      method,
      channel: 'MOBILE_MANUAL',
      trxId,
      senderPhone: randomPhone(),
    });
    const first = await createPayment(mobile('BFH7KJ2L9Q'));
    await expect(createPayment(mobile('BFH7KJ2L9Q'))).rejects.toThrow(/unique/i);
    await createPayment(mobile('BFH7KJ2L9Q', 'NAGAD'));
    await withTenant(app, a.tenantId, (tx) =>
      tx.feePayment.update({
        where: { id: first.id },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidedById: a.userId,
          voidReason: 'ভুল ছাত্রের নামে',
        },
      }),
    );
    await createPayment(mobile('BFH7KJ2L9Q'));
    // Another institute may see the same ID.
    await withTenant(app, b.tenantId, (tx) =>
      tx.feePayment.create({
        data: {
          ...payment(mobile('BFH7KJ2L9Q')),
          tenantId: b.tenantId,
          studentId: b.studentIds[0]!,
          collectedById: b.userId,
        },
      }),
    );
  });

  it('checks: cash has no TrxID; mobile needs one and the sender; one receipt number per year', async () => {
    await expect(createPayment({ trxId: 'ABCDEF12' })).rejects.toThrow(/fee_payments_channel/);
    await expect(createPayment({ method: 'BKASH', channel: 'MOBILE_MANUAL' })).rejects.toThrow(
      /fee_payments_channel/,
    );
    await expect(
      createPayment({
        method: 'BKASH',
        channel: 'MOBILE_MANUAL',
        trxId: 'abc!',
        senderPhone: randomPhone(),
      }),
    ).rejects.toThrow(/fee_payments_trx_id/);
    await expect(createPayment({ amountPaisa: 0 })).rejects.toThrow(/fee_payments_amount/);
    await expect(createPayment({ receiptYear: 2025 })).rejects.toThrow(/fee_payments_receipt_year/);
    await expect(createPayment({ paidOn: new Date('2026-10-21') })).rejects.toThrow(
      /fee_payments_dates/,
    );
    await createPayment({ receiptNo: 777 });
    await expect(createPayment({ receiptNo: 777 })).rejects.toThrow(/unique/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feePaymentAllocation.create({
          data: {
            tenantId: a.tenantId,
            paymentId: a.paymentId,
            studentId: a.studentIds[0]!,
            dueId: a.dueIds[0]!,
            principalPaisa: 0,
            finePaisa: 0,
          },
        }),
      ),
    ).rejects.toThrow(/fee_payment_allocations_amounts/);
  });

  it('receipt numbers stay gap-free when payments run at once and some roll back', async () => {
    const year = 2031;
    const committed: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withTenant(app, a.tenantId, async (tx) => {
          const seq = await nextReceiptNo(tx, year);
          if (i % 3 === 0) throw new Error('rolled back');
          committed.push(seq);
        }).catch((e: Error) => {
          if (e.message !== 'rolled back') throw e;
        }),
      ),
    );
    expect(committed.sort((x, y) => x - y)).toEqual(
      Array.from({ length: committed.length }, (_, i) => i + 1),
    );
  });
});
