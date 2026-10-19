import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  todayIn,
  type AttendanceTodayReport,
  type StudentProfile,
  type StudentsPage,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { school, type School } from './support/school.js';

// Least privilege for teachers (step 7 review, decision #19): checked on the JSON/CSV itself.
describe('student data: teachers see full details only for their own sections', () => {
  let h: Harness;
  let s: School;
  const reg = { a: '20141111111111111', b: '20142222222222222' };
  const addr = { a: 'House 1, Mirpur', b: 'House 2, Uttara' };
  let phoneA: string;
  let phoneB: string;

  beforeAll(async () => {
    h = await createHarness();
    s = await school(h, { settings: { absentSmsEnabled: false } });
    phoneA = s.a[0]!.phone;
    phoneB = s.b[0]!.phone;
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.student.update({
        where: { id: s.a[0]!.id },
        data: {
          birthRegistrationNo: reg.a,
          presentAddress: addr.a,
          dateOfBirth: new Date('2014-01-02'),
        },
      });
      await tx.student.update({
        where: { id: s.b[0]!.id },
        data: {
          birthRegistrationNo: reg.b,
          presentAddress: addr.b,
          dateOfBirth: new Date('2014-03-04'),
        },
      });
    });
    // Today: student 1 of A and the only student of B are absent.
    const submit = (sectionId: string, ids: { id: string }[], statuses: string[]) =>
      http(h)
        .put('/attendance/sessions')
        .set(bearer(s.admin))
        .send({
          sectionId,
          date: todayIn('Asia/Dhaka'),
          baseVersion: 0,
          submissionId: randomUUID(),
          records: ids.map((st, i) => ({ studentId: st.id, status: statuses[i] })),
        })
        .expect(200);
    await submit(s.sectionA, s.a, ['ABSENT', 'PRESENT', 'PRESENT']);
    await submit(s.sectionB, s.b, ['ABSENT']);
  });

  afterAll(async () => {
    await h.close();
  });

  const list = async (token: string, q?: string) =>
    http(h)
      .get(`/students?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      .set(bearer(token))
      .expect(200);

  it('list: everyone sees the basics; guardian name/phone only for own sections (and admins)', async () => {
    const r = await list(s.teacher);
    const page = r.body as StudentsPage;
    const a = page.items.find((i) => i.id === s.a[0]!.id)!;
    const b = page.items.find((i) => i.id === s.b[0]!.id)!;
    expect(a.primaryGuardian?.phone).toBe(phoneA);
    expect(b).toMatchObject({
      studentCode: expect.any(String),
      enrolment: { roll: 1 },
      primaryGuardian: null,
    });
    expect(r.text).not.toContain(phoneB);

    const other = await list(s.otherTeacher);
    expect(other.text).not.toContain(phoneA);
    expect(other.text).not.toContain(phoneB);
    expect((other.body as StudentsPage).items.length).toBe(4); // still lists everyone

    const admin = await list(s.admin);
    expect(admin.text).toContain(phoneA);
    expect(admin.text).toContain(phoneB);
  });

  it('search by guardian phone is for admins only', async () => {
    const local = `0${phoneB.slice(4)}`;
    expect(((await list(s.admin, local)).body as StudentsPage).items.map((i) => i.id)).toEqual([
      s.b[0]!.id,
    ]);
    expect(((await list(s.teacher, local)).body as StudentsPage).items).toEqual([]);
    expect(((await list(s.otherTeacher, phoneA.slice(4))).body as StudentsPage).items).toEqual([]);
  });

  it('profile: full for admins and the section teacher, basic (fields absent) for others', async () => {
    const get = (token: string, id: string) =>
      http(h).get(`/students/${id}`).set(bearer(token)).expect(200);

    const own = await get(s.teacher, s.a[0]!.id);
    expect((own.body as StudentProfile).access).toBe('full');
    expect(own.text).toContain(reg.a);
    expect(own.text).toContain(addr.a);
    expect(own.text).toContain(phoneA);

    const notOwn = await get(s.teacher, s.b[0]!.id);
    const p = notOwn.body as StudentProfile;
    expect(p).toMatchObject({
      access: 'basic',
      dateOfBirth: null,
      birthRegistrationNo: null,
      presentAddress: null,
      permanentAddress: null,
      fatherNameBn: null,
      motherNameEn: null,
      guardians: [],
    });
    expect(p.enrolments).toHaveLength(1);
    for (const secret of [reg.b, addr.b, phoneB, '2014-03-04'])
      expect(notOwn.text).not.toContain(secret);

    expect(p).toMatchObject({ gender: null, religion: null, bloodGroup: null });
    // The local 01… form of the phone is absent too.
    expect(notOwn.text).not.toContain(`0${phoneB.slice(4)}`);

    const admin = await get(s.admin, s.b[0]!.id);
    expect((admin.body as StudentProfile).access).toBe('full');
    expect(admin.text).toContain(reg.b);
  });

  it('scope edge cases: TEACHER+ADMIN is full; a past-year or deactivated section is not', async () => {
    const both = await addMember(h, s.tenantId, { roles: ['TEACHER', 'ADMIN'] });
    const bothToken = (await otpLogin(h, both.phone)).accessToken;
    const r = await http(h).get(`/students/${s.b[0]!.id}`).set(bearer(bothToken)).expect(200);
    expect((r.body as StudentProfile).access).toBe('full');

    // A teacher assigned only to a section of another (past) year gets the basics.
    const past = await addMember(h, s.tenantId, { roles: ['TEACHER'] });
    const pastToken = (await otpLogin(h, past.phone)).accessToken;
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const old = await tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: '2019',
          startDate: new Date('2019-01-01'),
          endDate: new Date('2019-12-31'),
        },
      });
      const cl = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
      const sec = await tx.section.create({
        data: { tenantId: s.tenantId, academicYearId: old.id, classLevelId: cl.id, name: 'Old' },
      });
      await tx.sectionTeacher.create({
        data: { tenantId: s.tenantId, sectionId: sec.id, userId: past.userId },
      });
    });
    const pr = await http(h).get(`/students/${s.a[0]!.id}`).set(bearer(pastToken)).expect(200);
    expect((pr.body as StudentProfile).access).toBe('basic');
  });

  it("today's report: absent students' guardian phones only for the section's teachers and admins", async () => {
    const teacher = await http(h)
      .get('/attendance/reports/today')
      .set(bearer(s.teacher))
      .expect(200);
    const t = teacher.body as AttendanceTodayReport;
    expect(t.sections.map((x) => x.section.id)).toEqual([s.sectionA]);
    expect(t.sections[0]!.register!.absent).toMatchObject([
      { id: s.a[0]!.id, guardianPhone: phoneA },
    ]);
    expect(teacher.text).not.toContain(phoneB);

    const admin = await http(h).get('/attendance/reports/today').set(bearer(s.admin)).expect(200);
    expect(admin.text).toContain(phoneA);
    expect(admin.text).toContain(phoneB);

    // A teacher with no sections gets no rows and no phones.
    const other = await http(h)
      .get('/attendance/reports/today')
      .set(bearer(s.otherTeacher))
      .expect(200);
    expect(other.text).not.toContain(phoneA);
    expect(other.text).not.toContain(phoneB);
  });

  it('exports carry no phones, birth registration numbers or addresses', async () => {
    const month = todayIn('Asia/Dhaka').slice(0, 7);
    const csv = await http(h)
      .get(`/attendance/reports/register/csv?sectionId=${s.sectionA}&month=${month}&locale=en`)
      .set(bearer(s.teacher))
      .expect(200);
    for (const secret of [phoneA, phoneA.slice(3), reg.a, addr.a])
      expect(csv.text).not.toContain(secret);
    // Import reports and templates are OWNER/ADMIN only.
    await http(h).get('/student-imports').set(bearer(s.teacher)).expect(403);
  });
});
