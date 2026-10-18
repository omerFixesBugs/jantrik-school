import { randomUUID } from 'node:crypto';
import { provisionTenant, withTenant } from '@jantrik/db';
import type { AttendanceSettings } from '@jantrik/shared';
import {
  addMember,
  bearer,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './harness.js';

export interface School {
  tenantId: string;
  admin: string; // tokens
  teacher: string;
  otherTeacher: string;
  sectionA: string;
  sectionB: string;
  /** Section A students by roll: id + primary guardian phone. */
  a: { id: string; phone: string }[];
  b: { id: string; phone: string }[];
}

/**
 * A school with the attendance module, absent SMS on (no delay, no off days so the test does
 * not depend on today's weekday), section A (3 students, teacher assigned) and section B (1).
 */
export async function school(
  h: Harness,
  opts: { instituteTypeKey?: string; settings?: Partial<AttendanceSettings> } = {},
): Promise<School> {
  const tenant = opts.instituteTypeKey
    ? await provisionTenant(h.prisma, {
        slug: `c-${randomUUID().slice(0, 8)}`,
        name: 'আলো কোচিং',
        instituteTypeKey: opts.instituteTypeKey,
        status: 'ACTIVE',
        modules: ['ATTENDANCE'],
        academicYear: {
          name: '2026',
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
        },
      })
    : await createTenant(h, { modules: ['ATTENDANCE'] });
  const tenantId = tenant.id;
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const classLevel = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
    const mkSection = (name: string) =>
      tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: classLevel.id, name },
      });
    const sectionA = await mkSection('A');
    const sectionB = await mkSection('B');
    const enrol = async (sectionId: string, roll: number) => {
      const s = await tx.student.create({
        data: {
          tenantId,
          studentCode: `S-${randomUUID().slice(0, 8)}`,
          nameBn: `ছাত্র ${roll}`,
          nameEn: `Student ${roll}`,
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId,
          studentId: s.id,
          academicYearId: year.id,
          classLevelId: classLevel.id,
          sectionId,
          roll,
        },
      });
      const phone = randomPhone();
      const g = await tx.guardian.create({ data: { tenantId, nameEn: 'Parent', phone } });
      await tx.studentGuardian.create({
        data: { tenantId, studentId: s.id, guardianId: g.id, relation: 'FATHER', isPrimary: true },
      });
      return { id: s.id, phone };
    };
    return {
      sectionA: sectionA.id,
      sectionB: sectionB.id,
      a: [await enrol(sectionA.id, 1), await enrol(sectionA.id, 2), await enrol(sectionA.id, 3)],
      b: [await enrol(sectionB.id, 1)],
    };
  });

  const login = async (roles: ('ADMIN' | 'TEACHER')[]) => {
    const m = await addMember(h, tenantId, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };
  const admin = await login(['ADMIN']);
  const teacher = await login(['TEACHER']);
  const otherTeacher = await login(['TEACHER']);

  await http(h)
    .put(`/attendance/sections/${ids.sectionA}/teachers`)
    .set(bearer(admin.token))
    .send({ teachers: [{ userId: teacher.userId, isClassTeacher: true }] })
    .expect(200);
  await http(h)
    .put('/attendance/settings')
    .set(bearer(admin.token))
    .send({
      mode: opts.instituteTypeKey === 'COACHING' ? 'PER_SESSION' : 'DAILY',
      weeklyOffDays: [],
      editWindowDays: 0,
      leaveCountsAsAbsent: false,
      absentSmsEnabled: true,
      absentSmsTemplate: null,
      absentSmsDelayMinutes: 0,
      dailySmsCap: null,
      ...opts.settings,
    })
    .expect(200);

  return {
    tenantId,
    admin: admin.token,
    teacher: teacher.token,
    otherTeacher: otherTeacher.token,
    ...ids,
  };
}
