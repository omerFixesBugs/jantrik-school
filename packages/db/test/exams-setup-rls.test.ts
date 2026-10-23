import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** A tenant with one of every exam setup row (step 10, phase A), in class 9. */
async function school(app: PrismaClient, instituteTypeKey = 'NCTB_SCHOOL_BN') {
  const tenant = await createTenant(app, { instituteTypeKey });
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const class9 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } });
    const otherClass = await tx.classLevel.findFirstOrThrow({
      where: { code: { not: 'CLASS_9' } },
      orderBy: { sortOrder: 'asc' },
    });
    const section = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: class9.id, name: 'A' },
    });
    const subject = await tx.subject.findFirstOrThrow({
      where: { classLevelId: class9.id },
      orderBy: { sortOrder: 'asc' },
    });
    const otherClassSubject = await tx.subject.create({
      data: { tenantId, classLevelId: otherClass.id, code: 'X', nameBn: 'x', nameEn: 'x' },
    });
    const teacherId = await findOrCreateUser(tx, randomPhone(), 'Teacher');
    await tx.membership.create({ data: { tenantId, userId: teacherId, role: 'TEACHER' } });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'S' },
    });
    const unenrolled = await tx.student.create({
      data: { tenantId, studentCode: `U-${randomUUID().slice(0, 8)}`, nameEn: 'U' },
    });
    await tx.enrolment.create({
      data: {
        tenantId,
        studentId: student.id,
        academicYearId: year.id,
        classLevelId: class9.id,
        sectionId: section.id,
        roll: 1,
      },
    });
    const component = await tx.subjectComponent.create({
      data: {
        tenantId,
        subjectId: subject.id,
        key: 'ORAL',
        kind: 'ORAL',
        nameBn: 'মৌখিক',
        nameEn: 'Oral',
        fullMarks: 10,
        passMarks: 3,
      },
    });
    const passGroup = await tx.subjectPassGroup.create({
      data: { tenantId, subjectId: subject.id, kind: 'ORAL', passMarks: 3 },
    });
    const assignment = await tx.sectionSubjectTeacher.create({
      data: {
        tenantId,
        sectionId: section.id,
        subjectId: subject.id,
        classLevelId: class9.id,
        userId: teacherId,
      },
    });
    const choice = await tx.studentSubjectChoice.create({
      data: {
        tenantId,
        academicYearId: year.id,
        studentId: student.id,
        subjectId: subject.id,
        kind: 'OPTIONAL',
      },
    });
    const room = await tx.examRoom.create({
      data: { tenantId, name: 'Room 101', rows: 6, cols: 5 },
    });
    return {
      tenantId,
      yearId: year.id,
      class9Id: class9.id,
      sectionId: section.id,
      subjectId: subject.id,
      otherClassSubjectId: otherClassSubject.id,
      teacherId,
      studentId: student.id,
      unenrolledId: unenrolled.id,
      componentId: component.id,
      passGroupId: passGroup.id,
      assignmentId: assignment.id,
      choiceId: choice.id,
      roomId: room.id,
    };
  });
}

const TABLES = [
  'subjectComponent',
  'subjectPassGroup',
  'sectionSubjectTeacher',
  'studentSubjectChoice',
  'examRoom',
] as const;

describe('exam setup tables: tenant isolation', () => {
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

  it.each(TABLES)('%s: no context sees no rows', async (model) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (app[model] as any).count()).toBe(0);
  });

  it("another tenant cannot change, delete or write into A's rows", async () => {
    const changed = await withTenant(app, b.tenantId, (tx) =>
      tx.subjectComponent.updateMany({ where: { id: a.componentId }, data: { fullMarks: 99 } }),
    );
    expect(changed.count).toBe(0);
    for (const del of [
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.sectionSubjectTeacher.deleteMany({ where: { id: a.assignmentId } }),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.studentSubjectChoice.deleteMany({ where: { id: a.choiceId } }),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.examRoom.deleteMany({ where: { id: a.roomId } }),
    ]) {
      expect((await withTenant(app, b.tenantId, del)).count).toBe(0);
    }
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.examRoom.create({ data: { tenantId: a.tenantId, name: 'x', rows: 1, cols: 1 } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("rows cannot point at another tenant's subject, section or enrolment", async () => {
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.subjectComponent.create({
          data: {
            tenantId: b.tenantId,
            subjectId: a.subjectId,
            key: 'CQ',
            kind: 'CQ',
            nameBn: 'x',
            nameEn: 'x',
            fullMarks: 10,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.subjectPassGroup.create({
          data: { tenantId: b.tenantId, subjectId: a.subjectId, kind: 'CQ', passMarks: 1 },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.sectionSubjectTeacher.create({
          data: {
            tenantId: b.tenantId,
            sectionId: a.sectionId,
            subjectId: b.subjectId,
            classLevelId: b.class9Id,
            userId: b.teacherId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.studentSubjectChoice.create({
          data: {
            tenantId: b.tenantId,
            academicYearId: a.yearId,
            studentId: a.studentId,
            subjectId: b.subjectId,
            kind: 'COMPULSORY',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a subject teacher's subject must belong to the section's class", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.sectionSubjectTeacher.create({
          data: {
            tenantId: a.tenantId,
            sectionId: a.sectionId,
            subjectId: a.otherClassSubjectId,
            classLevelId: a.class9Id,
            userId: a.teacherId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('a subject choice needs an enrolment in that year; at most one 4th subject', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.studentSubjectChoice.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            studentId: a.unenrolledId,
            subjectId: a.subjectId,
            kind: 'COMPULSORY',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    const other = await withTenant(app, a.tenantId, (tx) =>
      tx.subject.findFirstOrThrow({
        where: { classLevelId: a.class9Id, id: { not: a.subjectId } },
      }),
    );
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.studentSubjectChoice.create({
          data: {
            tenantId: a.tenantId,
            academicYearId: a.yearId,
            studentId: a.studentId,
            subjectId: other.id,
            kind: 'OPTIONAL',
          },
        }),
      ),
    ).rejects.toThrow(/unique/i);
    // A second choice as compulsory is fine.
    await withTenant(app, a.tenantId, (tx) =>
      tx.studentSubjectChoice.create({
        data: {
          tenantId: a.tenantId,
          academicYearId: a.yearId,
          studentId: a.studentId,
          subjectId: other.id,
          kind: 'COMPULSORY',
        },
      }),
    );
  });

  it('CHECKs: component key and marks, pass group marks, room size', async () => {
    const component = (data: { key?: string; fullMarks?: number; passMarks?: number | null }) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.subjectComponent.create({
          data: {
            tenantId: a.tenantId,
            subjectId: a.subjectId,
            key:
              data.key ??
              `K${randomUUID()
                .slice(0, 4)
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, 'X')}`,
            kind: 'OTHER',
            nameBn: 'x',
            nameEn: 'x',
            fullMarks: data.fullMarks ?? 10,
            passMarks: data.passMarks ?? null,
          },
        }),
      );
    await expect(component({ key: 'cq' })).rejects.toThrow(/subject_components_key_format/);
    await expect(component({ fullMarks: 0 })).rejects.toThrow(/subject_components_marks/);
    await expect(component({ fullMarks: 10, passMarks: 11 })).rejects.toThrow(
      /subject_components_marks/,
    );
    await expect(component({ passMarks: -1 })).rejects.toThrow(/subject_components_marks/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.subjectPassGroup.create({
          data: { tenantId: a.tenantId, subjectId: a.subjectId, kind: 'CQ', passMarks: -1 },
        }),
      ),
    ).rejects.toThrow(/subject_pass_groups_marks/);
    for (const [rows, cols] of [
      [0, 5],
      [5, 0],
      [25, 21],
    ] as const) {
      await expect(
        withTenant(app, a.tenantId, (tx) =>
          tx.examRoom.create({
            data: { tenantId: a.tenantId, name: `R-${randomUUID()}`, rows, cols },
          }),
        ),
      ).rejects.toThrow(/exam_rooms_size/);
    }
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.examRoom.create({ data: { tenantId: a.tenantId, name: ' ', rows: 1, cols: 1 } }),
      ),
    ).rejects.toThrow(/exam_rooms_name/);
  });
});
