import {
  computeClassResults,
  normalizeBdPhone,
  type GradeBand,
  type MarkEntry,
  type MeritKey,
} from '@jantrik/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { TenantTx } from '../tenancy/context.js';

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
const phone = (raw: string) => normalizeBdPhone(raw)!;

/** The routine's nth day from the exam's first, never a Friday (the demo's weekly holiday). */
function routineDay(startsOn: string, nth: number): Date {
  const d = date(startsOn);
  for (let left = nth; ; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 5) continue;
    if (left === 0) return d;
    left -= 1;
  }
}

export interface ExamSeedContext {
  tenantId: string;
  userIdByPhone: Map<string, string>;
}

/** What a demo student scores in one part: a share of the full marks, or absent. */
type Score = (
  s: { code: string; roll: number | null; nameEn: string | null },
  subject: string,
  part: string,
) => number | 'ABSENT';

/**
 * Shapla school (step 10): subject teachers, Tahmid's 4th subject, a published half-yearly with
 * deterministic marks (a component fail, an absent paper, a capped 5.00 with the 4th-subject bonus,
 * a Bangla pass only under the combined rule, remarks), and an open annual exam whose 6 ক Bangla and
 * 9 ক English sheets are left empty for the walkthrough and Playwright; every other sheet is locked.
 * Two rooms and a seat plan for the annual exam.
 */
export async function seedShaplaExams(tx: TenantTx, ctx: ExamSeedContext): Promise<void> {
  const { tenantId } = ctx;
  const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
  const level = async (code: string) => tx.classLevel.findFirstOrThrow({ where: { code } });
  const class6 = await level('CLASS_6');
  const class9 = await level('CLASS_9');
  const section = (classLevelId: string, name: string) =>
    tx.section.findFirstOrThrow({ where: { classLevelId, name, academicYearId: year.id } });
  const six = await section(class6.id, 'ক');
  const nine = await section(class9.id, 'ক');
  const subjectId = async (classLevelId: string, code: string) =>
    (await tx.subject.findFirstOrThrow({ where: { classLevelId, code } })).id;
  const nasrin = ctx.userIdByPhone.get(phone('01711000002'))!;
  const sharmin = ctx.userIdByPhone.get(phone('01911000999'))!;

  // Subject teachers: Nasrin takes Bangla and Maths in 6 ক; Sharmin every subject of 9 ক.
  for (const code of ['BAN', 'MATH']) {
    await tx.sectionSubjectTeacher.create({
      data: {
        tenantId,
        sectionId: six.id,
        subjectId: await subjectId(class6.id, code),
        classLevelId: class6.id,
        userId: nasrin,
      },
    });
  }
  for (const s of await tx.subject.findMany({
    where: { classLevelId: class9.id, isActive: true },
  })) {
    await tx.sectionSubjectTeacher.create({
      data: {
        tenantId,
        sectionId: nine.id,
        subjectId: s.id,
        classLevelId: class9.id,
        userId: sharmin,
      },
    });
  }

  // Tahmid (Science): Biology compulsory, Higher Maths as the 4th subject.
  const tahmid = await tx.student.findFirstOrThrow({ where: { nameEn: 'Tahmid Rahman' } });
  await tx.studentSubjectChoice.createMany({
    data: [
      {
        tenantId,
        academicYearId: year.id,
        studentId: tahmid.id,
        subjectId: await subjectId(class9.id, 'BIO'),
        kind: 'COMPULSORY',
      },
      {
        tenantId,
        academicYearId: year.id,
        studentId: tahmid.id,
        subjectId: await subjectId(class9.id, 'HMATH'),
        kind: 'OPTIONAL',
      },
    ],
  });

  const score: Score = (st, subject, part) => {
    if (st.nameEn === 'Tasnim Rahman') return 0.88;
    if (st.nameEn === 'Tahmid Rahman') return subject === 'HMATH' ? 0.9 : 0.85;
    // Rafi: Bangla passes only because both papers' CQ are counted together (20 + 26 = 46).
    if (st.nameEn === 'Rafi Ahmed' && subject === 'BAN') {
      return (
        (
          { P1_CQ: 20 / 70, P2_CQ: 26 / 70, P1_MCQ: 10 / 30, P2_MCQ: 10 / 30 } as Record<
            string,
            number
          >
        )[part] ?? 0.5
      );
    }
    const roll = st.roll ?? 1;
    if (roll === 5 && subject === 'MATH' && part === 'MCQ') return 8 / 30; // fails the MCQ part
    if (roll === 7 && subject === 'SCI') return 'ABSENT';
    return Math.min(0.95, 0.42 + ((roll * 37 + subject.length * 11 + part.length * 3) % 50) / 100);
  };

  const half = await createExam(tx, ctx, {
    academicYearId: year.id,
    kind: 'HALF_YEARLY',
    nameBn: 'অর্ধবার্ষিক পরীক্ষা ২০২৬',
    nameEn: 'Half-yearly exam 2026',
    startsOn: '2026-06-01',
    endsOn: '2026-06-15',
    resultMode: 'GPA',
    classLevelIds: [class6.id, class9.id],
    lockedBy: ctx.userIdByPhone.get(phone('01711000003'))!,
    score,
    leaveEmpty: [],
  });
  await tx.examCandidate.updateMany({
    where: {
      examId: half.examId,
      studentId: (await tx.student.findFirstOrThrow({ where: { nameEn: 'Tasnim Rahman' } })).id,
    },
    data: {
      remarks: 'খুব ভালো ফল। এভাবে চালিয়ে যাও।',
      remarksById: nasrin,
      remarksAt: new Date(),
    },
  });
  for (const examClassId of half.examClassIds) await publish(tx, ctx, examClassId);

  const annual = await createExam(tx, ctx, {
    academicYearId: year.id,
    kind: 'ANNUAL',
    nameBn: 'বার্ষিক পরীক্ষা ২০২৬',
    nameEn: 'Annual exam 2026',
    startsOn: '2026-11-01',
    endsOn: '2026-11-20',
    resultMode: 'GPA',
    classLevelIds: [class6.id, class9.id],
    lockedBy: ctx.userIdByPhone.get(phone('01711000003'))!,
    score: (st, subject, part) => {
      const s = score(st, subject, part);
      return s === 'ABSENT' ? 0.4 : Math.min(0.95, s + 0.03);
    },
    // Entered in the walkthrough and Playwright: Nasrin (bn) and Sharmin (en).
    leaveEmpty: [
      { sectionId: six.id, subjectCode: 'BAN' },
      { sectionId: nine.id, subjectCode: 'ENG' },
    ],
  });

  // Rooms and the annual exam's seat plan (classes alternate seat by seat).
  const rooms = [
    await tx.examRoom.create({
      data: { tenantId, name: 'কক্ষ ১০১', rows: 6, cols: 5, sortOrder: 0 },
    }),
    await tx.examRoom.create({
      data: { tenantId, name: 'কক্ষ ১০২', rows: 5, cols: 4, sortOrder: 1 },
    }),
  ];
  const candidates = await tx.examCandidate.findMany({
    where: { examId: annual.examId, status: 'ENROLLED' },
    orderBy: [{ roll: 'asc' }],
    select: { id: true, classLevelId: true },
  });
  const queues = [class6.id, class9.id].map((cl) =>
    candidates.filter((c) => c.classLevelId === cl),
  );
  const order: string[] = [];
  while (queues.some((q) => q.length > 0))
    for (const q of queues) if (q.length) order.push(q.shift()!.id);
  let i = 0;
  for (const room of rooms) {
    for (let seat = 1; seat <= room.rows * room.cols && i < order.length; seat++, i++) {
      await tx.examCandidate.update({
        where: { id: order[i]! },
        data: { roomId: room.id, seatNo: seat },
      });
    }
  }
}

/**
 * Alo coaching (step 10): Maths and Physics get parts (MCQ 25 + written 25), and a published
 * MARKS-mode model test for the SSC batch where Sakib and Nusrat tie on marks (the lower roll
 * takes the higher place).
 */
export async function seedAloExams(tx: TenantTx, ctx: ExamSeedContext): Promise<void> {
  const { tenantId } = ctx;
  const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
  const class10 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_10' } });
  const subjects = await tx.subject.findMany({
    where: { classLevelId: class10.id, code: { in: ['MATH', 'PHY'] } },
  });
  for (const s of subjects) {
    await tx.subjectComponent.createMany({
      data: [
        {
          tenantId,
          subjectId: s.id,
          key: 'MCQ',
          kind: 'MCQ',
          nameBn: 'বহুনির্বাচনি',
          nameEn: 'MCQ',
          fullMarks: 25,
          passMarks: 8,
          sortOrder: 0,
        },
        {
          tenantId,
          subjectId: s.id,
          key: 'WRITTEN',
          kind: 'WRITTEN',
          nameBn: 'লিখিত',
          nameEn: 'Written',
          fullMarks: 25,
          passMarks: 8,
          sortOrder: 1,
        },
      ],
    });
  }
  const test = await createExam(tx, ctx, {
    academicYearId: year.id,
    kind: 'MODEL_TEST',
    nameBn: 'মডেল টেস্ট ১',
    nameEn: 'Model test 1',
    startsOn: '2026-09-10',
    endsOn: '2026-09-10',
    resultMode: 'MARKS',
    classLevelIds: [class10.id],
    subjectIds: subjects.map((s) => s.id),
    lockedBy: ctx.userIdByPhone.get(phone('01511000001'))!,
    score: (st) => (st.nameEn === 'Sakib Hossain' || st.nameEn === 'Nusrat Jahan' ? 0.8 : 0.6),
    leaveEmpty: [],
  });
  for (const examClassId of test.examClassIds) await publish(tx, ctx, examClassId);
}

// ─────────────────────────── Helpers ───────────────────────────

async function createExam(
  tx: TenantTx,
  ctx: ExamSeedContext,
  def: {
    academicYearId: string;
    kind: 'HALF_YEARLY' | 'ANNUAL' | 'MODEL_TEST';
    nameBn: string;
    nameEn: string;
    startsOn: string;
    endsOn: string;
    resultMode: 'GPA' | 'MARKS';
    classLevelIds: string[];
    /** Only these subjects (default: every active subject of the class). */
    subjectIds?: string[];
    lockedBy: string;
    score: Score;
    leaveEmpty: { sectionId: string; subjectCode: string }[];
  },
): Promise<{ examId: string; examClassIds: string[] }> {
  const { tenantId } = ctx;
  const exam = await tx.exam.create({
    data: {
      tenantId,
      academicYearId: def.academicYearId,
      kind: def.kind,
      nameBn: def.nameBn,
      nameEn: def.nameEn,
      startsOn: date(def.startsOn),
      endsOn: date(def.endsOn),
      resultMode: def.resultMode,
      meritOrder:
        def.resultMode === 'GPA' ? ['GPA', 'TOTAL_MARKS', 'ROLL'] : ['TOTAL_MARKS', 'ROLL'],
      failedRanking: 'AFTER_PASSED',
      // The half-yearly's term has no attendance in the demo (past registers are recent).
      attendanceFrom: def.kind === 'ANNUAL' ? date('2026-06-16') : null,
      attendanceTo: def.kind === 'ANNUAL' ? date(def.endsOn) : null,
      status: 'OPEN',
    },
  });
  const examClassIds: string[] = [];
  const now = new Date();
  for (const classLevelId of def.classLevelIds) {
    const examClass = await tx.examClass.create({
      data: { tenantId, examId: exam.id, classLevelId },
    });
    examClassIds.push(examClass.id);
    const subjects = await tx.subject.findMany({
      where: {
        classLevelId,
        isActive: true,
        ...(def.subjectIds ? { id: { in: def.subjectIds } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { components: { orderBy: { sortOrder: 'asc' } }, passGroups: true },
    });
    const enrolments = await tx.enrolment.findMany({
      where: {
        academicYearId: def.academicYearId,
        classLevelId,
        sectionId: { not: null },
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      include: { student: { select: { studentCode: true, nameEn: true } } },
    });
    await tx.examCandidate.createMany({
      data: enrolments.map((e) => ({
        tenantId,
        examId: exam.id,
        studentId: e.studentId,
        classLevelId,
        sectionId: e.sectionId!,
        studyGroupId: e.studyGroupId,
        roll: e.roll,
      })),
    });
    const choices = await tx.studentSubjectChoice.findMany({
      where: {
        academicYearId: def.academicYearId,
        studentId: { in: enrolments.map((e) => e.studentId) },
      },
    });
    for (const [order, s] of subjects.entries()) {
      const es = await tx.examSubject.create({
        data: {
          tenantId,
          examId: exam.id,
          examClassId: examClass.id,
          classLevelId,
          subjectId: s.id,
          studyGroupId: s.studyGroupId,
          isElective: s.isOptional,
          passRule: s.passRule,
          sortOrder: order,
          examDate: routineDay(def.startsOn, Math.floor(order / 2)),
          startTime: order % 2 === 0 ? '10:00' : '14:00',
        },
      });
      const components: { id: string; key: string; fullMarks: number }[] = [];
      for (const c of s.components) {
        components.push(
          await tx.examSubjectComponent.create({
            data: {
              tenantId,
              examSubjectId: es.id,
              key: c.key,
              kind: c.kind,
              nameBn: c.nameBn,
              nameEn: c.nameEn,
              fullMarks: c.fullMarks,
              passMarks: c.passMarks,
              sortOrder: c.sortOrder,
            },
          }),
        );
      }
      await tx.examSubjectPassGroup.createMany({
        data: s.passGroups.map((g) => ({
          tenantId,
          examSubjectId: es.id,
          kind: g.kind,
          passMarks: g.passMarks,
        })),
      });
      const takers = enrolments.filter(
        (e) =>
          (s.studyGroupId === null || s.studyGroupId === e.studyGroupId) &&
          (!s.isOptional ||
            choices.some((c) => c.studentId === e.studentId && c.subjectId === s.id)),
      );
      for (const sectionId of new Set(takers.map((t) => t.sectionId!))) {
        if (def.leaveEmpty.some((x) => x.sectionId === sectionId && x.subjectCode === s.code))
          continue;
        await tx.examMarkSheet.create({
          data: {
            tenantId,
            examId: exam.id,
            examSubjectId: es.id,
            classLevelId,
            sectionId,
            status: 'LOCKED',
            version: 2,
            updatedById: def.lockedBy,
            submittedById: def.lockedBy,
            submittedAt: now,
            lockedById: def.lockedBy,
            lockedAt: now,
          },
        });
        await tx.examMark.createMany({
          data: takers
            .filter((t) => t.sectionId === sectionId)
            .flatMap((t) =>
              components.map((c) => {
                const share = def.score(
                  { code: t.student.studentCode, roll: t.roll, nameEn: t.student.nameEn },
                  s.code,
                  c.key,
                );
                return {
                  tenantId,
                  examId: exam.id,
                  examSubjectId: es.id,
                  componentId: c.id,
                  studentId: t.studentId,
                  scoreH: share === 'ABSENT' ? null : Math.round(c.fullMarks * share) * 100,
                  absent: share === 'ABSENT',
                  updatedById: def.lockedBy,
                };
              }),
            ),
        });
      }
    }
  }
  return { examId: exam.id, examClassIds };
}

/** The publish step (as ExamResultsService.publish does) for the demo: the snapshot rows. */
async function publish(tx: TenantTx, ctx: ExamSeedContext, examClassId: string): Promise<void> {
  const examClass = await tx.examClass.findUniqueOrThrow({
    where: { id: examClassId },
    include: { exam: true, classLevel: true },
  });
  const scheme = await tx.gradingScheme.findFirstOrThrow({
    where: examClass.classLevel.gradingSchemeId
      ? { id: examClass.classLevel.gradingSchemeId }
      : { isDefault: true },
    include: { bands: { orderBy: { minPercent: 'desc' } } },
  });
  const bands: GradeBand[] = scheme.bands.map((b) => ({
    minPercent: b.minPercent.toNumber(),
    letter: b.letter,
    gradePoint: b.gradePoint.toNumber(),
  }));
  const rules = {
    gpaMax: scheme.gpaMax.toNumber(),
    optionalBonusAbove: scheme.optionalBonusAbove?.toNumber() ?? null,
    gpaDecimals: scheme.gpaDecimals,
    gpaRounding: scheme.gpaRounding,
    compulsoryFailZero: scheme.compulsoryFailZero,
  };
  const subjects = await tx.examSubject.findMany({
    where: { examClassId },
    orderBy: { sortOrder: 'asc' },
    include: { components: { orderBy: { sortOrder: 'asc' } }, passGroups: true },
  });
  const candidates = await tx.examCandidate.findMany({
    where: { examId: examClass.examId, classLevelId: examClass.classLevelId, status: 'ENROLLED' },
  });
  const choices = await tx.studentSubjectChoice.findMany({
    where: {
      academicYearId: examClass.exam.academicYearId,
      studentId: { in: candidates.map((c) => c.studentId) },
    },
  });
  const rows = await tx.examMark.findMany({
    where: { examSubjectId: { in: subjects.map((s) => s.id) } },
    include: { component: { select: { key: true } } },
  });
  const marks = new Map<string, Record<string, MarkEntry>>();
  for (const m of rows) {
    const k = `${m.examSubjectId}:${m.studentId}`;
    marks.set(k, {
      ...(marks.get(k) ?? {}),
      [m.component.key]: { scoreH: m.scoreH, absent: m.absent },
    });
  }
  const outcome = computeClassResults({
    mode: examClass.exam.resultMode,
    bands,
    roundingMode: scheme.roundingMode,
    rules,
    meritOrder: examClass.exam.meritOrder as MeritKey[],
    failedRanking: examClass.exam.failedRanking,
    subjects: subjects.map((s) => ({
      examSubjectId: s.id,
      subjectId: s.subjectId,
      studyGroupId: s.studyGroupId,
      isElective: s.isElective,
      passRule: s.passRule,
      components: s.components.map((c) => ({
        key: c.key,
        kind: c.kind,
        fullMarks: c.fullMarks,
        passMarks: c.passMarks,
      })),
      passGroups: s.passGroups.map((g) => ({ kind: g.kind, passMarks: g.passMarks })),
    })),
    candidates: candidates.map((c) => ({
      studentId: c.studentId,
      sectionId: c.sectionId,
      roll: c.roll,
      studyGroupId: c.studyGroupId,
      choices: choices
        .filter((x) => x.studentId === c.studentId)
        .map((x) => ({ subjectId: x.subjectId, kind: x.kind })),
    })),
    marks,
  });
  const remarks = new Map(candidates.map((c) => [c.studentId, c.remarks]));
  await tx.examResult.createMany({
    data: outcome.students.map((s) => ({
      tenantId: ctx.tenantId,
      examId: examClass.examId,
      examClassId,
      classLevelId: examClass.classLevelId,
      studentId: s.studentId,
      sectionId: s.sectionId,
      roll: s.roll,
      totalH: s.result.totalH,
      fullMarks: s.result.fullMarks,
      percentH: s.result.percentH,
      gpaH: s.result.gpaH,
      gpaWithoutOptionalH: s.result.gpaWithoutOptionalH,
      letter: s.result.letter,
      passed: s.result.passed,
      failedSubjects: s.result.failedSubjects,
      classPosition: s.classPosition,
      sectionPosition: s.sectionPosition,
      remarks: remarks.get(s.studentId) ?? null,
      subjects: s.subjects.map((x) => ({
        examSubjectId: x.examSubjectId,
        subjectId: x.subjectId,
        optional: x.optional,
        status: x.result.status,
        obtainedH: x.result.obtainedH,
        fullMarks: x.result.fullMarks,
        letter: x.result.letter,
        gradePoint: x.result.gradePoint,
        passed: x.result.passed,
        marks: x.marks,
      })) as unknown as Prisma.InputJsonValue,
      publishedVersion: 1,
    })),
  });
  await tx.examClass.update({
    where: { id: examClassId },
    data: {
      isPublished: true,
      publishedVersion: 1,
      publishedAt: new Date(),
      gradingSnapshot: {
        schemeId: scheme.id,
        roundingMode: scheme.roundingMode,
        bands: scheme.bands.map((b) => ({
          minPercent: b.minPercent.toNumber(),
          maxPercent: b.maxPercent.toNumber(),
          letter: b.letter,
          gradePoint: b.gradePoint.toNumber(),
        })),
        rules,
      },
      subjectStats: outcome.subjectStats as unknown as Prisma.InputJsonValue,
    },
  });
}
