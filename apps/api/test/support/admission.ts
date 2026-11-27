import { withTenant } from '@jantrik/db';
import {
  toBanglaDigits,
  type AdmissionApplicationDetail,
  type AdmissionCycleView,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  yearRange,
  type Harness,
} from './harness.js';

export interface AdmissionSchool {
  tenantId: string;
  slug: string;
  /** The current year (the test year, `testYear`). */
  yearId: string;
  /** The year after it, the year the cycle admits for. */
  nextYearId: string;
  class6: string;
  class7: string;
  /** Sections of class 6 in the next year: ক (capacity 40) and খ (no limit). */
  sectionA: string;
  sectionB: string;
  /** A class-6 section of the current year (the wrong year). */
  sectionThisYear: string;
  /** The current year's calendar year: the test year (`testYear`) when the school was made. */
  year: number;
  tokens: { owner: string; admin: string; teacher: string; accountant: string };
  userIds: { admin: string };
}

/**
 * The fixture cycle's window: from the first moment of the school's current year (Asia/Dhaka) to
 * the end of January after it, so it is open on every day of that year, 1 January included.
 */
export const cycleWindow = (s: Pick<AdmissionSchool, 'year'>) => ({
  opensAt: `${s.year}-01-01T00:00:00+06:00`,
  closesAt: `${s.year + 1}-01-31T23:59:00+06:00`,
});

/** An NCTB school with next year's year, two of its class-6 sections, and staff of every role. */
export async function admissionSchool(h: Harness): Promise<AdmissionSchool> {
  const tenant = await createTenant(h);
  const tenantId = tenant.id;
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const next = await tx.academicYear.create({
      data: { tenantId, ...yearRange(year.startDate.getUTCFullYear() + 1) },
    });
    const class6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const class7 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_7' } });
    const section = (yearId: string, name: string, capacity: number | null) =>
      tx.section.create({
        data: { tenantId, academicYearId: yearId, classLevelId: class6.id, name, capacity },
      });
    const a = await section(next.id, 'ক', 40);
    const b = await section(next.id, 'খ', null);
    const old = await section(year.id, 'ক', null);
    return {
      yearId: year.id,
      nextYearId: next.id,
      class6: class6.id,
      class7: class7.id,
      sectionA: a.id,
      sectionB: b.id,
      sectionThisYear: old.id,
      year: year.startDate.getUTCFullYear(),
    };
  });
  const staff = async (roles: ('OWNER' | 'ADMIN' | 'TEACHER' | 'ACCOUNTANT')[]) => {
    const m = await addMember(h, tenantId, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };
  const owner = await staff(['OWNER']);
  const admin = await staff(['ADMIN']);
  const teacher = await staff(['TEACHER']);
  const accountant = await staff(['ACCOUNTANT']);
  return {
    tenantId,
    slug: tenant.slug,
    ...ids,
    tokens: {
      owner: owner.token,
      admin: admin.token,
      teacher: teacher.token,
      accountant: accountant.token,
    },
    userIds: { admin: admin.userId },
  };
}

export const api = (h: Harness, token: string) => ({
  get: (path: string) => http(h).get(path).set(bearer(token)),
  post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
  put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
});

/** A DRAFT cycle for next year with classes 6 and 7, opened unless `open: false`. */
export async function admissionCycle(
  h: Harness,
  s: AdmissionSchool,
  opts: { open?: boolean; requiresTest?: boolean; fields?: Record<string, string> } = {},
): Promise<AdmissionCycleView> {
  const admin = api(h, s.tokens.admin);
  const cycle = (
    await admin
      .post('/admission/cycles', {
        academicYearId: s.nextYearId,
        nameBn: `ভর্তি ${toBanglaDigits(String(s.year + 1))}`,
        nameEn: `Admission ${s.year + 1}`,
        ...cycleWindow(s),
        requiresTest: opts.requiresTest ?? false,
        fields: opts.fields ?? {},
      })
      .expect(201)
  ).body as AdmissionCycleView;
  let view = (
    await admin
      .put(`/admission/cycles/${cycle.id}/classes`, {
        classes: [
          { classLevelId: s.class6, seats: 80 },
          { classLevelId: s.class7, seats: null },
        ],
      })
      .expect(200)
  ).body as AdmissionCycleView;
  if (opts.open !== false) {
    view = (
      await admin.post(`/admission/cycles/${cycle.id}/status`, { status: 'OPEN' }).expect(200)
    ).body as AdmissionCycleView;
  }
  return view;
}

const birthReg = () => `2019${String(Math.floor(Math.random() * 1e13)).padStart(13, '0')}`;

/** A walk-in application typed by the admin (decision P3-J). */
export async function staffApplication(
  h: Harness,
  s: AdmissionSchool,
  cycleClassId: string,
  over: Record<string, unknown> = {},
): Promise<AdmissionApplicationDetail> {
  return (
    await api(h, s.tokens.admin)
      .post('/admission/applications', staffApplicationBody(cycleClassId, over))
      .expect(201)
  ).body as AdmissionApplicationDetail;
}

export function staffApplicationBody(cycleClassId: string, over: Record<string, unknown> = {}) {
  return {
    cycleClassId,
    nameBn: 'রাফি আহমেদ',
    nameEn: 'Rafi Ahmed',
    dateOfBirth: '2019-05-01',
    gender: 'MALE',
    birthRegistrationNo: birthReg(),
    guardianNameBn: 'করিম আহমেদ',
    guardianRelation: 'FATHER',
    phone: randomPhone(),
    ...over,
  };
}

/** Sprint 1 P4: an opened cycle with an admission test, its class-6 class and `n` walk-ins. */
export async function testClass(
  h: Harness,
  s: AdmissionSchool,
  n: number,
  over: (i: number) => Record<string, unknown> = () => ({}),
): Promise<{ cycle: AdmissionCycleView; cc: string; apps: AdmissionApplicationDetail[] }> {
  const cycle = await admissionCycle(h, s, { requiresTest: true });
  const cc = cycle.classes.find((c) => c.classLevel.id === s.class6)!.id;
  const apps: AdmissionApplicationDetail[] = [];
  for (let i = 0; i < n; i++) {
    apps.push(
      await staffApplication(h, s, cc, {
        nameEn: `Applicant ${i + 1}`,
        nameBn: `প্রার্থী ${i + 1}`,
        ...over(i),
      }),
    );
  }
  return { cycle, cc, apps };
}
