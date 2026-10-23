import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** An open exam (class 9, two subjects, CQ 70 + MCQ 30 each), a candidate, a sheet and a mark. */
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
    const [subjectA, subjectB] = await tx.subject.findMany({
      where: { classLevelId: class9.id },
      orderBy: { sortOrder: 'asc' },
      take: 2,
    });
    const teacherId = await findOrCreateUser(tx, randomPhone(), 'Teacher');
    const student = await tx.student.create({
      data: { tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'S' },
    });
    const outsider = await tx.student.create({
      data: { tenantId, studentCode: `O-${randomUUID().slice(0, 8)}`, nameEn: 'O' },
    });
    const exam = await tx.exam.create({
      data: {
        tenantId,
        academicYearId: year.id,
        kind: 'HALF_YEARLY',
        nameBn: 'অর্ধবার্ষিক',
        nameEn: 'Half-yearly',
        startsOn: new Date('2026-06-01'),
        endsOn: new Date('2026-06-15'),
        resultMode: 'GPA',
        meritOrder: ['GPA'],
        failedRanking: 'AFTER_PASSED',
        status: 'OPEN',
      },
    });
    const examClass = await tx.examClass.create({
      data: { tenantId, examId: exam.id, classLevelId: class9.id },
    });
    const examSubject = async (subjectId: string) => {
      const es = await tx.examSubject.create({
        data: {
          tenantId,
          examId: exam.id,
          examClassId: examClass.id,
          classLevelId: class9.id,
          subjectId,
          isElective: false,
          passRule: 'PER_COMPONENT',
        },
      });
      const part = (key: 'CQ' | 'MCQ', fullMarks: number) =>
        tx.examSubjectComponent.create({
          data: {
            tenantId,
            examSubjectId: es.id,
            key,
            kind: key,
            nameBn: key,
            nameEn: key,
            fullMarks,
            passMarks: Math.round(fullMarks * 0.33),
          },
        });
      return { id: es.id, cq: (await part('CQ', 70)).id, mcq: (await part('MCQ', 30)).id };
    };
    const esA = await examSubject(subjectA!.id);
    const esB = await examSubject(subjectB!.id);
    await tx.examCandidate.create({
      data: {
        tenantId,
        examId: exam.id,
        studentId: student.id,
        classLevelId: class9.id,
        sectionId: section.id,
      },
    });
    const sheet = await tx.examMarkSheet.create({
      data: {
        tenantId,
        examId: exam.id,
        examSubjectId: esA.id,
        classLevelId: class9.id,
        sectionId: section.id,
        updatedById: teacherId,
      },
    });
    const mark = await tx.examMark.create({
      data: {
        tenantId,
        examId: exam.id,
        examSubjectId: esA.id,
        componentId: esA.cq,
        studentId: student.id,
        scoreH: 5650,
        updatedById: teacherId,
      },
    });
    return {
      tenantId,
      class9Id: class9.id,
      sectionId: section.id,
      section10Id: section10.id,
      teacherId,
      studentId: student.id,
      outsiderId: outsider.id,
      examId: exam.id,
      esA,
      esB,
      sheetId: sheet.id,
      markId: mark.id,
    };
  });
}

describe('mark sheets and marks: tenant isolation, history and integrity', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
  const inB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);
  const mark = (data: Record<string, unknown>) =>
    inA((tx) =>
      tx.examMark.create({
        data: {
          tenantId: a.tenantId,
          examId: a.examId,
          examSubjectId: a.esA.id,
          componentId: a.esA.mcq,
          studentId: a.studentId,
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

  it.each(['examMarkSheet', 'examMark'] as const)(
    '%s: own rows only; none without a context',
    async (model) => {
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
    },
  );

  it("another tenant cannot read, change or write A's marks", async () => {
    expect(
      (await inB((tx) => tx.examMark.updateMany({ where: { id: a.markId }, data: { scoreH: 0 } })))
        .count,
    ).toBe(0);
    expect(
      (
        await inB((tx) =>
          tx.examMarkSheet.updateMany({ where: { id: a.sheetId }, data: { version: 9 } }),
        )
      ).count,
    ).toBe(0);
    await expect(
      inB((tx) =>
        tx.examMark.create({
          data: {
            tenantId: a.tenantId,
            examId: a.examId,
            examSubjectId: a.esA.id,
            componentId: a.esA.mcq,
            studentId: a.studentId,
            scoreH: 1,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      inB((tx) =>
        tx.examMark.create({
          data: {
            tenantId: b.tenantId,
            examId: a.examId,
            examSubjectId: a.esA.id,
            componentId: a.esA.mcq,
            studentId: a.studentId,
            scoreH: 1,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a mark's part belongs to its subject; its student sits the exam", async () => {
    await expect(mark({ componentId: a.esB.cq })).rejects.toThrow(/foreign key/i);
    await expect(mark({ studentId: a.outsiderId })).rejects.toThrow(/foreign key/i);
    await expect(
      inA((tx) =>
        tx.examMarkSheet.create({
          data: {
            tenantId: a.tenantId,
            examId: a.examId,
            examSubjectId: a.esB.id,
            classLevelId: a.class9Id,
            sectionId: a.section10Id,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(mark({ componentId: a.esA.cq })).rejects.toThrow(/unique/i);
  });

  it('marks stay within the full marks; absent has no score; never negative', async () => {
    await expect(mark({ scoreH: 3001 })).rejects.toThrow(/exam_marks_score_within_full/);
    await expect(
      inA((tx) => tx.examMark.update({ where: { id: a.markId }, data: { scoreH: 7001 } })),
    ).rejects.toThrow(/exam_marks_score_within_full/);
    await expect(mark({ scoreH: 10, absent: true })).rejects.toThrow(/exam_marks_absent/);
    await expect(mark({ scoreH: -1 })).rejects.toThrow(/exam_marks_score/);
    // Full marks exactly, and absent without a score, are fine.
    await inA((tx) => tx.examMark.update({ where: { id: a.markId }, data: { scoreH: 7000 } }));
    await mark({ absent: true });
  });

  it('marks and sheets are history: no DELETE, keys never rewritten', async () => {
    for (const table of ['exam_marks', 'exam_mark_sheets']) {
      await expect(inA((tx) => tx.$executeRawUnsafe(`DELETE FROM ${table}`))).rejects.toThrow(
        /permission denied/i,
      );
    }
    for (const sql of [
      `UPDATE exam_marks SET student_id = '${a.outsiderId}'`,
      `UPDATE exam_marks SET component_id = '${a.esA.mcq}'`,
      `UPDATE exam_marks SET exam_subject_id = '${a.esB.id}'`,
      `UPDATE exam_mark_sheets SET section_id = '${a.section10Id}'`,
      `UPDATE exam_mark_sheets SET exam_subject_id = '${a.esB.id}'`,
    ]) {
      await expect(inA((tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(/permission denied/i);
    }
    // A part or subject with marks cannot be removed from the exam.
    await expect(
      inA((tx) => tx.examSubjectComponent.delete({ where: { id: a.esA.cq } })),
    ).rejects.toThrow(/foreign key/i);
    await expect(inA((tx) => tx.examSubject.delete({ where: { id: a.esA.id } }))).rejects.toThrow(
      /foreign key/i,
    );
  });

  it('a submitted or locked sheet records who and when', async () => {
    await expect(
      inA((tx) =>
        tx.examMarkSheet.update({ where: { id: a.sheetId }, data: { status: 'SUBMITTED' } }),
      ),
    ).rejects.toThrow(/exam_mark_sheets_status/);
    await expect(
      inA((tx) =>
        tx.examMarkSheet.update({ where: { id: a.sheetId }, data: { status: 'LOCKED' } }),
      ),
    ).rejects.toThrow(/exam_mark_sheets_status/);
    await inA((tx) =>
      tx.examMarkSheet.update({
        where: { id: a.sheetId },
        data: {
          status: 'LOCKED',
          lockedAt: new Date(),
          lockedById: a.teacherId,
          submittedAt: new Date(),
          submittedById: a.teacherId,
          version: { increment: 1 },
        },
      }),
    );
  });
});
