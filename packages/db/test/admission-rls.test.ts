import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createStudent, createTenant } from './helpers.js';

// Sprint 1 P3a: the admission tables (cycles, their classes, applications, applicant photos and
// the numbers): tenant RLS, applications kept as history, CHECKs and composite keys.

interface Seed {
  tenantId: string;
  yearId: string;
  classLevelIds: string[];
  cycleId: string;
  otherCycleId: string;
  cycleClassId: string;
  otherCycleClassId: string;
  applicationId: string;
}

const PHONE = '+8801711000001';

async function seed(app: PrismaClient): Promise<Seed> {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const classes = await tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
    const cycle = (n: string) =>
      tx.admissionCycle.create({
        data: {
          tenantId,
          academicYearId: year.id,
          nameBn: n,
          opensAt: new Date('2026-11-01T00:00:00Z'),
          closesAt: new Date('2026-12-31T00:00:00Z'),
        },
      });
    const c1 = await cycle('ভর্তি ২০২৭');
    const c2 = await cycle('ভর্তি ২০২৭ (২)');
    const cc1 = await tx.admissionCycleClass.create({
      data: { tenantId, cycleId: c1.id, classLevelId: classes[0]!.id },
    });
    const cc2 = await tx.admissionCycleClass.create({
      data: { tenantId, cycleId: c2.id, classLevelId: classes[0]!.id },
    });
    const app1 = await tx.admissionApplication.create({
      data: application(tenantId, c1.id, cc1.id, '2026-0001'),
    });
    return {
      tenantId,
      yearId: year.id,
      classLevelIds: classes.map((c) => c.id),
      cycleId: c1.id,
      otherCycleId: c2.id,
      cycleClassId: cc1.id,
      otherCycleClassId: cc2.id,
      applicationId: app1.id,
    };
  });
}

function application(tenantId: string, cycleId: string, cycleClassId: string, no: string) {
  return {
    tenantId,
    cycleId,
    cycleClassId,
    applicationNo: no,
    source: 'STAFF' as const,
    nameBn: 'রাফি',
    nameKey: 'রাফি',
    dateOfBirth: new Date('2019-05-01'),
    gender: 'MALE' as const,
    guardianNameBn: 'করিম',
    guardianRelation: 'FATHER' as const,
    phone: PHONE,
    submittedAt: new Date(),
  };
}

describe('admission tables', () => {
  let app: PrismaClient;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    app = appClient();
    a = await seed(app);
    b = await seed(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another institute sees and changes nothing of A's admission rows", async () => {
    await withTenant(app, b.tenantId, async (tx) => {
      const ids = { a: a.cycleId };
      expect(await tx.admissionCycle.findMany({ where: { id: ids.a } })).toEqual([]);
      expect(await tx.admissionCycleClass.findMany({ where: { cycleId: ids.a } })).toEqual([]);
      expect(await tx.admissionApplication.findMany({ where: { cycleId: ids.a } })).toEqual([]);
      expect(
        (
          await tx.admissionApplication.updateMany({
            where: { id: a.applicationId },
            data: { staffNote: 'x' },
          })
        ).count,
      ).toBe(0);
      expect(await tx.admissionCounter.findMany({ where: { tenantId: a.tenantId } })).toEqual([]);
    });
    // B cannot write a row into A's institute either.
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.admissionCycle.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            nameBn: 'x',
            opensAt: new Date('2026-11-01'),
            closesAt: new Date('2026-12-01'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('nothing is visible without a context', async () => {
    const rows = await withContext(app, {}, (tx) => tx.admissionApplication.findMany());
    expect(rows).toEqual([]);
  });

  it("a cycle can't use another institute's year; an application's class belongs to its cycle", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycle.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: b.yearId,
            nameBn: 'x',
            opensAt: new Date('2026-11-01'),
            closesAt: new Date('2026-12-01'),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.create({
          data: application(a.tenantId, a.cycleId, a.otherCycleClassId, '2026-0002'),
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    // Moving an application to another cycle's class fails too.
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.update({
          where: { id: a.applicationId },
          data: { cycleClassId: a.otherCycleClassId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it.each([
    ['ADMITTED without a student', { status: 'ADMITTED' as const }],
    ['REJECTED without a reason', { status: 'REJECTED' as const }],
    ['a status by without a time', { statusBy: '01900000-0000-7000-8000-000000000000' }],
    ['a 16-digit birth registration number', { birthRegistrationNo: '2019123456789012' }],
    ['a phone that is not E.164', { phone: '01711000000' }],
    ['no name at all', { nameBn: null, nameEn: null }],
    ['an unknown approval problem', { approvalProblem: 'X', approvalProblemAt: new Date() }],
  ])('a CHECK refuses %s', async (_label, data) => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.update({ where: { id: a.applicationId }, data }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it.each([
    ['an unknown key', { colour: 'OPTIONAL' }],
    ['the value YES', { religion: 'YES' }],
    ['an array', ['photo']],
  ])('the cycle fields CHECK refuses %s', async (_label, fields) => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycle.update({ where: { id: a.cycleId }, data: { fields } }),
      ),
    ).rejects.toThrow(/check constraint/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionCycle.update({
        where: { id: a.cycleId },
        data: { fields: { photo: 'REQUIRED', religion: 'HIDDEN' } },
      }),
    );
  });

  it('a window that closes before it opens is refused', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycle.update({
          where: { id: a.cycleId },
          data: { closesAt: new Date('2026-10-01T00:00:00Z') },
        }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('applications are history: no DELETE, and the number, source, cycle and time never change', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) => tx.$executeRaw`DELETE FROM admission_applications`),
    ).rejects.toThrow(/permission denied/);
    for (const set of [
      `application_no = '2026-0099'`,
      `source = 'ONLINE'`,
      `cycle_id = cycle_id`,
      `submitted_at = now()`,
      `tenant_id = tenant_id`,
    ]) {
      await expect(
        withTenant(app, a.tenantId, (tx) =>
          tx.$executeRawUnsafe(`UPDATE admission_applications SET ${set}`),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    // What staff may change still works.
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionApplication.update({
        where: { id: a.applicationId },
        data: { staffNote: 'Came with the father', status: 'SHORTLISTED' },
      }),
    );
  });

  it('an application number is unique per institute; the format is checked', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.create({
          data: application(a.tenantId, a.cycleId, a.cycleClassId, '2026-0001'),
        }),
      ),
    ).rejects.toThrow(/unique/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.create({
          data: application(a.tenantId, a.cycleId, a.cycleClassId, '26-1'),
        }),
      ),
    ).rejects.toThrow(/check constraint/i);
    // The same number in another institute is fine.
    await withTenant(app, b.tenantId, (tx) =>
      tx.admissionApplication.create({
        data: application(b.tenantId, b.cycleId, b.cycleClassId, '2026-0002'),
      }),
    );
  });

  it('a class with an application cannot be removed; an empty one can', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycleClass.delete({ where: { id: a.cycleClassId } }),
      ),
    ).rejects.toThrow(/foreign key/i);
    const extra = await withTenant(app, a.tenantId, (tx) =>
      tx.admissionCycleClass.create({
        data: { tenantId: a.tenantId, cycleId: a.cycleId, classLevelId: a.classLevelIds[1]! },
      }),
    );
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionCycleClass.delete({ where: { id: extra.id } }),
    );
  });

  it('a class (without a group) is listed once per cycle', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycleClass.create({
          data: { tenantId: a.tenantId, cycleId: a.cycleId, classLevelId: a.classLevelIds[0]! },
        }),
      ),
    ).rejects.toThrow(/unique/i);
  });

  it('cycles cannot be deleted; seats are bounded', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) => tx.$executeRaw`DELETE FROM admission_cycles`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycleClass.update({ where: { id: a.cycleClassId }, data: { seats: 0 } }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('a photo row: JPEG only, at most 200 KB, a real hash; never updated', async () => {
    const photo = (bytes: Buffer, mime = 'image/jpeg') =>
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplicationPhoto.create({
          data: {
            tenantId: a.tenantId,
            applicationId: a.applicationId,
            mime,
            bytes: new Uint8Array(bytes),
            sha256: 'a'.repeat(64),
            width: 300,
            height: 400,
          },
        }),
      );
    await expect(photo(Buffer.alloc(300 * 1024, 1))).rejects.toThrow(/check constraint/i);
    await expect(photo(Buffer.alloc(10, 1), 'image/png')).rejects.toThrow(/check constraint/i);
    await photo(Buffer.alloc(10, 1));
    await expect(
      withTenant(
        app,
        a.tenantId,
        (tx) => tx.$executeRaw`UPDATE admission_application_photos SET width = 1`,
      ),
    ).rejects.toThrow(/permission denied/);
    // B cannot see A's photo.
    expect(
      await withTenant(app, b.tenantId, (tx) => tx.admissionApplicationPhoto.findMany()),
    ).toHaveLength(0);
  });

  it('an ADMITTED application points at a student of its own institute, once', async () => {
    const studentA = (await createStudent(app, a.tenantId, 'ADM-1')).student;
    const studentB = (await createStudent(app, b.tenantId, 'ADM-1')).student;
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.update({
          where: { id: a.applicationId },
          data: { status: 'ADMITTED', studentId: studentB.id },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionApplication.update({
        where: { id: a.applicationId },
        data: { status: 'ADMITTED', studentId: studentA.id },
      }),
    );
    const second = await withTenant(app, a.tenantId, (tx) =>
      tx.admissionApplication.create({
        data: application(a.tenantId, a.cycleId, a.cycleClassId, '2026-0003'),
      }),
    );
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.update({
          where: { id: second.id },
          data: { status: 'ADMITTED', studentId: studentA.id },
        }),
      ),
    ).rejects.toThrow(/unique/i);
  });

  it('counters stay in range', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionCounter.create({ data: { tenantId: a.tenantId, year: 1999 } }),
      ),
    ).rejects.toThrow(/check constraint/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionCounter.create({ data: { tenantId: a.tenantId, year: 2027, lastNo: 1 } }),
    );
  });

  it('one live application per birth registration number per cycle; a withdrawn one frees it (review S3)', async () => {
    const reg = '20191111111111111';
    const make = (no: string) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.admissionApplication.create({
          data: {
            ...application(a.tenantId, a.cycleId, a.cycleClassId, no),
            birthRegistrationNo: reg,
          },
        }),
      );
    const first = await make('2026-0101');
    await expect(make('2026-0102')).rejects.toThrow(/unique/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.admissionApplication.update({
        where: { id: first.id },
        data: { status: 'WITHDRAWN', statusReason: 'x' },
      }),
    );
    await make('2026-0103');
  });

  // ─────────────────────────── Sprint 1 P4: the admission test ───────────────────────────

  describe('the admission test (P4)', () => {
    /** A class of its own with full marks 100, and one application in it. */
    const testClass = async (no: string, full: number | null = 100) =>
      withTenant(app, a.tenantId, async (tx) => {
        const cycle = await tx.admissionCycle.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            nameBn: `পরীক্ষা ${no}`,
            requiresTest: true,
            opensAt: new Date('2026-11-01T00:00:00Z'),
            closesAt: new Date('2026-12-31T00:00:00Z'),
          },
        });
        const cc = await tx.admissionCycleClass.create({
          data: {
            tenantId: a.tenantId,
            cycleId: cycle.id,
            classLevelId: a.classLevelIds[0]!,
            fullMarks: full,
          },
        });
        const row = await tx.admissionApplication.create({
          data: application(a.tenantId, cycle.id, cc.id, no),
        });
        return { cycleId: cycle.id, cycleClassId: cc.id, applicationId: row.id };
      });
    const setApp = (id: string, data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) => tx.admissionApplication.update({ where: { id }, data }));
    const setClass = (id: string, data: Record<string, unknown>) =>
      withTenant(app, a.tenantId, (tx) => tx.admissionCycleClass.update({ where: { id }, data }));

    it('a score stays within its class full marks (hundredths); no score without full marks', async () => {
      const t = await testClass('2026-0201');
      await setApp(t.applicationId, { testRoll: 1001, testScoreH: 10_000 });
      await expect(setApp(t.applicationId, { testScoreH: 10_001 })).rejects.toThrow(
        /test_score_within_full_marks/,
      );
      const none = await testClass('2026-0202', null);
      await expect(setApp(none.applicationId, { testScoreH: 5_000 })).rejects.toThrow(
        /test_score_within_full_marks/,
      );
      // Full marks cannot drop below a score already entered, nor be removed.
      await expect(setClass(t.cycleClassId, { fullMarks: 90 })).rejects.toThrow(
        /full_marks_keep_test_scores/,
      );
      await expect(setClass(t.cycleClassId, { fullMarks: null })).rejects.toThrow(
        /full_marks_keep_test_scores/,
      );
      await setClass(t.cycleClassId, { fullMarks: 120 });
    });

    it('an absent applicant has no score; the pass marks are within the full marks; counts are bounded', async () => {
      const t = await testClass('2026-0203');
      await expect(setApp(t.applicationId, { testAbsent: true, testScoreH: 0 })).rejects.toThrow(
        /check constraint/i,
      );
      await setApp(t.applicationId, { testAbsent: true });
      await expect(setClass(t.cycleClassId, { passMarks: 101 })).rejects.toThrow(
        /check constraint/i,
      );
      await expect(setClass(t.cycleClassId, { fullMarks: 1001 })).rejects.toThrow(
        /check constraint/i,
      );
      await expect(setClass(t.cycleClassId, { selectCount: 5001 })).rejects.toThrow(
        /check constraint/i,
      );
      await expect(setClass(t.cycleClassId, { testVenueBn: 'ক'.repeat(201) })).rejects.toThrow(
        /check constraint/i,
      );
      await setClass(t.cycleClassId, { passMarks: 33, selectCount: 40, waitlistCount: 10 });
    });

    it('a test roll is unique within its class; a waitlist position needs a WAITLISTED draft', async () => {
      const t = await testClass('2026-0204');
      await setApp(t.applicationId, { testRoll: 1001 });
      const other = await withTenant(app, a.tenantId, async (tx) => {
        const cycleClass = await tx.admissionCycleClass.findUniqueOrThrow({
          where: { id: t.cycleClassId },
        });
        return tx.admissionApplication.create({
          data: application(a.tenantId, cycleClass.cycleId, t.cycleClassId, '2026-0205'),
        });
      });
      await expect(setApp(other.id, { testRoll: 1001 })).rejects.toThrow(/unique/i);
      await setApp(other.id, { testRoll: 1002 });
      await expect(setApp(other.id, { waitlistPosition: 1 })).rejects.toThrow(/check constraint/i);
      await setApp(other.id, { testResult: 'WAITLISTED', waitlistPosition: 1, meritPosition: 3 });
      await expect(setApp(other.id, { testRoll: 0 })).rejects.toThrow(/check constraint/i);
    });

    it('a published version has its time and its full marks; a flag is one of the known ones', async () => {
      const t = await testClass('2026-0206');
      await expect(setClass(t.cycleClassId, { resultsVersion: 1 })).rejects.toThrow(
        /check constraint/i,
      );
      await setClass(t.cycleClassId, {
        resultsVersion: 1,
        resultsPublishedAt: new Date(),
        resultsFullMarks: 100,
      });
      await expect(setApp(t.applicationId, { resultFlag: 'SOMETHING' })).rejects.toThrow(
        /check constraint/i,
      );
      await setApp(t.applicationId, { resultFlag: 'ADMITTED_NOT_SELECTED' });
    });

    it('the tie-break defaults to the older first', async () => {
      const t = await testClass('2026-0207');
      const cycle = await withTenant(app, a.tenantId, (tx) =>
        tx.admissionCycle.findUniqueOrThrow({ where: { id: t.cycleId } }),
      );
      expect(cycle.meritTieBreak).toBe('OLDER_FIRST');
    });
  });
});
