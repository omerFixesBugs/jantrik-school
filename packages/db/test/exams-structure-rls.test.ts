import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** A tenant with one exam covering class 9: its class, subject, part, pass mark and a candidate. */
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
    const subject = await tx.subject.findFirstOrThrow({ where: { classLevelId: class9.id } });
    const subject10 = await tx.subject.findFirstOrThrow({ where: { classLevelId: class10.id } });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'S' },
    });
    const room = await tx.examRoom.create({ data: { tenantId, name: 'R1', rows: 5, cols: 4 } });
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
        meritOrder: ['GPA', 'TOTAL_MARKS', 'ROLL'],
        failedRanking: 'AFTER_PASSED',
      },
    });
    const otherExam = await tx.exam.create({
      data: {
        tenantId,
        academicYearId: year.id,
        kind: 'CLASS_TEST',
        nameBn: 'শ্রেণি পরীক্ষা',
        nameEn: 'Class test',
        startsOn: new Date('2026-07-01'),
        endsOn: new Date('2026-07-01'),
        resultMode: 'MARKS',
        meritOrder: ['TOTAL_MARKS'],
        failedRanking: 'UNRANKED',
      },
    });
    const examClass = await tx.examClass.create({
      data: { tenantId, examId: exam.id, classLevelId: class9.id },
    });
    const otherExamClass = await tx.examClass.create({
      data: { tenantId, examId: otherExam.id, classLevelId: class9.id },
    });
    const examSubject = await tx.examSubject.create({
      data: {
        tenantId,
        examId: exam.id,
        examClassId: examClass.id,
        classLevelId: class9.id,
        subjectId: subject.id,
        isElective: false,
        passRule: 'PER_COMPONENT',
        examDate: new Date('2026-06-02'),
        startTime: '10:00',
      },
    });
    const component = await tx.examSubjectComponent.create({
      data: {
        tenantId,
        examSubjectId: examSubject.id,
        key: 'CQ',
        kind: 'CQ',
        nameBn: 'সৃজনশীল',
        nameEn: 'CQ',
        fullMarks: 70,
        passMarks: 23,
      },
    });
    const passGroup = await tx.examSubjectPassGroup.create({
      data: { tenantId, examSubjectId: examSubject.id, kind: 'CQ', passMarks: 23 },
    });
    const candidate = await tx.examCandidate.create({
      data: {
        tenantId,
        examId: exam.id,
        studentId: student.id,
        classLevelId: class9.id,
        sectionId: section.id,
        roll: 1,
        roomId: room.id,
        seatNo: 1,
      },
    });
    return {
      tenantId,
      yearId: year.id,
      class9Id: class9.id,
      class10Id: class10.id,
      sectionId: section.id,
      section10Id: section10.id,
      subjectId: subject.id,
      subject10Id: subject10.id,
      studentId: student.id,
      roomId: room.id,
      examId: exam.id,
      otherExamId: otherExam.id,
      examClassId: examClass.id,
      otherExamClassId: otherExamClass.id,
      examSubjectId: examSubject.id,
      componentId: component.id,
      passGroupId: passGroup.id,
      candidateId: candidate.id,
    };
  });
}

const TABLES = [
  'exam',
  'examClass',
  'examSubject',
  'examSubjectComponent',
  'examSubjectPassGroup',
  'examCandidate',
] as const;
const TABLE_NAMES = [
  'exams',
  'exam_classes',
  'exam_subjects',
  'exam_subject_components',
  'exam_subject_pass_groups',
  'exam_candidates',
];

describe('exam structure tables: tenant isolation and integrity', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
  const inB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);

  /** A new candidate row for A's exam (a fresh student), with overrides. */
  const candidate = async (data: Record<string, unknown>) =>
    inA(async (tx) => {
      const student = await tx.student.create({
        data: { tenantId: a.tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'S' },
      });
      return tx.examCandidate.create({
        data: {
          tenantId: a.tenantId,
          examId: a.examId,
          studentId: student.id,
          classLevelId: a.class9Id,
          sectionId: a.sectionId,
          ...data,
        },
      });
    });

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
    expect((await rows(b.tenantId)).every((r) => r.tenantId === b.tenantId)).toBe(true);
  });

  it.each(TABLES)('%s: no context sees no rows', async (model) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (app[model] as any).count()).toBe(0);
  });

  it("another tenant cannot change, delete or write into A's rows", async () => {
    expect(
      (await inB((tx) => tx.exam.updateMany({ where: { id: a.examId }, data: { nameEn: 'x' } })))
        .count,
    ).toBe(0);
    expect(
      (await inB((tx) => tx.examSubjectComponent.deleteMany({ where: { id: a.componentId } })))
        .count,
    ).toBe(0);
    expect(
      (
        await inB((tx) =>
          tx.examCandidate.updateMany({ where: { id: a.candidateId }, data: { remarks: 'x' } }),
        )
      ).count,
    ).toBe(0);
    await expect(
      inB((tx) =>
        tx.examClass.create({
          data: { tenantId: a.tenantId, examId: a.examId, classLevelId: a.class10Id },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    for (const table of TABLE_NAMES) {
      await expect(
        inA((tx) => tx.$executeRawUnsafe(`UPDATE ${table} SET tenant_id = '${b.tenantId}'`)),
      ).rejects.toThrow(/row-level security|foreign key|permission denied/i);
    }
  });

  it("rows cannot point at another tenant's year, class, exam, subject, student or room", async () => {
    await expect(
      inB((tx) =>
        tx.exam.create({
          data: {
            tenantId: b.tenantId,
            academicYearId: a.yearId,
            kind: 'TEST',
            nameBn: 'x',
            nameEn: 'x',
            startsOn: new Date('2026-06-01'),
            endsOn: new Date('2026-06-01'),
            resultMode: 'GPA',
            meritOrder: ['GPA'],
            failedRanking: 'AFTER_PASSED',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      inB((tx) =>
        tx.examClass.create({
          data: { tenantId: b.tenantId, examId: a.examId, classLevelId: b.class9Id },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      inB((tx) =>
        tx.examSubjectComponent.create({
          data: {
            tenantId: b.tenantId,
            examSubjectId: a.examSubjectId,
            key: 'X',
            kind: 'OTHER',
            nameBn: 'x',
            nameEn: 'x',
            fullMarks: 1,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      inB(async (tx) => {
        const s = await tx.student.create({
          data: { tenantId: b.tenantId, studentCode: `B-${randomUUID().slice(0, 6)}`, nameEn: 'B' },
        });
        return tx.examCandidate.create({
          data: {
            tenantId: b.tenantId,
            examId: a.examId,
            studentId: s.id,
            classLevelId: b.class9Id,
            sectionId: b.sectionId,
          },
        });
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(candidate({ roomId: b.roomId, seatNo: 2 })).rejects.toThrow(/foreign key/i);
  });

  it("an exam subject belongs to its exam class's exam and class", async () => {
    const base = {
      tenantId: a.tenantId,
      isElective: false,
      passRule: 'PER_COMPONENT' as const,
    };
    // A class 10 subject in the class 9 exam class.
    await expect(
      inA((tx) =>
        tx.examSubject.create({
          data: {
            ...base,
            examId: a.examId,
            examClassId: a.examClassId,
            classLevelId: a.class9Id,
            subjectId: a.subject10Id,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    // Another exam's exam class.
    await expect(
      inA((tx) =>
        tx.examSubject.create({
          data: {
            ...base,
            examId: a.examId,
            examClassId: a.otherExamClassId,
            classLevelId: a.class9Id,
            subjectId: a.subjectId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('a candidate sits in a covered class, in a section of that class', async () => {
    // Class 10 is not covered by A's exam.
    await expect(
      candidate({ classLevelId: a.class10Id, sectionId: a.section10Id }),
    ).rejects.toThrow(/foreign key/i);
    // A class 10 section for a class 9 candidate.
    await expect(candidate({ sectionId: a.section10Id })).rejects.toThrow(/foreign key/i);
    // One row per student per exam; one student per seat.
    await expect(
      inA((tx) =>
        tx.examCandidate.create({
          data: {
            tenantId: a.tenantId,
            examId: a.examId,
            studentId: a.studentId,
            classLevelId: a.class9Id,
            sectionId: a.sectionId,
          },
        }),
      ),
    ).rejects.toThrow(/unique/i);
    await expect(candidate({ roomId: a.roomId, seatNo: 1 })).rejects.toThrow(/unique/i);
  });

  it('candidates are history: the app cannot delete them; an exam with candidates stays', async () => {
    await expect(inA((tx) => tx.$executeRawUnsafe('DELETE FROM exam_candidates'))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(inA((tx) => tx.exam.delete({ where: { id: a.examId } }))).rejects.toThrow(
      /foreign key/i,
    );
    // A room in use cannot be deleted either.
    await expect(inA((tx) => tx.examRoom.delete({ where: { id: a.roomId } }))).rejects.toThrow(
      /foreign key/i,
    );
    // An exam with no candidates goes with its classes.
    await inA((tx) => tx.exam.delete({ where: { id: a.otherExamId } }));
  });

  it('CHECKs: dates, attendance window, merit order, routine time, seats, roll, remarks', async () => {
    const exam = (data: Record<string, unknown>) =>
      inA((tx) =>
        tx.exam.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            kind: 'TEST',
            nameBn: 'x',
            nameEn: 'x',
            startsOn: new Date('2026-06-10'),
            endsOn: new Date('2026-06-12'),
            resultMode: 'GPA',
            meritOrder: ['GPA'],
            failedRanking: 'AFTER_PASSED',
            ...data,
          },
        }),
      );
    await expect(exam({ endsOn: new Date('2026-06-09') })).rejects.toThrow(/exams_dates/);
    await expect(exam({ attendanceFrom: new Date('2026-01-01') })).rejects.toThrow(
      /exams_attendance_window/,
    );
    await expect(
      exam({ attendanceFrom: new Date('2026-06-12'), attendanceTo: new Date('2026-01-01') }),
    ).rejects.toThrow(/exams_attendance_window/);
    await expect(exam({ meritOrder: [] })).rejects.toThrow(/exams_merit_order/);
    await expect(exam({ meritOrder: Array.from({ length: 9 }, () => 'GPA') })).rejects.toThrow(
      /exams_merit_order/,
    );
    await expect(exam({ nameBn: ' ' })).rejects.toThrow(/exams_names/);
    await expect(
      inA((tx) =>
        tx.examSubject.update({ where: { id: a.examSubjectId }, data: { startTime: '25:00' } }),
      ),
    ).rejects.toThrow(/exam_subjects_start_time/);
    await expect(candidate({ roomId: a.roomId })).rejects.toThrow(/exam_candidates_seat/);
    await expect(candidate({ seatNo: 3 })).rejects.toThrow(/exam_candidates_seat/);
    await expect(candidate({ roomId: a.roomId, seatNo: 0 })).rejects.toThrow(
      /exam_candidates_seat/,
    );
    await expect(candidate({ roll: 0 })).rejects.toThrow(/exam_candidates_roll/);
    await expect(candidate({ remarks: 'x'.repeat(301) })).rejects.toThrow(
      /exam_candidates_remarks/,
    );
    await expect(
      inA((tx) =>
        tx.examSubjectComponent.update({
          where: { id: a.componentId },
          data: { passMarks: 71 },
        }),
      ),
    ).rejects.toThrow(/exam_subject_components_marks/);
    await expect(
      inA((tx) =>
        tx.examSubjectPassGroup.update({ where: { id: a.passGroupId }, data: { passMarks: -1 } }),
      ),
    ).rejects.toThrow(/exam_subject_pass_groups_marks/);
  });
});
