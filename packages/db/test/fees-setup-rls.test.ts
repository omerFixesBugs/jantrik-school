import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** A tenant with one of every fee setup row (step 9, phase A). */
async function school(app: PrismaClient, instituteTypeKey = 'NCTB_SCHOOL_BN') {
  const tenant = await createTenant(app, { instituteTypeKey });
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const classLevel = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
    const adminId = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: adminId, role: 'ADMIN' } });
    const [s1, s2] = await Promise.all(
      ['1', '2'].map((n) =>
        tx.student.create({
          data: { tenantId, studentCode: `S${n}-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
        }),
      ),
    );
    await tx.feeSettings.create({
      data: {
        tenantId,
        duesFrom: new Date('2026-09-01'),
        siblingDiscountType: 'PERCENT',
        siblingDiscountValue: 50,
      },
    });
    const tuition = await tx.feeHead.create({
      data: {
        tenantId,
        nameBn: 'মাসিক বেতন',
        nameEn: 'Monthly tuition',
        kind: 'TUITION',
        frequency: 'MONTHLY',
        dueDay: 10,
        fineType: 'PER_DAY',
        fineAmountPaisa: 1000,
        fineCapPaisa: 10000,
        siblingEligible: true,
      },
    });
    const term = await tx.feeTerm.create({
      data: {
        tenantId,
        academicYearId: year.id,
        nameBn: 'প্রথম সাময়িক',
        nameEn: 'First term',
        opensOn: new Date('2026-05-01'),
        dueDate: new Date('2026-05-15'),
      },
    });
    const amount = await tx.feeAmount.create({
      data: {
        tenantId,
        academicYearId: year.id,
        feeHeadId: tuition.id,
        classLevelId: classLevel.id,
        amountPaisa: 120000,
      },
    });
    const concession = await tx.feeConcession.create({
      data: {
        tenantId,
        studentId: s1!.id,
        feeHeadId: tuition.id,
        academicYearId: year.id,
        category: 'FREE_HALF',
        type: 'PERCENT',
        value: 50,
        validFrom: new Date('2026-01-01'),
        createdById: adminId,
      },
    });
    const group = await tx.feeSiblingGroup.create({ data: { tenantId, createdById: adminId } });
    await tx.feeSiblingMember.createMany({
      data: [s1!, s2!].map((s) => ({
        tenantId,
        groupId: group.id,
        studentId: s.id,
        addedById: adminId,
      })),
    });
    return {
      tenantId,
      yearId: year.id,
      classLevelId: classLevel.id,
      studentIds: [s1!.id, s2!.id],
      adminId,
      headId: tuition.id,
      termId: term.id,
      amountId: amount.id,
      concessionId: concession.id,
      groupId: group.id,
    };
  });
}

const TABLES = [
  'feeSettings',
  'feeHead',
  'feeTerm',
  'feeAmount',
  'feeConcession',
  'feeSiblingGroup',
  'feeSiblingMember',
] as const;

describe('fee setup tables: tenant isolation', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app, 'COACHING');
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it.each(TABLES)('%s: each tenant sees only its own rows', async (model) => {
    const rows = (tenantId: string) =>
      withTenant(app, tenantId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx[model] as any).findMany({ select: { tenantId: true } }),
      ) as Promise<{ tenantId: string }[]>;
    const rowsA = await rows(a.tenantId);
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    const rowsB = await rows(b.tenantId);
    expect(rowsB.every((r) => r.tenantId === b.tenantId)).toBe(true);
  });

  it('no context sees no fee rows', async () => {
    expect(await app.feeHead.count()).toBe(0);
    expect(await app.feeConcession.count()).toBe(0);
    expect(await app.feeSiblingMember.count()).toBe(0);
  });

  it("another tenant cannot change, delete or write into A's rows", async () => {
    const changed = await withTenant(app, b.tenantId, (tx) =>
      tx.feeHead.updateMany({ where: { id: a.headId }, data: { nameEn: 'x' } }),
    );
    expect(changed.count).toBe(0);
    const deleted = await withTenant(app, b.tenantId, (tx) =>
      tx.feeAmount.deleteMany({ where: { id: a.amountId } }),
    );
    expect(deleted.count).toBe(0);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.feeSiblingGroup.create({ data: { tenantId: a.tenantId, createdById: b.adminId } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("rows cannot point at another tenant's year, class, head or student", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeAmount.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            feeHeadId: a.headId,
            classLevelId: b.classLevelId,
            amountPaisa: 100,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeTerm.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: b.yearId,
            nameBn: 'x',
            nameEn: 'x',
            opensOn: new Date('2026-05-01'),
            dueDate: new Date('2026-05-15'),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeConcession.create({
          data: {
            tenantId: a.tenantId,
            studentId: b.studentIds[0]!,
            feeHeadId: a.headId,
            academicYearId: a.yearId,
            category: 'GENERAL',
            type: 'FIXED',
            value: 100,
            validFrom: new Date('2026-01-01'),
            createdById: a.adminId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeSiblingMember.create({
          data: {
            tenantId: a.tenantId,
            groupId: b.groupId,
            studentId: a.studentIds[0]!,
            addedById: a.adminId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('heads, concessions, families and settings are never deleted by the app role', async () => {
    for (const table of [
      'fee_heads',
      'fee_concessions',
      'fee_sibling_groups',
      'fee_sibling_members',
      'fee_settings',
    ]) {
      await expect(
        withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('amounts and unused terms can be deleted', async () => {
    await withTenant(app, a.tenantId, async (tx) => {
      const term = await tx.feeTerm.create({
        data: {
          tenantId: a.tenantId,
          academicYearId: a.yearId,
          nameBn: 'বাতিল',
          nameEn: 'Unused',
          opensOn: new Date('2026-08-01'),
          dueDate: new Date('2026-08-10'),
        },
      });
      await tx.feeTerm.delete({ where: { id: term.id } });
      const amount = await tx.feeAmount.create({
        data: {
          tenantId: a.tenantId,
          academicYearId: a.yearId,
          feeHeadId: a.headId,
          classLevelId: (await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'desc' } }))
            .id,
          amountPaisa: 100,
        },
      });
      await tx.feeAmount.delete({ where: { id: amount.id } });
    });
  });

  it('one class-wide amount per head, class and year; a study group may override it', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeAmount.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            feeHeadId: a.headId,
            classLevelId: a.classLevelId,
            amountPaisa: 5000,
          },
        }),
      ),
    ).rejects.toThrow(/unique/i);
    const group = await withTenant(app, a.tenantId, (tx) => tx.studyGroup.findFirstOrThrow());
    const override = () =>
      withTenant(app, a.tenantId, (tx) =>
        tx.feeAmount.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            feeHeadId: a.headId,
            classLevelId: a.classLevelId,
            studyGroupId: group.id,
            amountPaisa: 150000,
          },
        }),
      );
    await override();
    await expect(override()).rejects.toThrow(/unique/i);
  });

  it('one active concession per student, head and year; ended ones do not count', async () => {
    const row = {
      tenantId: a.tenantId,
      studentId: a.studentIds[0]!,
      feeHeadId: a.headId,
      academicYearId: a.yearId,
      category: 'GENERAL' as const,
      type: 'FIXED' as const,
      value: 10000,
      validFrom: new Date('2026-01-01'),
      createdById: a.adminId,
    };
    await expect(
      withTenant(app, a.tenantId, (tx) => tx.feeConcession.create({ data: row })),
    ).rejects.toThrow(/unique/i);
    await withTenant(app, a.tenantId, async (tx) => {
      await tx.feeConcession.update({
        where: { id: a.concessionId },
        data: { endedOn: new Date('2026-06-01'), endedById: a.adminId, endedReason: 'ended' },
      });
      await tx.feeConcession.create({ data: row });
    });
  });

  it('a student is in at most one family at a time', async () => {
    const other = await withTenant(app, a.tenantId, (tx) =>
      tx.feeSiblingGroup.create({ data: { tenantId: a.tenantId, createdById: a.adminId } }),
    );
    const join = () =>
      withTenant(app, a.tenantId, (tx) =>
        tx.feeSiblingMember.create({
          data: {
            tenantId: a.tenantId,
            groupId: other.id,
            studentId: a.studentIds[1]!,
            addedById: a.adminId,
          },
        }),
      );
    await expect(join()).rejects.toThrow(/unique/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.feeSiblingMember.updateMany({
        where: { studentId: a.studentIds[1]!, removedAt: null },
        data: { removedAt: new Date(), removedById: a.adminId, removedReason: 'not siblings' },
      }),
    );
    await join();
  });

  it('checks reject bad setup values', async () => {
    const head = (data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.feeHead.create({
          data: {
            tenantId: a.tenantId,
            nameBn: `x-${randomUUID().slice(0, 4)}`,
            nameEn: 'x',
            kind: 'OTHER',
            frequency: 'YEARLY',
            ...data,
          },
        }),
      );
    await expect(head({ frequency: 'MONTHLY' })).rejects.toThrow(/fee_heads_due_day/);
    await expect(head({ frequency: 'MONTHLY', dueDay: 29 })).rejects.toThrow(/fee_heads_due_day/);
    await expect(head({ dueDay: 5 })).rejects.toThrow(/fee_heads_due_day/);
    await expect(head({ fineType: 'PER_DAY', fineAmountPaisa: 500 })).rejects.toThrow(
      /fee_heads_fine_rule/,
    );
    await expect(head({ fineType: 'FLAT', fineAmountPaisa: 0 })).rejects.toThrow(
      /fee_heads_fine_rule/,
    );
    await expect(head({ oneTimeFrom: new Date('2026-01-01') })).rejects.toThrow(
      /fee_heads_one_time_from/,
    );
    await expect(head({ nameBn: '  ' })).rejects.toThrow(/fee_heads_names_present/);

    const concession = (data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.feeConcession.create({
          data: {
            tenantId: a.tenantId,
            studentId: a.studentIds[1]!,
            feeHeadId: a.headId,
            academicYearId: a.yearId,
            category: 'GENERAL',
            type: 'PERCENT',
            value: 10,
            validFrom: new Date('2026-01-01'),
            createdById: a.adminId,
            ...data,
          },
        }),
      );
    await expect(concession({ value: 101 })).rejects.toThrow(/fee_concessions_value_range/);
    await expect(concession({ category: 'FREE_FULL', value: 50 })).rejects.toThrow(
      /fee_concessions_category_rule/,
    );
    await expect(concession({ category: 'FREE_HALF', type: 'FIXED', value: 50 })).rejects.toThrow(
      /fee_concessions_category_rule/,
    );
    await expect(concession({ category: 'SCHOLARSHIP' })).rejects.toThrow(
      /fee_concessions_category_rule/,
    );

    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeSettings.update({
          where: { tenantId: a.tenantId },
          data: { duesFrom: new Date('2026-09-15') },
        }),
      ),
    ).rejects.toThrow(/fee_settings_dues_from_first_of_month/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeSettings.update({
          where: { tenantId: a.tenantId },
          data: { siblingDiscountValue: null },
        }),
      ),
    ).rejects.toThrow(/fee_settings_sibling_rule/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeTerm.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            nameBn: 'উল্টো',
            nameEn: 'Backwards',
            opensOn: new Date('2026-05-15'),
            dueDate: new Date('2026-05-01'),
          },
        }),
      ),
    ).rejects.toThrow(/fee_terms_date_order/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.feeAmount.update({ where: { id: a.amountId }, data: { amountPaisa: 0 } }),
      ),
    ).rejects.toThrow(/fee_amounts_amount_range/);
  });
});
