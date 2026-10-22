import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { addDays, addMonths, dateToDb, todayIn, type IsoDate } from '@jantrik/shared';
import { addMember, createTenant, otpLogin, randomPhone, type Harness } from './harness.js';

export interface FeesSchool {
  tenantId: string;
  yearId: string;
  /** Today in Asia/Dhaka; the current year runs from 3 months before this month for 12 months. */
  today: IsoDate;
  /** 'YYYY-MM' of last month and this month (both inside the current year). */
  months: { previous: string; current: string };
  yearStart: IsoDate;
  yearEnd: IsoDate;
  class6: string;
  class9: string;
  science: string;
  sectionId: string;
  /**
   * Students of class 6 section ক: [0] and [1] share their primary guardian's phone (siblings,
   * not yet confirmed as a family); [2] has a guardian of their own. [3] is in class 9 science.
   */
  students: { id: string; code: string; phone: string }[];
  tokens: {
    owner: string;
    admin: string;
    accountant: string;
    teacher: string;
    /** Guardian of students[0] and [1]. */
    guardian: string;
    /** Guardian of students[2]. */
    otherGuardian: string;
  };
  userIds: { owner: string; admin: string; accountant: string; teacher: string };
}

/** An NCTB school with the FEES module, staff of every role and two guardians who log in. */
export async function feesSchool(
  h: Harness,
  opts: { modules?: ('ATTENDANCE' | 'FEES' | 'EXAMS')[] } = {},
): Promise<FeesSchool> {
  const tenantId = (await createTenant(h, { modules: opts.modules ?? ['FEES', 'ATTENDANCE'] })).id;
  const sharedPhone = randomPhone();
  // Fee tests depend on today: the year always surrounds it, and fixture students were
  // admitted long before it (a new admission is created by the test that needs one).
  const today = todayIn('Asia/Dhaka');
  const current = today.slice(0, 7);
  const yearStart = `${addMonths(current, -3)}-01`;
  const yearEnd = addDays(`${addMonths(current, 9)}-01`, -1);
  const admittedLongAgo = dateToDb(addDays(yearStart, -400));
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.update({
      where: { tenantId_name: { tenantId, name: '2026' } },
      data: { startDate: dateToDb(yearStart), endDate: dateToDb(yearEnd) },
    });
    const class6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const class9 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } });
    const science = await tx.studyGroup.findFirstOrThrow({ where: { code: 'SCIENCE' } });
    const section = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: class6.id, name: 'ক' },
    });
    const section9 = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: class9.id, name: 'ক' },
    });
    const sharedGuardian = await tx.guardian.create({
      data: { tenantId, nameBn: 'করিম', nameEn: 'Karim', phone: sharedPhone },
    });
    const enrol = async (
      n: number,
      opts: { classLevelId: string; sectionId: string; studyGroupId?: string; shared?: boolean },
    ) => {
      const code = `F-${randomUUID().slice(0, 8)}`;
      const s = await tx.student.create({
        data: {
          tenantId,
          studentCode: code,
          nameBn: `ছাত্র ${n}`,
          nameEn: `Student ${n}`,
          createdAt: admittedLongAgo,
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId,
          studentId: s.id,
          academicYearId: year.id,
          classLevelId: opts.classLevelId,
          sectionId: opts.sectionId,
          studyGroupId: opts.studyGroupId ?? null,
          roll: n,
        },
      });
      const guardian = opts.shared
        ? sharedGuardian
        : await tx.guardian.create({
            data: { tenantId, nameBn: `অভিভাবক ${n}`, nameEn: `Parent ${n}`, phone: randomPhone() },
          });
      await tx.studentGuardian.create({
        data: {
          tenantId,
          studentId: s.id,
          guardianId: guardian.id,
          relation: 'FATHER',
          isPrimary: true,
        },
      });
      return { id: s.id, code, phone: guardian.phone };
    };
    const students = [
      await enrol(1, { classLevelId: class6.id, sectionId: section.id, shared: true }),
      await enrol(2, { classLevelId: class6.id, sectionId: section.id, shared: true }),
      await enrol(3, { classLevelId: class6.id, sectionId: section.id }),
      await enrol(4, { classLevelId: class9.id, sectionId: section9.id, studyGroupId: science.id }),
    ];
    return {
      yearId: year.id,
      class6: class6.id,
      class9: class9.id,
      science: science.id,
      sectionId: section.id,
      students,
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
  const accountant = await staff(['ACCOUNTANT']);
  const teacher = await staff(['TEACHER']);
  return {
    tenantId,
    today,
    months: { previous: addMonths(current, -1), current },
    yearStart,
    yearEnd,
    ...ids,
    tokens: {
      owner: owner.token,
      admin: admin.token,
      accountant: accountant.token,
      teacher: teacher.token,
      guardian: await guardianLogin(sharedPhone),
      otherGuardian: await guardianLogin(ids.students[2]!.phone),
    },
    userIds: {
      owner: owner.userId,
      admin: admin.userId,
      accountant: accountant.userId,
      teacher: teacher.userId,
    },
  };
}
