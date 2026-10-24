import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  addMember,
  bearer,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './harness.js';

export interface ExamStudent {
  id: string;
  code: string;
  roll: number;
  phone: string;
}

export interface ExamsSchool {
  tenantId: string;
  yearId: string;
  class6: string;
  class9: string;
  groups: { science: string; business: string };
  sections: { six: string; sixB: string; nine: string };
  students: {
    /** Class 6 ক, rolls 1–3. */
    six: ExamStudent[];
    /** Class 6 খ, roll 1. */
    sixB: ExamStudent[];
    /** Class 9 ক: [0] Science, [1] Business. */
    nine: ExamStudent[];
  };
  /** Subject id by code, per class (from the NCTB template). */
  subjects: { six: Record<string, string>; nine: Record<string, string> };
  tokens: {
    owner: string;
    admin: string;
    /** Class teacher of 6 ক (attendance setup); no subject yet. */
    teacher: string;
    otherTeacher: string;
    accountant: string;
    /** Guardian of six[0]. */
    guardian: string;
    /** Guardian of six[1]. */
    otherGuardian: string;
  };
  userIds: {
    owner: string;
    admin: string;
    teacher: string;
    otherTeacher: string;
    accountant: string;
  };
}

/** An NCTB school with the EXAMS (and ATTENDANCE) modules, staff of every role and two guardians. */
export async function examsSchool(
  h: Harness,
  opts: { modules?: ('ATTENDANCE' | 'FEES' | 'EXAMS')[] } = {},
): Promise<ExamsSchool> {
  const tenantId = (await createTenant(h, { modules: opts.modules ?? ['ATTENDANCE', 'EXAMS'] })).id;
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const class6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const class9 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } });
    const science = await tx.studyGroup.findFirstOrThrow({ where: { code: 'SCIENCE' } });
    const business = await tx.studyGroup.findFirstOrThrow({ where: { code: 'BUSINESS' } });
    const mkSection = (classLevelId: string, name: string) =>
      tx.section.create({ data: { tenantId, academicYearId: year.id, classLevelId, name } });
    const six = await mkSection(class6.id, 'ক');
    const sixB = await mkSection(class6.id, 'খ');
    const nine = await mkSection(class9.id, 'ক');
    const enrol = async (
      roll: number,
      classLevelId: string,
      sectionId: string,
      studyGroupId: string | null = null,
    ): Promise<ExamStudent> => {
      const code = `E-${randomUUID().slice(0, 8)}`;
      const s = await tx.student.create({
        data: { tenantId, studentCode: code, nameBn: `ছাত্র ${roll}`, nameEn: `Student ${roll}` },
      });
      await tx.enrolment.create({
        data: {
          tenantId,
          studentId: s.id,
          academicYearId: year.id,
          classLevelId,
          sectionId,
          studyGroupId,
          roll,
        },
      });
      const phone = randomPhone();
      const g = await tx.guardian.create({
        data: { tenantId, nameBn: `অভিভাবক ${roll}`, nameEn: `Parent ${roll}`, phone },
      });
      await tx.studentGuardian.create({
        data: { tenantId, studentId: s.id, guardianId: g.id, relation: 'FATHER', isPrimary: true },
      });
      return { id: s.id, code, roll, phone };
    };
    const subjectsOf = async (classLevelId: string) =>
      Object.fromEntries(
        (await tx.subject.findMany({ where: { classLevelId } })).map((s) => [s.code, s.id]),
      );
    return {
      yearId: year.id,
      class6: class6.id,
      class9: class9.id,
      groups: { science: science.id, business: business.id },
      sections: { six: six.id, sixB: sixB.id, nine: nine.id },
      students: {
        six: [
          await enrol(1, class6.id, six.id),
          await enrol(2, class6.id, six.id),
          await enrol(3, class6.id, six.id),
        ],
        sixB: [await enrol(1, class6.id, sixB.id)],
        nine: [
          await enrol(1, class9.id, nine.id, science.id),
          await enrol(2, class9.id, nine.id, business.id),
        ],
      },
      subjects: { six: await subjectsOf(class6.id), nine: await subjectsOf(class9.id) },
    };
  });

  const staff = async (roles: ('OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'TEACHER')[]) => {
    const m = await addMember(h, tenantId, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };
  const guardianLogin = async (phone: string) => {
    const m = await addMember(h, tenantId, { phone, roles: ['GUARDIAN'] });
    await withTenant(h.prisma, tenantId, (tx) =>
      tx.guardian.updateMany({ where: { phone }, data: { userId: m.userId } }),
    );
    return (await otpLogin(h, phone)).accessToken;
  };
  const owner = await staff(['OWNER']);
  const admin = await staff(['ADMIN']);
  const teacher = await staff(['TEACHER']);
  const otherTeacher = await staff(['TEACHER']);
  const accountant = await staff(['ACCOUNTANT']);
  if ((opts.modules ?? ['ATTENDANCE']).includes('ATTENDANCE')) {
    await http(h)
      .put(`/attendance/sections/${ids.sections.six}/teachers`)
      .set(bearer(admin.token))
      .send({ teachers: [{ userId: teacher.userId, isClassTeacher: true }] })
      .expect(200);
  }
  return {
    tenantId,
    ...ids,
    tokens: {
      owner: owner.token,
      admin: admin.token,
      teacher: teacher.token,
      otherTeacher: otherTeacher.token,
      accountant: accountant.token,
      guardian: await guardianLogin(ids.students.six[0]!.phone),
      otherGuardian: await guardianLogin(ids.students.six[1]!.phone),
    },
    userIds: {
      owner: owner.userId,
      admin: admin.userId,
      teacher: teacher.userId,
      otherTeacher: otherTeacher.userId,
      accountant: accountant.userId,
    },
  };
}
