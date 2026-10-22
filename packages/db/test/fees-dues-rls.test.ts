import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** A tenant with a monthly head, two students and one due + fine waiver (step 9, phase B). */
async function school(app: PrismaClient) {
  const tenant = await createTenant(app);
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const adminId = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: adminId, role: 'ADMIN' } });
    const [s1, s2] = await Promise.all(
      ['1', '2'].map((n) =>
        tx.student.create({
          data: { tenantId, studentCode: `D${n}-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
        }),
      ),
    );
    const head = await tx.feeHead.create({
      data: {
        tenantId,
        nameBn: 'মাসিক বেতন',
        nameEn: 'Tuition',
        kind: 'TUITION',
        frequency: 'MONTHLY',
        dueDay: 10,
      },
    });
    const term = await tx.feeTerm.create({
      data: {
        tenantId,
        academicYearId: year.id,
        nameBn: 'প্রথম',
        nameEn: 'First',
        opensOn: new Date('2026-04-20'),
        dueDate: new Date('2026-05-05'),
      },
    });
    const due = await tx.feeDue.create({
      data: {
        tenantId,
        studentId: s1!.id,
        feeHeadId: head.id,
        academicYearId: year.id,
        periodKey: '2026-09',
        periodStart: new Date('2026-09-01'),
        dueDate: new Date('2026-09-10'),
        amountPaisa: 100000,
        fineType: 'PER_DAY',
        fineAmountPaisa: 1000,
        fineCapPaisa: 10000,
      },
    });
    await tx.feeFineWaiver.create({
      data: {
        tenantId,
        dueId: due.id,
        studentId: s1!.id,
        amountPaisa: 2000,
        reason: 'অসুস্থ ছিল',
        createdById: adminId,
      },
    });
    return {
      tenantId,
      yearId: year.id,
      headId: head.id,
      termId: term.id,
      studentIds: [s1!.id, s2!.id],
      dueId: due.id,
      adminId,
    };
  });
}

const TABLES = ['feeDue', 'feeFineWaiver'] as const;

describe('fee dues tables: tenant isolation and integrity', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;

  const due = (over: Record<string, unknown> = {}) => ({
    tenantId: a.tenantId,
    studentId: a.studentIds[1]!,
    feeHeadId: a.headId,
    academicYearId: a.yearId,
    periodKey: '2026-10',
    periodStart: new Date('2026-10-01'),
    dueDate: new Date('2026-10-10'),
    amountPaisa: 100000,
    fineType: 'NONE' as const,
    fineAmountPaisa: 0,
    ...over,
  });
  const createDue = (over: Record<string, unknown> = {}) =>
    withTenant(app, a.tenantId, (tx) => tx.feeDue.create({ data: due(over) }));

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it.each(TABLES)('%s: each tenant sees only its own rows; no context sees none', async (model) => {
    const rows = (tenantId: string) =>
      withTenant(app, tenantId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx[model] as any).findMany({ select: { tenantId: true } }),
      ) as Promise<{ tenantId: string }[]>;
    const rowsA = await rows(a.tenantId);
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (app[model] as any).count()).toBe(0);
  });

  it("a due cannot point at another tenant's student, head or term", async () => {
    await expect(createDue({ studentId: b.studentIds[1]! })).rejects.toThrow(/foreign key/i);
    await expect(createDue({ feeHeadId: b.headId })).rejects.toThrow(/foreign key/i);
    await expect(
      createDue({
        periodKey: `T:${b.termId}`,
        feeTermId: b.termId,
        periodStart: new Date('2026-04-20'),
        dueDate: new Date('2026-05-05'),
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a fine waiver must belong to the due's own student", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeFineWaiver.create({
          data: {
            tenantId: a.tenantId,
            dueId: a.dueId,
            studentId: a.studentIds[1]!, // not the due's student
            amountPaisa: 100,
            reason: 'ভুল ছাত্র',
            createdById: a.adminId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('one due per student, head, year and period; a one-time fee once ever', async () => {
    await expect(createDue({ studentId: a.studentIds[0]!, periodKey: '2026-09' })).rejects.toThrow(
      /unique/i,
    );
    const next = await withTenant(app, a.tenantId, (tx) =>
      tx.academicYear.create({
        data: {
          tenantId: a.tenantId,
          name: `2027-${randomUUID().slice(0, 4)}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      }),
    );
    const once = {
      periodKey: 'ONCE',
      periodStart: new Date('2026-10-15'),
      dueDate: new Date('2026-10-22'),
    };
    await createDue(once);
    await expect(createDue({ ...once, academicYearId: next.id })).rejects.toThrow(/unique/i);
  });

  it('dues and waivers are history: never deleted; who, head and period never rewritten', async () => {
    for (const table of ['fee_dues', 'fee_fine_waivers']) {
      await expect(
        withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table}`)),
      ).rejects.toThrow(/permission denied/i);
    }
    for (const sql of [
      `UPDATE fee_dues SET student_id = '${a.studentIds[1]}'`,
      `UPDATE fee_dues SET period_key = '2026-11'`,
      `UPDATE fee_dues SET due_date = '2026-12-31'`,
      `UPDATE fee_fine_waivers SET amount_paisa = 1`,
    ]) {
      await expect(withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('checks keep the cached totals and the snapshot honest', async () => {
    await expect(createDue({ periodKey: '2026-13' })).rejects.toThrow(/fee_dues_period_key/);
    await expect(createDue({ periodKey: 'T:abc' })).rejects.toThrow(/fee_dues_period_key/);
    await expect(createDue({ periodKey: `T:${a.termId}` })).rejects.toThrow(/fee_dues_term/);
    await expect(createDue({ concessionPaisa: 100001 })).rejects.toThrow(/fee_dues_concession/);
    await expect(createDue({ concessionPaisa: 500 })).rejects.toThrow(/fee_dues_concession/); // source NONE
    await expect(createDue({ concessionPaisa: 500, concessionSource: 'MANUAL' })).rejects.toThrow(
      /fee_dues_concession/,
    ); // MANUAL needs the concession
    await expect(createDue({ paidPrincipalPaisa: 100001 })).rejects.toThrow(/fee_dues_paid/);
    await expect(
      createDue({ paidPrincipalPaisa: 50000, principalClearedOn: new Date('2026-10-05') }),
    ).rejects.toThrow(/fee_dues_cleared/);
    await expect(createDue({ fineType: 'PER_DAY', fineAmountPaisa: 100 })).rejects.toThrow(
      /fee_dues_fine_rule/,
    );
    await expect(createDue({ dueDate: new Date('2026-09-30') })).rejects.toThrow(/fee_dues_dates/);
    await expect(
      createDue({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: a.adminId,
        cancelReason: 'না',
      }),
    ).rejects.toThrow(/fee_dues_cancel/); // reason too short
    await expect(
      createDue({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: a.adminId,
        cancelReason: 'ভুল ক্লাসে ছিল',
        paidPrincipalPaisa: 100,
      }),
    ).rejects.toThrow(/fee_dues_cancel/); // something was paid
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeFineWaiver.create({
          data: {
            tenantId: a.tenantId,
            dueId: a.dueId,
            studentId: a.studentIds[0]!,
            amountPaisa: 0,
            reason: 'শূন্য',
            createdById: a.adminId,
          },
        }),
      ),
    ).rejects.toThrow(/fee_fine_waivers_amount/);
  });
});
