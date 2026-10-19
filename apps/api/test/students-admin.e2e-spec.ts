import { withTenant } from '@jantrik/db';
import type {
  GuardianChild,
  GuardianMatch,
  StudentProfile,
  StudentSettings,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';

const bn = (s: string) => s.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);
const birthReg = () => `2013${String(Math.floor(Math.random() * 1e13)).padStart(13, '0')}`;

describe('students: admission, profile, guardians, transfer, deactivate', () => {
  let h: Harness;
  let tenantId: string;
  let admin: string;
  let teacher: string;
  let yearId: string;
  let classLevelId: string;
  let otherClassLevelId: string;
  let sectionA: string;
  let sectionB: string;

  const admission = (over: Record<string, unknown> = {}) => ({
    nameBn: 'তাসনিম রহমান',
    nameEn: 'Tasnim Rahman',
    gender: 'FEMALE',
    birthRegistrationNo: birthReg(),
    guardians: [
      { phone: randomPhone(), nameBn: 'হাবিবুর রহমান', relation: 'FATHER', isPrimary: true },
    ],
    enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionA, roll: null },
    ...over,
  });
  const admit = (body: unknown, token = admin) =>
    http(h)
      .post('/students')
      .set(bearer(token))
      .send(body as object);

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    const login = async (roles: ('ADMIN' | 'TEACHER')[]) =>
      (await otpLogin(h, (await addMember(h, tenantId, { roles })).phone)).accessToken;
    admin = await login(['ADMIN']);
    teacher = await login(['TEACHER']);
    const ids = await withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const [c1, c2] = await tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      const mk = (name: string, capacity: number | null = null) =>
        tx.section.create({
          data: { tenantId, academicYearId: year.id, classLevelId: c1!.id, name, capacity },
        });
      return {
        year: year.id,
        c1: c1!.id,
        c2: c2!.id,
        a: (await mk('A')).id,
        b: (await mk('B', 1)).id,
      };
    });
    yearId = ids.year;
    classLevelId = ids.c1;
    otherClassLevelId = ids.c2;
    sectionA = ids.a;
    sectionB = ids.b;
    await http(h)
      .put('/students/settings')
      .set(bearer(admin))
      .send({ codePrefix: 'tst', codePattern: '{PREFIX}-{YEAR}-{NNNN}' })
      .expect(200);
  });

  afterAll(async () => {
    await h.close();
  });

  it('admits a student: generated code, enrolment, guardian with a login (no SMS)', async () => {
    const body = admission({
      enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionA, roll: bn('7') },
    });
    const p = (await admit(body).expect(201)).body as StudentProfile;
    expect(p.studentCode).toBe('TST-2026-0001');
    expect(p.enrolments).toMatchObject([{ section: { id: sectionA }, roll: 7 }]);
    expect(p.guardians).toMatchObject([{ relation: 'FATHER', isPrimary: true, canLogIn: true }]);
    const phone = (body.guardians as { phone: string }[])[0]!.phone;
    expect(h.sms.sentTo(phone)).toEqual([]);
    // The guardian can log in and sees the child.
    const g = (await otpLogin(h, phone)).accessToken;
    const kids = (await http(h).get('/me/children').set(bearer(g)).expect(200))
      .body as GuardianChild[];
    expect(kids.map((k) => k.id)).toEqual([p.id]);
    // Settings show the next code.
    const s = (await http(h).get('/students/settings').set(bearer(admin)).expect(200))
      .body as StudentSettings;
    expect(s.example).toBe('TST-2026-0002');
  });

  it('teachers can read profiles but not admit or change', async () => {
    const p = (await admit(admission()).expect(201)).body as StudentProfile;
    await http(h).get(`/students/${p.id}`).set(bearer(teacher)).expect(200);
    await admit(admission(), teacher).expect(403);
    await http(h).patch(`/students/${p.id}`).set(bearer(teacher)).send({ nameEn: 'x' }).expect(403);
    await http(h).post(`/students/${p.id}/deactivate`).set(bearer(teacher)).expect(403);
  });

  it('validates: Bangla digits, 17-digit birth registration, BD phone, a name, one primary', async () => {
    const reg = birthReg();
    const p = (await admit(admission({ birthRegistrationNo: bn(reg) })).expect(201))
      .body as StudentProfile;
    expect(p.birthRegistrationNo).toBe(reg);
    await admit(admission({ birthRegistrationNo: '12345' })).expect(400);
    await admit(admission({ nameBn: '', nameEn: '' })).expect(400);
    await admit(
      admission({
        guardians: [{ phone: '0171', nameBn: 'x', relation: 'FATHER', isPrimary: true }],
      }),
    ).expect(400);
    await admit(
      admission({
        guardians: [{ phone: randomPhone(), nameBn: 'x', relation: 'FATHER', isPrimary: false }],
      }),
    ).expect(400);
  });

  it('a new guardian needs a name; a known phone needs a choice: pick one or add a new guardian', async () => {
    const phone = randomPhone();
    const nameless = { phone, relation: 'FATHER', isPrimary: true };
    const r = await admit(admission({ guardians: [nameless] })).expect(422);
    expect(r.body.code).toBe('GUARDIAN_NAME_REQUIRED');
    const first = (
      await admit(admission({ guardians: [{ ...nameless, nameEn: 'Father' }] })).expect(201)
    ).body as StudentProfile;
    const existing = first.guardians[0]!.guardianId;

    // Never linked silently.
    const choice = await admit(admission({ guardians: [nameless] })).expect(409);
    expect(choice.body).toMatchObject({
      code: 'GUARDIAN_CHOICE_REQUIRED',
      field: 'guardians',
      phone,
    });
    // Picked: no name needed.
    const picked = (
      await admit(admission({ guardians: [{ ...nameless, guardianId: existing }] })).expect(201)
    ).body as StudentProfile;
    expect(picked.guardians[0]!.guardianId).toBe(existing);
    // A new guardian on the same phone: needs a name; shares the phone's login.
    const unnamed = await admit(admission({ guardians: [{ ...nameless, createNew: true }] }));
    expect(unnamed.status).toBe(422);
    const added = (
      await admit(
        admission({ guardians: [{ ...nameless, createNew: true, nameEn: 'Uncle' }] }),
      ).expect(201)
    ).body as StudentProfile;
    expect(added.guardians[0]!.guardianId).not.toBe(existing);
    expect(added.guardians[0]).toMatchObject({ nameEn: 'Uncle', canLogIn: true });
    // Not both.
    await admit(
      admission({ guardians: [{ ...nameless, guardianId: existing, createNew: true }] }),
    ).expect(400);
  });

  it('guardian lookup by phone: admins only, this institute only, its own names and the children', async () => {
    const phone = randomPhone();
    await admit(
      admission({
        nameEn: 'Child One',
        guardians: [{ phone, nameBn: 'বাবা', nameEn: 'Dad', relation: 'FATHER', isPrimary: true }],
      }),
    ).expect(201);
    await admit(
      admission({
        nameEn: 'Child Two',
        guardians: [
          { phone, nameEn: 'Uncle', relation: 'UNCLE', isPrimary: true, createNew: true },
        ],
      }),
    ).expect(201);
    const local = `0${phone.slice(4)}`; // 01XXXXXXXXX, as typed in the form
    const found = (
      await http(h).get('/guardians').query({ phone: local }).set(bearer(admin)).expect(200)
    ).body as GuardianMatch[];
    expect(found).toMatchObject([
      { nameBn: 'বাবা', nameEn: 'Dad', children: [{ nameEn: 'Child One', classLevel: {} }] },
      { nameEn: 'Uncle', children: [{ nameEn: 'Child Two' }] },
    ]);
    // A deactivated child is not listed.
    const two = found[1]!;
    const child = await withTenant(h.prisma, tenantId, (tx) =>
      tx.studentGuardian.findFirstOrThrow({ where: { guardianId: two.id } }),
    );
    await http(h).post(`/students/${child.studentId}/deactivate`).set(bearer(admin)).expect(200);
    const later = (
      await http(h).get('/guardians').query({ phone: local }).set(bearer(admin)).expect(200)
    ).body as GuardianMatch[];
    expect(later[1]).toMatchObject({ nameEn: 'Uncle', children: [] });
    await http(h).get('/guardians').query({ phone: local }).set(bearer(teacher)).expect(403);
    await http(h).get('/guardians').query({ phone: '0171' }).set(bearer(admin)).expect(400);
    const other = (await createTenant(h)).id;
    const otherAdmin = (await otpLogin(h, (await addMember(h, other, { roles: ['ADMIN'] })).phone))
      .accessToken;
    expect(
      (await http(h).get('/guardians').query({ phone: local }).set(bearer(otherAdmin)).expect(200))
        .body,
    ).toEqual([]);
  });

  it('roll unique in the section; birth registration and code unique; section must match', async () => {
    await admit(
      admission({
        enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionA, roll: 40 },
      }),
    ).expect(201);
    const taken = await admit(
      admission({
        enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionA, roll: 40 },
      }),
    ).expect(409);
    expect(taken.body.code).toBe('ROLL_TAKEN');
    const reg = birthReg();
    await admit(admission({ birthRegistrationNo: reg })).expect(201);
    const dup = await admit(admission({ birthRegistrationNo: reg })).expect(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', field: 'birthRegistrationNo' });
    await admit(admission({ studentCode: 'TST-2026-0001' })).expect(409);
    const mismatch = await admit(
      admission({
        enrolment: { academicYearId: yearId, classLevelId: otherClassLevelId, sectionId: sectionA },
      }),
    ).expect(422);
    expect(mismatch.body.code).toBe('SECTION_MISMATCH');
    await admit(
      admission({ enrolment: { academicYearId: yearId, classLevelId, sectionId: null, roll: 3 } }),
    ).expect(422);
  });

  it('capacity is respected; inactive sections cannot be picked', async () => {
    await admit(
      admission({ enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionB } }),
    ).expect(201);
    const full = await admit(
      admission({ enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionB } }),
    ).expect(422);
    expect(full.body.code).toBe('SECTION_FULL');
    const off = await withTenant(h.prisma, tenantId, (tx) =>
      tx.section.create({
        data: { tenantId, academicYearId: yearId, classLevelId, name: 'Off', isActive: false },
      }),
    );
    await admit(
      admission({ enrolment: { academicYearId: yearId, classLevelId, sectionId: off.id } }),
    ).expect(422);
  });

  it("another institute's year/class/section cannot be used; its students are not found", async () => {
    const other = (await createTenant(h)).id;
    const otherAdmin = (await otpLogin(h, (await addMember(h, other, { roles: ['ADMIN'] })).phone))
      .accessToken;
    await admit(admission(), otherAdmin).expect(404); // our year id is unknown there
    const mine = (await admit(admission()).expect(201)).body as StudentProfile;
    await http(h).get(`/students/${mine.id}`).set(bearer(otherAdmin)).expect(404);
    await http(h)
      .patch(`/students/${mine.id}`)
      .set(bearer(otherAdmin))
      .send({ nameEn: 'x' })
      .expect(404);
    await http(h).post(`/students/${mine.id}/deactivate`).set(bearer(otherAdmin)).expect(404);
  });

  it('siblings share the guardian the admin picks; names are not overwritten', async () => {
    const phone = randomPhone();
    const g = { phone, nameBn: 'মা', nameEn: 'Mother', relation: 'MOTHER', isPrimary: true };
    const a = (await admit(admission({ guardians: [g] })).expect(201)).body as StudentProfile;
    const guardianId = a.guardians[0]!.guardianId;
    const b = (
      await admit(admission({ guardians: [{ ...g, nameEn: 'Someone else', guardianId }] })).expect(
        201,
      )
    ).body as StudentProfile;
    expect(b.guardians[0]!.guardianId).toBe(guardianId);
    expect(b.guardians[0]!.nameEn).toBe('Mother');
    // A guardian with another phone cannot be picked.
    const wrong = await admit(
      admission({ guardians: [{ ...g, phone: randomPhone(), guardianId }] }),
    ).expect(422);
    expect(wrong.body.code).toBe('GUARDIAN_MISMATCH');
    // Nor one of another institute, even with the same phone (RLS: not found there).
    const other = (await createTenant(h)).id;
    const theirs = await withTenant(h.prisma, other, (tx) =>
      tx.guardian.create({ data: { tenantId: other, phone, nameEn: 'Elsewhere' } }),
    );
    const foreign = await admit(admission({ guardians: [{ ...g, guardianId: theirs.id }] })).expect(
      422,
    );
    expect(foreign.body.code).toBe('GUARDIAN_MISMATCH');
  });

  it('edits, guardians (primary swap, rules), transfer, deactivate', async () => {
    const p = (
      await admit(
        admission({
          enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionA, roll: 21 },
        }),
      ).expect(201)
    ).body as StudentProfile;
    const edited = (
      await http(h)
        .patch(`/students/${p.id}`)
        .set(bearer(admin))
        .send({ religion: 'ISLAM', dateOfBirth: '২০১৩-০৫-১৭' })
        .expect(200)
    ).body as StudentProfile;
    expect(edited).toMatchObject({ religion: 'ISLAM', dateOfBirth: '2013-05-17' });

    const withMother = (
      await http(h)
        .post(`/students/${p.id}/guardians`)
        .set(bearer(admin))
        .send({ phone: randomPhone(), nameBn: 'মা', relation: 'MOTHER', isPrimary: true })
        .expect(201)
    ).body as StudentProfile;
    expect(withMother.guardians.filter((g) => g.isPrimary).map((g) => g.relation)).toEqual([
      'MOTHER',
    ]);
    const father = withMother.guardians.find((g) => g.relation === 'FATHER')!;
    const mother = withMother.guardians.find((g) => g.relation === 'MOTHER')!;
    await http(h)
      .delete(`/students/${p.id}/guardians/${mother.linkId}`)
      .set(bearer(admin))
      .expect(409);
    await http(h)
      .patch(`/students/${p.id}/guardians/${father.linkId}`)
      .set(bearer(admin))
      .send({ isPrimary: true })
      .expect(200);
    const one = (
      await http(h)
        .delete(`/students/${p.id}/guardians/${mother.linkId}`)
        .set(bearer(admin))
        .expect(200)
    ).body as StudentProfile;
    expect(one.guardians).toHaveLength(1);
    await http(h)
      .delete(`/students/${p.id}/guardians/${father.linkId}`)
      .set(bearer(admin))
      .expect(409);

    // Transfer within the year and class level; roll must be free there.
    const sectionC = await withTenant(h.prisma, tenantId, (tx) =>
      tx.section.create({ data: { tenantId, academicYearId: yearId, classLevelId, name: 'C' } }),
    );
    const moved = (
      await http(h)
        .post(`/students/${p.id}/transfer`)
        .set(bearer(admin))
        .send({ sectionId: sectionC.id, roll: '৫' })
        .expect(200)
    ).body as StudentProfile;
    expect(moved.enrolments[0]).toMatchObject({ section: { id: sectionC.id }, roll: 5 });

    // Deactivate: soft delete, roll released, hidden from the list, no further writes.
    const off = (await http(h).post(`/students/${p.id}/deactivate`).set(bearer(admin)).expect(200))
      .body as StudentProfile;
    expect(off).toMatchObject({ status: 'INACTIVE' });
    expect(off.deletedAt).not.toBeNull();
    expect(off.enrolments[0]!.roll).toBeNull();
    const list = (await http(h).get('/students?limit=100').set(bearer(admin)).expect(200)).body as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).not.toContain(p.id);
    await http(h).patch(`/students/${p.id}`).set(bearer(admin)).send({ nameEn: 'x' }).expect(409);
    // Roll 5 in C is free again.
    await admit(
      admission({
        enrolment: { academicYearId: yearId, classLevelId, sectionId: sectionC.id, roll: 5 },
      }),
    ).expect(201);
  });

  it('review fixes: names checked against stored values; past rolls kept on deactivation', async () => {
    const p = (await admit(admission()).expect(201)).body as StudentProfile;
    // Clearing one of two names is fine; clearing the last one is not.
    await http(h).patch(`/students/${p.id}`).set(bearer(admin)).send({ nameBn: null }).expect(200);
    const r = await http(h)
      .patch(`/students/${p.id}`)
      .set(bearer(admin))
      .send({ nameEn: null })
      .expect(422);
    expect(r.body.code).toBe('NAME_REQUIRED');
    // A guardian cannot lose their last name either.
    const link = p.guardians[0]!;
    await http(h)
      .patch(`/students/${p.id}/guardians/${link.linkId}`)
      .set(bearer(admin))
      .send({ nameBn: null })
      .expect(422);

    // An enrolment in an older year keeps its roll when the student is deactivated.
    const old = await withTenant(h.prisma, tenantId, async (tx) => {
      const y = await tx.academicYear.create({
        data: {
          tenantId,
          name: '2025',
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-12-31'),
        },
      });
      const sec = await tx.section.create({
        data: { tenantId, academicYearId: y.id, classLevelId, name: 'Old' },
      });
      return tx.enrolment.create({
        data: {
          tenantId,
          studentId: p.id,
          academicYearId: y.id,
          classLevelId,
          sectionId: sec.id,
          roll: 9,
        },
      });
    });
    await http(h).post(`/students/${p.id}/deactivate`).set(bearer(admin)).expect(200);
    const kept = await withTenant(h.prisma, tenantId, (tx) =>
      tx.enrolment.findUniqueOrThrow({ where: { id: old.id } }),
    );
    expect(kept.roll).toBe(9);
  });

  it('guardian logins are audited as membership grants', async () => {
    await admit(admission()).expect(201);
    const rows = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'membership', action: 'CREATE' } }),
    );
    expect(rows.some((r) => (r.newValues as { via?: string }).via === 'guardian')).toBe(true);
  });

  it('concurrent admissions get distinct codes', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => admit(admission())));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const codes = results.map((r) => (r.body as StudentProfile).studentCode);
    expect(new Set(codes).size).toBe(5);
  });

  it('every change is audited', async () => {
    const rows = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ select: { entity: true, action: true } }),
    );
    const kinds = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    for (const k of [
      'student:CREATE',
      'student:UPDATE',
      'student:DELETE',
      'student_guardian:CREATE',
      'student_guardian:UPDATE',
      'student_guardian:DELETE',
      'enrolment:UPDATE',
      'student_settings:UPDATE',
    ])
      expect(kinds).toContain(k);
  });
});
