import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** A published-looking exam class with one candidate and their result row. */
async function school(app: PrismaClient, instituteTypeKey = 'NCTB_SCHOOL_BN') {
  const tenant = await createTenant(app, { instituteTypeKey });
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const class9 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } });
    const class10 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_10' } });
    const section = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: class9.id, name: 'A' },
    });
    const section10 = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: class10.id, name: 'A' },
    });
    const [student, other] = await Promise.all(
      ['S', 'O'].map((p) =>
        tx.student.create({
          data: { tenantId, studentCode: `${p}-${randomUUID().slice(0, 8)}`, nameEn: p },
        }),
      ),
    );
    const exam = await tx.exam.create({
      data: {
        tenantId,
        academicYearId: year.id,
        kind: 'ANNUAL',
        nameBn: 'বার্ষিক',
        nameEn: 'Annual',
        startsOn: new Date('2026-11-01'),
        endsOn: new Date('2026-11-20'),
        resultMode: 'GPA',
        meritOrder: ['GPA', 'TOTAL_MARKS', 'ROLL'],
        failedRanking: 'AFTER_PASSED',
        status: 'OPEN',
      },
    });
    const examClass = await tx.examClass.create({
      data: { tenantId, examId: exam.id, classLevelId: class9.id },
    });
    for (const st of [student!, other!]) {
      await tx.examCandidate.create({
        data: {
          tenantId,
          examId: exam.id,
          studentId: st.id,
          classLevelId: class9.id,
          sectionId: section.id,
        },
      });
    }
    const result = await tx.examResult.create({
      data: {
        tenantId,
        examId: exam.id,
        examClassId: examClass.id,
        classLevelId: class9.id,
        studentId: student!.id,
        sectionId: section.id,
        roll: 1,
        totalH: 75000,
        fullMarks: 1000,
        percentH: 7500,
        gpaH: 450,
        gpaWithoutOptionalH: 430,
        letter: 'A',
        passed: true,
        failedSubjects: 0,
        classPosition: 1,
        sectionPosition: 1,
        subjects: [],
        publishedVersion: 1,
      },
    });
    return {
      tenantId,
      class9Id: class9.id,
      sectionId: section.id,
      section10Id: section10.id,
      studentId: student!.id,
      otherId: other!.id,
      examId: exam.id,
      examClassId: examClass.id,
      resultId: result.id,
    };
  });
}

describe('exam results: tenant isolation and integrity', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
  const inB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);
  const result = (data: Record<string, unknown>) =>
    inA((tx) =>
      tx.examResult.create({
        data: {
          tenantId: a.tenantId,
          examId: a.examId,
          examClassId: a.examClassId,
          classLevelId: a.class9Id,
          studentId: a.otherId,
          sectionId: a.sectionId,
          totalH: 0,
          fullMarks: 100,
          percentH: 0,
          passed: false,
          failedSubjects: 1,
          subjects: [],
          publishedVersion: 1,
          ...data,
        },
      }),
    );

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app, 'COACHING');
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('own rows only; none without a context; another tenant cannot touch them', async () => {
    const rowsA = await inA((tx) => tx.examResult.findMany());
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    expect(await app.examResult.count()).toBe(0);
    expect(
      (
        await inB((tx) =>
          tx.examResult.updateMany({ where: { id: a.resultId }, data: { gpaH: 0 } }),
        )
      ).count,
    ).toBe(0);
    expect((await inB((tx) => tx.examResult.deleteMany({ where: { id: a.resultId } }))).count).toBe(
      0,
    );
    await expect(
      inB((tx) =>
        tx.examResult.create({
          data: {
            tenantId: b.tenantId,
            examId: a.examId,
            examClassId: a.examClassId,
            classLevelId: a.class9Id,
            studentId: a.otherId,
            sectionId: a.sectionId,
            totalH: 0,
            fullMarks: 1,
            percentH: 0,
            passed: false,
            failedSubjects: 0,
            subjects: [],
            publishedVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('a result is for a candidate of that class, in a section of that class; one per class', async () => {
    const stranger = await inA((tx) =>
      tx.student.create({
        data: { tenantId: a.tenantId, studentCode: `X-${randomUUID().slice(0, 6)}`, nameEn: 'X' },
      }),
    );
    await expect(result({ studentId: stranger.id })).rejects.toThrow(/foreign key/i);
    await expect(result({ sectionId: a.section10Id })).rejects.toThrow(/foreign key/i);
    await expect(result({ studentId: a.studentId })).rejects.toThrow(/unique/i);
  });

  it('CHECKs: positions, percent, GPA, counts, version, attendance', async () => {
    for (const [data, name] of [
      [{ classPosition: 0 }, 'exam_results_positions'],
      [{ sectionPosition: -1 }, 'exam_results_positions'],
      [{ percentH: 10_001 }, 'exam_results_marks'],
      [{ totalH: -1 }, 'exam_results_marks'],
      [{ gpaH: -1 }, 'exam_results_gpa'],
      [{ failedSubjects: -1 }, 'exam_results_marks'],
      [{ publishedVersion: 0 }, 'exam_results_version'],
      [{ attendancePresent: 3 }, 'exam_results_attendance'],
      [
        { attendancePresent: 5, attendanceTotal: 4, attendancePercentH: 10000 },
        'exam_results_attendance',
      ],
    ] as const) {
      await expect(result(data)).rejects.toThrow(new RegExp(name));
    }
    await result({ attendancePresent: 3, attendanceTotal: 4, attendancePercentH: 7500 });
  });
});
