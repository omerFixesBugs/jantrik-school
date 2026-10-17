import { normalizeBdPhone } from '@jantrik/shared';
import {
  Prisma,
  type GuardianRelation,
  type ModuleKey,
  type PrismaClient,
  type Role,
} from '../generated/prisma/client.js';
import { hash } from '@node-rs/argon2';
import { withContext, withTenant, type TenantTx } from '../tenancy/context.js';
import { provisionTenant } from '../tenancy/provision.js';
import { findOrCreateUser } from '../tenancy/users.js';

// Two demo tenants for local development. Created through provisionTenant() as the app role,
// exactly like a real signup. Idempotent: an existing tenant (same slug) is skipped.

const ALL_MODULES: ModuleKey[] = ['ATTENDANCE', 'FEES', 'EXAMS'];

/**
 * Password for the demo staff accounts. Development only: set exclusively by this seed (which
 * refuses to run in production); no application code path sets passwords.
 */
export const DEMO_STAFF_PASSWORD = 'Jantrik@2026';

const phone = (raw: string): string => {
  const p = normalizeBdPhone(raw);
  if (!p) throw new Error(`Bad demo phone ${raw}`);
  return p;
};

interface DemoGuardian {
  nameBn: string;
  nameEn: string;
  phone: string;
  relation: GuardianRelation;
  occupation?: string;
}

interface DemoStudent {
  code: string;
  nameBn: string;
  nameEn: string;
  gender: 'MALE' | 'FEMALE';
  dob: string;
  classLevel: string;
  section: string;
  group?: string;
  roll: number;
  guardians: DemoGuardian[];
  religion?: 'ISLAM' | 'HINDUISM' | 'BUDDHISM' | 'CHRISTIANITY';
  birthRegistrationNo?: string;
}

interface DemoSection {
  classLevel: string;
  name: string;
  shift?: string;
  capacity?: number;
}

interface DemoTenant {
  slug: string;
  name: string;
  instituteTypeKey: string;
  shifts: { nameBn: string; nameEn: string; start: string; end: string }[];
  sections: DemoSection[];
  staff: { phone: string; name: string; role: Role }[];
  students: DemoStudent[];
}

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const DEMO_TENANTS: DemoTenant[] = [
  {
    slug: 'shapla-school',
    name: 'শাপলা উচ্চ বিদ্যালয়',
    instituteTypeKey: 'NCTB_SCHOOL_BN',
    shifts: [
      { nameBn: 'প্রভাতী', nameEn: 'Morning', start: '07:00', end: '12:00' },
      { nameBn: 'দিবা', nameEn: 'Day', start: '12:30', end: '17:00' },
    ],
    sections: [
      { classLevel: 'CLASS_6', name: 'ক', shift: 'Morning', capacity: 50 },
      { classLevel: 'CLASS_6', name: 'খ', shift: 'Day', capacity: 50 },
      { classLevel: 'CLASS_9', name: 'ক', shift: 'Morning', capacity: 60 },
    ],
    staff: [
      { phone: '01711000001', name: 'Abdul Karim', role: 'OWNER' },
      { phone: '01711000002', name: 'Nasrin Akter', role: 'TEACHER' },
    ],
    students: [
      {
        code: 'SHS-2026-0001',
        nameBn: 'তাসনিম রহমান',
        nameEn: 'Tasnim Rahman',
        gender: 'FEMALE',
        dob: '2014-03-12',
        classLevel: 'CLASS_6',
        section: 'ক',
        roll: 1,
        religion: 'ISLAM',
        birthRegistrationNo: '20142692512345678',
        guardians: [
          {
            nameBn: 'মোঃ হাবিবুর রহমান',
            nameEn: 'Md. Habibur Rahman',
            phone: '01811000101',
            relation: 'FATHER',
            occupation: 'Business',
          },
          { nameBn: 'সালমা বেগম', nameEn: 'Salma Begum', phone: '01811000102', relation: 'MOTHER' },
        ],
      },
      {
        // Sibling of Tasnim: shares the same guardians.
        code: 'SHS-2026-0002',
        nameBn: 'তাহমিদ রহমান',
        nameEn: 'Tahmid Rahman',
        gender: 'MALE',
        dob: '2011-08-02',
        classLevel: 'CLASS_9',
        section: 'ক',
        group: 'SCIENCE',
        roll: 1,
        religion: 'ISLAM',
        guardians: [
          {
            nameBn: 'মোঃ হাবিবুর রহমান',
            nameEn: 'Md. Habibur Rahman',
            phone: '01811000101',
            relation: 'FATHER',
          },
        ],
      },
      {
        code: 'SHS-2026-0003',
        nameBn: 'অর্পিতা দাস',
        nameEn: 'Arpita Das',
        gender: 'FEMALE',
        dob: '2014-11-20',
        classLevel: 'CLASS_6',
        section: 'খ',
        roll: 1,
        religion: 'HINDUISM',
        guardians: [
          { nameBn: 'সুমন দাস', nameEn: 'Suman Das', phone: '01911000201', relation: 'FATHER' },
        ],
      },
      {
        code: 'SHS-2026-0004',
        nameBn: 'রাফি আহমেদ',
        nameEn: 'Rafi Ahmed',
        gender: 'MALE',
        dob: '2011-05-15',
        classLevel: 'CLASS_9',
        section: 'ক',
        group: 'BUSINESS',
        roll: 2,
        guardians: [
          {
            nameBn: 'রেহানা আহমেদ',
            nameEn: 'Rehana Ahmed',
            phone: '01611000301',
            relation: 'MOTHER',
          },
        ],
      },
    ],
  },
  {
    slug: 'alo-coaching',
    name: 'আলো কোচিং সেন্টার',
    instituteTypeKey: 'COACHING',
    shifts: [],
    sections: [
      { classLevel: 'CLASS_10', name: 'SSC Batch A (Sat-Mon-Wed)', capacity: 30 },
      { classLevel: 'HSC_1', name: 'HSC Batch 1', capacity: 40 },
    ],
    staff: [
      { phone: '01511000001', name: 'Mahfuz Hasan', role: 'OWNER' },
      { phone: '01511000002', name: 'Farhana Yasmin', role: 'TEACHER' },
    ],
    students: [
      {
        code: 'ALO-26-001',
        nameBn: 'সাকিব হোসেন',
        nameEn: 'Sakib Hossain',
        gender: 'MALE',
        dob: '2010-02-10',
        classLevel: 'CLASS_10',
        section: 'SSC Batch A (Sat-Mon-Wed)',
        roll: 1,
        guardians: [
          {
            nameBn: 'জাহাঙ্গীর হোসেন',
            nameEn: 'Jahangir Hossain',
            phone: '01711000401',
            relation: 'FATHER',
          },
        ],
      },
      {
        code: 'ALO-26-002',
        nameBn: 'নুসরাত জাহান',
        nameEn: 'Nusrat Jahan',
        gender: 'FEMALE',
        dob: '2010-07-25',
        classLevel: 'CLASS_10',
        section: 'SSC Batch A (Sat-Mon-Wed)',
        roll: 2,
        guardians: [
          {
            nameBn: 'শাহনাজ পারভীন',
            nameEn: 'Shahnaz Parvin',
            phone: '01311000501',
            relation: 'MOTHER',
          },
        ],
      },
      {
        code: 'ALO-26-003',
        nameBn: 'ইমরান খান',
        nameEn: 'Imran Khan',
        gender: 'MALE',
        dob: '2009-01-30',
        classLevel: 'HSC_1',
        section: 'HSC Batch 1',
        roll: 1,
        guardians: [
          { nameBn: 'আনোয়ার খান', nameEn: 'Anwar Khan', phone: '01411000601', relation: 'FATHER' },
        ],
      },
    ],
  },
];

/** Returns the staff user ids, so their passwords can be set afterwards. */
async function seedTenantData(tx: TenantTx, tenantId: string, def: DemoTenant): Promise<string[]> {
  const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
  const classLevels = new Map((await tx.classLevel.findMany()).map((c) => [c.code, c.id]));
  const studyGroups = new Map((await tx.studyGroup.findMany()).map((g) => [g.code, g.id]));
  const id = <T>(map: Map<string, T>, key: string): T => {
    const value = map.get(key);
    if (value === undefined) throw new Error(`Demo seed: unknown ${key}`);
    return value;
  };

  const shifts = new Map<string, string>();
  for (const [order, sh] of def.shifts.entries()) {
    const shift = await tx.shift.create({
      data: {
        tenantId,
        nameBn: sh.nameBn,
        nameEn: sh.nameEn,
        startTime: time(sh.start),
        endTime: time(sh.end),
        sortOrder: order,
      },
    });
    shifts.set(sh.nameEn, shift.id);
  }

  const sections = new Map<string, string>();
  for (const [order, sec] of def.sections.entries()) {
    const section = await tx.section.create({
      data: {
        tenantId,
        academicYearId: year.id,
        classLevelId: id(classLevels, sec.classLevel),
        shiftId: sec.shift ? id(shifts, sec.shift) : null,
        name: sec.name,
        capacity: sec.capacity ?? null,
        sortOrder: order,
      },
    });
    sections.set(`${sec.classLevel}/${sec.name}`, section.id);
  }

  const staffUserIds: string[] = [];
  for (const member of def.staff) {
    const userId = await findOrCreateUser(tx, phone(member.phone), member.name);
    await tx.membership.create({ data: { tenantId, userId, role: member.role } });
    staffUserIds.push(userId);
  }

  const guardianIds = new Map<string, string>(); // by phone
  for (const st of def.students) {
    const student = await tx.student.create({
      data: {
        tenantId,
        studentCode: st.code,
        nameBn: st.nameBn,
        nameEn: st.nameEn,
        gender: st.gender,
        dateOfBirth: new Date(st.dob),
        religion: st.religion ?? null,
        birthRegistrationNo: st.birthRegistrationNo ?? null,
        fatherNameEn: st.guardians.find((g) => g.relation === 'FATHER')?.nameEn ?? null,
        fatherNameBn: st.guardians.find((g) => g.relation === 'FATHER')?.nameBn ?? null,
        motherNameEn: st.guardians.find((g) => g.relation === 'MOTHER')?.nameEn ?? null,
        motherNameBn: st.guardians.find((g) => g.relation === 'MOTHER')?.nameBn ?? null,
        presentAddress: 'Dhaka',
      },
    });

    for (const [i, g] of st.guardians.entries()) {
      const p = phone(g.phone);
      let guardianId = guardianIds.get(p);
      if (!guardianId) {
        // Guardians log in to the app with phone + OTP.
        const userId = await findOrCreateUser(tx, p, g.nameEn);
        await tx.membership.create({ data: { tenantId, userId, role: 'GUARDIAN' } });
        const guardian = await tx.guardian.create({
          data: {
            tenantId,
            userId,
            nameBn: g.nameBn,
            nameEn: g.nameEn,
            phone: p,
            occupation: g.occupation ?? null,
          },
        });
        guardianId = guardian.id;
        guardianIds.set(p, guardianId);
      }
      await tx.studentGuardian.create({
        data: {
          tenantId,
          studentId: student.id,
          guardianId,
          relation: g.relation,
          isPrimary: i === 0,
        },
      });
    }

    await tx.enrolment.create({
      data: {
        tenantId,
        studentId: student.id,
        academicYearId: year.id,
        classLevelId: id(classLevels, st.classLevel),
        sectionId: id(sections, `${st.classLevel}/${st.section}`),
        studyGroupId: st.group ? id(studyGroups, st.group) : null,
        roll: st.roll,
      },
    });
  }
  return staffUserIds;
}

/** Create the demo tenants. Must run as the app role (RLS applies, as in production). */
export async function seedDemo(app: PrismaClient): Promise<void> {
  for (const def of DEMO_TENANTS) {
    let tenantId: string;
    try {
      const tenant = await provisionTenant(app, {
        slug: def.slug,
        name: def.name,
        instituteTypeKey: def.instituteTypeKey,
        status: 'ACTIVE',
        modules: ALL_MODULES,
        academicYear: {
          name: '2026',
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
        },
      });
      tenantId = tenant.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        console.log(`  ${def.slug}: already exists, skipped`);
        continue;
      }
      throw error;
    }
    const staffUserIds = await withTenant(
      app,
      tenantId,
      (tx) => seedTenantData(tx, tenantId, def),
      {
        timeout: 30_000,
      },
    );

    // RLS lets a user update only their own row, so each password is set as that user.
    const passwordHash = await hash(DEMO_STAFF_PASSWORD);
    for (const userId of staffUserIds) {
      await withContext(app, { userId }, (tx) =>
        tx.user.update({ where: { id: userId }, data: { passwordHash } }),
      );
    }
    console.log(`  ${def.slug}: created (${def.students.length} students)`);
  }
}
