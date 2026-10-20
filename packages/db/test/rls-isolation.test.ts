import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, tenantClient, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createStudent, createTenant } from './helpers.js';

describe('RLS: tenant A cannot touch tenant B', () => {
  let app: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  let studentA: string;
  let studentB: string;

  beforeAll(async () => {
    app = appClient();
    tenantA = (await createTenant(app)).id;
    tenantB = (await createTenant(app, { instituteTypeKey: 'COACHING' })).id;
    studentA = (await createStudent(app, tenantA, 'A-001')).student.id;
    studentB = (await createStudent(app, tenantB, 'B-001')).student.id;
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('reads only its own rows', async () => {
    const db = tenantClient(app, tenantA);

    const students = await db.student.findMany();
    expect(students.map((s) => s.id)).toEqual([studentA]);
    expect(await db.student.findUnique({ where: { id: studentB } })).toBeNull();

    const tenants = await db.tenant.findMany();
    expect(tenants.map((t) => t.id)).toEqual([tenantA]);

    // Every row of every copied table belongs to A.
    const classLevels = await db.classLevel.findMany();
    expect(classLevels.length).toBeGreaterThan(0);
    expect(classLevels.every((c) => c.tenantId === tenantA)).toBe(true);
  });

  it('raw SQL inside withTenant is scoped too', async () => {
    const rows = await withTenant(
      app,
      tenantA,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM students`,
    );
    expect(rows.map((r) => r.id)).toEqual([studentA]);
  });

  it('cannot update B rows', async () => {
    const db = tenantClient(app, tenantA);

    const { count } = await db.student.updateMany({
      where: { id: studentB },
      data: { nameEn: 'hacked' },
    });
    expect(count).toBe(0);
    await expect(
      db.student.update({ where: { id: studentB }, data: { nameEn: 'hacked' } }),
    ).rejects.toMatchObject({ code: 'P2025' });

    const b = await tenantClient(app, tenantB).student.findUniqueOrThrow({
      where: { id: studentB },
    });
    expect(b.nameEn).toBe('Student B-001');
  });

  it('cannot delete B rows', async () => {
    const db = tenantClient(app, tenantA);

    const { count } = await db.enrolment.deleteMany({ where: { studentId: studentB } });
    expect(count).toBe(0);
    // No institute may delete a tenant at all (not even its own): no DELETE grant.
    await expect(db.tenant.delete({ where: { id: tenantB } })).rejects.toThrow(
      /permission denied/i,
    );

    expect(await tenantClient(app, tenantB).enrolment.count()).toBe(1);
  });

  it('cannot insert a row for B (WITH CHECK)', async () => {
    await expect(
      withTenant(app, tenantA, (tx) =>
        tx.student.create({ data: { tenantId: tenantB, studentCode: 'X', nameEn: 'Intruder' } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot move its own row into B', async () => {
    await expect(
      withTenant(app, tenantA, (tx) =>
        tx.student.update({ where: { id: studentA }, data: { tenantId: tenantB } }),
      ),
    ).rejects.toThrow();

    const a = await tenantClient(app, tenantA).student.findUniqueOrThrow({
      where: { id: studentA },
    });
    expect(a.tenantId).toBe(tenantA);
  });

  it("cannot reference B's rows from its own rows (composite foreign keys)", async () => {
    await expect(
      withTenant(app, tenantA, async (tx) => {
        const year = await tx.academicYear.findFirstOrThrow();
        const classLevel = await tx.classLevel.findFirstOrThrow();
        // B's student UUID is known to the attacker; the FK is (tenant_id, student_id).
        await tx.student.create({ data: { tenantId: tenantA, studentCode: 'A-002', nameEn: 'x' } });
        return tx.enrolment.create({
          data: {
            tenantId: tenantA,
            studentId: studentB,
            academicYearId: year.id,
            classLevelId: classLevel.id,
          },
        });
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003',
    );
  });

  it("cannot attach B's shift to its own section (optional composite FK)", async () => {
    const shiftB = await withTenant(app, tenantB, (tx) =>
      tx.shift.create({
        data: {
          tenantId: tenantB,
          nameBn: 'প্রভাতী',
          nameEn: 'Morning',
          startTime: new Date('1970-01-01T07:00:00Z'),
          endTime: new Date('1970-01-01T12:00:00Z'),
        },
      }),
    );

    await expect(
      withTenant(app, tenantA, async (tx) => {
        const year = await tx.academicYear.findFirstOrThrow();
        const classLevel = await tx.classLevel.findFirstOrThrow();
        return tx.section.create({
          data: {
            tenantId: tenantA,
            academicYearId: year.id,
            classLevelId: classLevel.id,
            shiftId: shiftB.id,
            name: 'A',
          },
        });
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003',
    );
  });

  it('rejects a malformed tenant id before touching the DB', () => {
    expect(() => tenantClient(app, "x' OR 1=1 --")).toThrow(TypeError);
  });
});
