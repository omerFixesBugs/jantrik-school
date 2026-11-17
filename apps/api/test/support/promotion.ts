import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { withTenant, type TenantTx } from '@jantrik/db';
import type { Queue } from 'bullmq';
import { PROMOTIONS_QUEUE } from '../../src/promotion/promotion-apply.service.js';
import { addMember, createTenant, otpLogin, type Harness } from './harness.js';

export interface PromoStudent {
  id: string;
  code: string;
  roll: number;
  enrolmentId: string;
}

export interface PromotionSchool {
  tenantId: string;
  y2026: string;
  y2027: string;
  /** Class level ids by number (6–10). */
  classes: Record<6 | 7 | 8 | 9 | 10, string>;
  /** Section ids: [year][class]['ক' | 'খ']. */
  sections: Record<2026 | 2027, Record<6 | 7 | 8 | 9 | 10, { ka: string; kha: string }>>;
  students: {
    /** Class 6 ক of 2026: [0] passed (place 2), [1] failed, [2] absent (no result). */
    six: PromoStudent[];
    /** Class 6 খ: passed, place 1. */
    sixB: PromoStudent[];
    /** Class 7 ক: two students, no exam. */
    seven: PromoStudent[];
    /** Class 10 ক: two students (the top class). */
    ten: PromoStudent[];
  };
  /** The published 2026 ANNUAL exam of class 6. */
  annualExamId: string;
  tokens: { owner: string; admin: string; teacher: string; accountant: string };
  userIds: { owner: string; admin: string; teacher: string; accountant: string };
}

/**
 * An NCTB school (classes 1–10, class 10 the top) with 2026 (current) and 2027, sections ক and খ
 * of classes 6–10 in both years, students in classes 6, 7 and 10 of 2026, and an ANNUAL exam of
 * 2026 published for class 6 (a passed, a failed and an absent student in ক, one passed in খ).
 */
export async function promotionSchool(
  h: Harness,
  opts: { modules?: ('ATTENDANCE' | 'FEES' | 'EXAMS')[]; capacity?: number | null } = {},
): Promise<PromotionSchool> {
  const tenantId = (await createTenant(h, { modules: opts.modules ?? ['EXAMS'] })).id;
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const y2026 = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const y2027 = await tx.academicYear.create({
      data: {
        tenantId,
        name: '2027',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
      },
    });
    const nums = [6, 7, 8, 9, 10] as const;
    const classes = {} as Record<6 | 7 | 8 | 9 | 10, string>;
    for (const n of nums)
      classes[n] = (await tx.classLevel.findFirstOrThrow({ where: { code: `CLASS_${n}` } })).id;
    const sections = { 2026: {}, 2027: {} } as PromotionSchool['sections'];
    for (const [year, yearId] of [
      [2026, y2026.id],
      [2027, y2027.id],
    ] as const) {
      for (const n of nums) {
        const mk = (name: string, sortOrder: number) =>
          tx.section.create({
            data: {
              tenantId,
              academicYearId: yearId,
              classLevelId: classes[n],
              name,
              sortOrder,
              capacity: year === 2027 ? (opts.capacity ?? null) : null,
            },
          });
        sections[year][n] = { ka: (await mk('ক', 1)).id, kha: (await mk('খ', 2)).id };
      }
    }
    const enrol = async (
      n: 6 | 7 | 10,
      sectionId: string,
      roll: number,
      nameBn: string,
    ): Promise<PromoStudent> => {
      const code = `P-${randomUUID().slice(0, 8)}`;
      const s = await tx.student.create({
        data: { tenantId, studentCode: code, nameBn, nameEn: `Student ${code}` },
      });
      const e = await tx.enrolment.create({
        data: {
          tenantId,
          studentId: s.id,
          academicYearId: y2026.id,
          classLevelId: classes[n],
          sectionId,
          roll,
        },
      });
      return { id: s.id, code, roll, enrolmentId: e.id };
    };
    const six = [
      await enrol(6, sections[2026][6].ka, 1, 'আরিফ'),
      await enrol(6, sections[2026][6].ka, 2, 'কবির'),
      await enrol(6, sections[2026][6].ka, 3, 'ইমরান'),
    ];
    const sixB = [await enrol(6, sections[2026][6].kha, 1, 'অমিত')];
    const seven = [
      await enrol(7, sections[2026][7].ka, 1, 'খাদিজা'),
      await enrol(7, sections[2026][7].ka, 2, 'ঋতু'),
    ];
    const ten = [
      await enrol(10, sections[2026][10].ka, 1, 'রহিম'),
      await enrol(10, sections[2026][10].ka, 2, 'করিম'),
    ];
    const annualExamId = await publishedAnnual(tx, tenantId, y2026.id, classes[6], [
      { student: six[0]!, sectionId: sections[2026][6].ka, passed: true, place: 2 },
      { student: six[1]!, sectionId: sections[2026][6].ka, passed: false, place: null },
      { student: six[2]!, sectionId: sections[2026][6].ka, passed: null, place: null },
      { student: sixB[0]!, sectionId: sections[2026][6].kha, passed: true, place: 1 },
    ]);
    return {
      y2026: y2026.id,
      y2027: y2027.id,
      classes,
      sections,
      students: { six, sixB, seven, ten },
      annualExamId,
    };
  });
  const staff = async (roles: ('OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'TEACHER')[]) => {
    const m = await addMember(h, tenantId, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };
  const owner = await staff(['OWNER']);
  const admin = await staff(['ADMIN']);
  const teacher = await staff(['TEACHER']);
  const accountant = await staff(['ACCOUNTANT']);
  return {
    tenantId,
    ...ids,
    tokens: {
      owner: owner.token,
      admin: admin.token,
      teacher: teacher.token,
      accountant: accountant.token,
    },
    userIds: {
      owner: owner.userId,
      admin: admin.userId,
      teacher: teacher.userId,
      accountant: accountant.userId,
    },
  };
}

/**
 * A published ANNUAL exam of one class (fixture rows, as a publish leaves them): candidates for
 * everyone, a result row for each with `passed` not null (null = absent: no result).
 */
export async function publishedAnnual(
  tx: TenantTx,
  tenantId: string,
  academicYearId: string,
  classLevelId: string,
  entries: {
    student: { id: string; roll: number };
    sectionId: string;
    passed: boolean | null;
    place: number | null;
  }[],
): Promise<string> {
  const exam = await tx.exam.create({
    data: {
      tenantId,
      academicYearId,
      kind: 'ANNUAL',
      nameBn: 'বার্ষিক পরীক্ষা',
      nameEn: 'Annual examination',
      startsOn: new Date('2026-11-01'),
      endsOn: new Date('2026-11-20'),
      resultMode: 'GPA',
      meritOrder: ['GPA', 'TOTAL_MARKS', 'ROLL'],
      failedRanking: 'AFTER_PASSED',
      status: 'OPEN',
    },
  });
  const examClass = await tx.examClass.create({
    data: {
      tenantId,
      examId: exam.id,
      classLevelId,
      isPublished: true,
      publishedVersion: 1,
      publishedAt: new Date(),
    },
  });
  for (const e of entries) {
    await tx.examCandidate.create({
      data: {
        tenantId,
        examId: exam.id,
        studentId: e.student.id,
        classLevelId,
        sectionId: e.sectionId,
        roll: e.student.roll,
      },
    });
    if (e.passed === null) continue;
    await tx.examResult.create({
      data: {
        tenantId,
        examId: exam.id,
        examClassId: examClass.id,
        classLevelId,
        studentId: e.student.id,
        sectionId: e.sectionId,
        roll: e.student.roll,
        totalH: e.passed ? 70000 : 20000,
        fullMarks: 1000,
        percentH: e.passed ? 7000 : 2000,
        gpaH: e.passed ? 400 : 0,
        gpaWithoutOptionalH: e.passed ? 400 : 0,
        letter: e.passed ? 'A' : 'F',
        passed: e.passed,
        failedSubjects: e.passed ? 0 : 3,
        classPosition: e.place,
        sectionPosition: e.place,
        subjects: [],
        publishedVersion: 1,
      },
    });
  }
  return exam.id;
}

/** The promotions queue: tests pause it to drive the processor themselves. */
export const promotionsQueue = (h: Harness) => h.app.get<Queue>(getQueueToken(PROMOTIONS_QUEUE));
