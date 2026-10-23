import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** A tenant with a bKash number, a guardian's pending TrxID submission and its due (step 9, D). */
async function school(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const userId = await findOrCreateUser(tx, randomPhone(), 'Guardian');
    await tx.membership.create({ data: { tenantId, userId, role: 'GUARDIAN' } });
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
          data: { tenantId, studentCode: `M${n}-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
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
    const bkash = await tx.feeMobileAccount.create({
      data: { tenantId, method: 'BKASH', phone: randomPhone(), kind: 'PERSONAL', label: 'অফিস' },
    });
    const nagad = await tx.feeMobileAccount.create({
      data: { tenantId, method: 'NAGAD', phone: randomPhone(), kind: 'MERCHANT' },
    });
    const submission = await tx.feeMobileSubmission.create({
      data: {
        tenantId,
        studentId: students[0]!.id,
        method: 'BKASH',
        accountId: bkash.id,
        amountPaisa: 100000,
        trxId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
        senderPhone: randomPhone(),
        sentOn: new Date('2026-10-20'),
        submittedById: userId,
        submitter: 'GUARDIAN',
        clientRequestId: randomUUID(),
      },
    });
    await tx.feeMobileSubmissionDue.create({
      data: {
        tenantId,
        submissionId: submission.id,
        studentId: students[0]!.id,
        dueId: dues[0]!.id,
      },
    });
    return {
      tenantId,
      userId,
      studentIds: students.map((s) => s.id),
      dueIds: dues.map((d) => d.id),
      bkashId: bkash.id,
      nagadId: nagad.id,
      submissionId: submission.id,
    };
  });
}

const TABLES = ['feeMobileAccount', 'feeMobileSubmission', 'feeMobileSubmissionDue'] as const;

describe('manual bKash/Nagad tables', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;

  const submission = (over: Record<string, unknown> = {}) => ({
    tenantId: a.tenantId,
    studentId: a.studentIds[1]!,
    method: 'BKASH' as const,
    accountId: a.bkashId,
    amountPaisa: 500,
    trxId: `X${randomUUID().slice(0, 8).toUpperCase()}`,
    senderPhone: randomPhone(),
    sentOn: new Date('2026-10-20'),
    submittedById: a.userId,
    submitter: 'GUARDIAN' as const,
    clientRequestId: randomUUID(),
    ...over,
  });
  const submit = (over: Record<string, unknown> = {}) =>
    withTenant(app, a.tenantId, (tx) => tx.feeMobileSubmission.create({ data: submission(over) }));

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

  it("a submission goes to this institute's account of the same method, for its own student's dues", async () => {
    await expect(submit({ accountId: b.bkashId })).rejects.toThrow(/foreign key/i);
    await expect(submit({ accountId: a.nagadId })).rejects.toThrow(/foreign key/i); // method BKASH
    await expect(submit({ studentId: b.studentIds[0]! })).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeMobileSubmissionDue.create({
          data: {
            tenantId: a.tenantId,
            submissionId: a.submissionId,
            studentId: a.studentIds[0]!,
            dueId: a.dueIds[1]!, // the other student's due
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('a TrxID is open once per method; free again once rejected or voided', async () => {
    const first = await submit({ trxId: 'BFH7KJ2L9Q' });
    await expect(submit({ trxId: 'BFH7KJ2L9Q' })).rejects.toThrow(/unique/i);
    await submit({ trxId: 'BFH7KJ2L9Q', method: 'NAGAD', accountId: a.nagadId });
    await withTenant(app, a.tenantId, (tx) =>
      tx.feeMobileSubmission.update({
        where: { id: first.id },
        data: {
          status: 'REJECTED',
          reviewedById: a.userId,
          reviewedAt: new Date(),
          rejectReason: 'টাকা আসেনি',
        },
      }),
    );
    await submit({ trxId: 'BFH7KJ2L9Q' });
    await withTenant(app, b.tenantId, (tx) =>
      tx.feeMobileSubmission.create({
        data: {
          ...submission({ trxId: 'BFH7KJ2L9Q' }),
          tenantId: b.tenantId,
          studentId: b.studentIds[1]!,
          accountId: b.bkashId,
          submittedById: b.userId,
        },
      }),
    );
  });

  it('history: never deleted; who, what and how much never rewritten', async () => {
    for (const sql of [
      `DELETE FROM fee_mobile_submissions`,
      `DELETE FROM fee_mobile_submission_dues`,
      `DELETE FROM fee_mobile_accounts`,
      `UPDATE fee_mobile_submissions SET amount_paisa = 1`,
      `UPDATE fee_mobile_submissions SET trx_id = 'ZZZZZZZZ'`,
      `UPDATE fee_mobile_submissions SET student_id = '${a.studentIds[1]}'`,
    ]) {
      await expect(withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('checks: methods, formats and a coherent review state', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeMobileAccount.create({
          data: { tenantId: a.tenantId, method: 'CASH', phone: randomPhone(), kind: 'PERSONAL' },
        }),
      ),
    ).rejects.toThrow(/fee_mobile_accounts_method/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeMobileAccount.create({
          data: { tenantId: a.tenantId, method: 'BKASH', phone: '01711000000', kind: 'PERSONAL' },
        }),
      ),
    ).rejects.toThrow(/fee_mobile_accounts_phone/);
    await expect(submit({ trxId: 'ab' })).rejects.toThrow(/fee_mobile_submissions_trx_id/);
    await expect(submit({ senderPhone: '12345' })).rejects.toThrow(
      /fee_mobile_submissions_sender_phone/,
    );
    await expect(submit({ amountPaisa: 0 })).rejects.toThrow(/fee_mobile_submissions_amount/);
    await expect(submit({ status: 'VERIFIED' })).rejects.toThrow(/fee_mobile_submissions_review/);
    await expect(
      submit({ status: 'REJECTED', reviewedById: a.userId, reviewedAt: new Date() }),
    ).rejects.toThrow(/fee_mobile_submissions_review/);
  });
});
