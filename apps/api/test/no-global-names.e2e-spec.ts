import { randomUUID } from 'node:crypto';
import { findOrCreateUser, withContext, withTenant } from '@jantrik/db';
import { todayIn, toCsv, type StudentImportSummary } from '@jantrik/shared';
import {
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { school, type School } from './support/school.js';

// Decision #5: a person's global row (users.name / name_bn / email) never leaves the API for
// anyone else. Every institute shows its own names: guardians, students, staff_profiles.
describe('global names never leave the API', () => {
  let h: Harness;
  let s: School;
  let person: { userId: string; phone: string; token: string };
  let studentId: string;
  let legacyId: string;
  const SECRET = { name: 'Secret Global Name', nameBn: 'গোপন নাম', email: '' };
  /** Someone made staff before staff profiles existed (no profile): no fallback to users. */
  const LEGACY = { name: 'Legacy Global Name', nameBn: 'পুরনো গোপন নাম' };
  const TODAY = () => todayIn('Asia/Dhaka');
  /** Bodies of the writes made while setting up (they share builders with the reads). */
  const writes: [string, string][] = [];
  const keep = <T extends { body: unknown }>(what: string, res: T): T => {
    writes.push([what, JSON.stringify(res.body)]);
    return res;
  };

  const leaks = (text: string) =>
    [SECRET.name, SECRET.nameBn, SECRET.email, LEGACY.name, LEGACY.nameBn].filter((secret) =>
      text.includes(secret),
    );
  const text = async (token: string, path: string, query: Record<string, string> = {}) => {
    const res = await http(h)
      .get(path)
      .query(query)
      .set(bearer(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
    expect(res.status, `${path}: ${String(res.body)}`).toBe(200);
    return res.body as string;
  };

  beforeAll(async () => {
    h = await createHarness();
    s = await school(h, { settings: { absentSmsEnabled: false } });

    // The person exists elsewhere, with a global name and email another institute never typed.
    const elsewhere = (await createTenant(h)).id;
    const phone = randomPhone();
    SECRET.email = `secret.${randomUUID().slice(0, 8)}@example.com`;
    const userId = await withTenant(h.prisma, elsewhere, async (tx) => {
      const id = await findOrCreateUser(tx, phone, SECRET.name, SECRET.nameBn);
      await tx.membership.create({ data: { tenantId: elsewhere, userId: id, role: 'GUARDIAN' } });
      return id;
    });
    await withContext(h.prisma, { userId }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { email: SECRET.email } }),
    );

    // Here they become a guardian (admission, typed names), ...
    const { yearId, classLevelId } = await withTenant(h.prisma, s.tenantId, async (tx) => ({
      yearId: (await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } })).id,
      classLevelId: (await tx.section.findUniqueOrThrow({ where: { id: s.sectionA } }))
        .classLevelId,
    }));
    studentId = keep(
      'POST /students',
      await http(h)
        .post('/students')
        .set(bearer(s.admin))
        .send({
          nameBn: 'লিক ছাত্র',
          nameEn: 'Leak Student',
          guardians: [
            {
              phone,
              nameBn: 'টাইপ করা অভিভাবক',
              nameEn: 'Typed Guardian',
              relation: 'FATHER',
              isPrimary: true,
            },
          ],
          enrolment: { academicYearId: yearId, classLevelId, sectionId: s.sectionA, roll: 9 },
        })
        .expect(201),
    ).body.id as string;

    // ... a teacher (invited with a typed name, accepted, assigned to section A) ...
    keep(
      'POST /staff',
      await http(h)
        .post('/staff')
        .set(bearer(s.admin))
        .send({ phone, name: 'Typed Teacher', nameBn: 'টাইপ করা শিক্ষক', roles: ['TEACHER'] })
        .expect(201),
    );
    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${s.tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(204);
    const token = (
      await http(h)
        .post('/auth/switch-tenant')
        .set(bearer(login.accessToken))
        .send({ tenantId: s.tenantId })
        .expect(200)
    ).body.accessToken as string;
    person = { userId, phone, token };
    const teachers = (
      await http(h)
        .get(`/attendance/sections/${s.sectionA}/teachers`)
        .set(bearer(s.admin))
        .expect(200)
    ).body as { user: { id: string }; isClassTeacher: boolean }[];
    keep(
      'PUT section A teachers',
      await http(h)
        .put(`/attendance/sections/${s.sectionA}/teachers`)
        .set(bearer(s.admin))
        .send({
          teachers: [
            ...teachers.map((t) => ({ userId: t.user.id, isClassTeacher: t.isClassTeacher })),
            { userId, isClassTeacher: false },
          ],
        })
        .expect(200),
    );

    // ... and the one who saved today's register.
    keep(
      'PUT section A register',
      await http(h)
        .put('/attendance/sessions')
        .set(bearer(token))
        .send({
          sectionId: s.sectionA,
          date: TODAY(),
          baseVersion: 0,
          submissionId: randomUUID(),
          records: [...s.a.map((st) => st.id), studentId].map((id) => ({
            studentId: id,
            status: 'ABSENT',
          })),
        })
        .expect(200),
    );

    // A legacy teacher without a staff profile teaches section B and saves its register.
    const legacyPhone = randomPhone();
    legacyId = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const id = await findOrCreateUser(tx, legacyPhone, LEGACY.name, LEGACY.nameBn);
      await tx.membership.create({ data: { tenantId: s.tenantId, userId: id, role: 'TEACHER' } });
      return id;
    });
    keep(
      'PUT section B teachers',
      await http(h)
        .put(`/attendance/sections/${s.sectionB}/teachers`)
        .set(bearer(s.admin))
        .send({ teachers: [{ userId: legacyId, isClassTeacher: true }] })
        .expect(200),
    );
    const legacyToken = (await otpLogin(h, legacyPhone)).accessToken;
    keep(
      'PUT section B register',
      await http(h)
        .put('/attendance/sessions')
        .set(bearer(legacyToken))
        .send({
          sectionId: s.sectionB,
          date: TODAY(),
          baseVersion: 0,
          submissionId: randomUUID(),
          records: s.b.map((st) => ({ studentId: st.id, status: 'PRESENT' })),
        })
        .expect(200),
    );

    // An import that names them as a guardian again.
    const classLevel = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.classLevel.findUniqueOrThrow({ where: { id: classLevelId } }),
    );
    const up = (
      await http(h)
        .post('/student-imports')
        .set(bearer(s.admin))
        .attach(
          'file',
          Buffer.from(
            toCsv([
              ['Name', 'Class', 'Section', 'Mobile', 'Guardian name'],
              ['Import Sibling', classLevel.nameEn, 'A', phone.slice(3), 'Typed Guardian'],
            ]),
          ),
          'students.csv',
        )
        .expect(201)
    ).body as StudentImportSummary;
    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(s.admin)).expect(202);
    for (let i = 0; i < 100; i++) {
      const sum = (await http(h).get(`/student-imports/${up.id}`).set(bearer(s.admin))).body as
        StudentImportSummary | undefined;
      if (sum?.status === 'DONE' || sum?.status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    importId = up.id;
  });
  let importId: string;

  afterAll(async () => {
    await h.close();
  });

  it('the writes made while setting up return no global names either', () => {
    expect(writes.length).toBe(6);
    for (const [what, body] of writes) expect(leaks(body), what).toEqual([]);
  });

  it('staff without a profile are shown unnamed, never by their global name', async () => {
    const staff = JSON.parse(await text(s.admin, '/attendance/staff')) as {
      id: string;
      name: string;
    }[];
    expect(staff.find((m) => m.id === legacyId)).toMatchObject({ name: '', nameBn: null });
    const sheet = JSON.parse(
      await text(s.admin, '/attendance/sessions', { sectionId: s.sectionB, date: TODAY() }),
    ) as { session: { updatedBy: { id: string; name: string } } | null };
    expect(sheet.session?.updatedBy).toMatchObject({ id: legacyId, name: '' });
  });

  it('the person really has that global name (self endpoints may show it)', async () => {
    const me = await text(person.token, '/auth/me');
    expect(me).toContain(SECRET.name);
  });

  it('admin: no endpoint returns the global name, Bangla name or email', async () => {
    const month = TODAY().slice(0, 7);
    const paths: [string, Record<string, string>?][] = [
      ['/students'],
      ['/students', { q: 'Leak' }],
      [`/students/${studentId}`],
      ['/staff'],
      ['/attendance/staff'],
      [`/attendance/sections/${s.sectionA}/teachers`],
      [`/attendance/sections/${s.sectionB}/teachers`],
      ['/attendance/sessions', { sectionId: s.sectionA, date: TODAY() }],
      ['/attendance/sessions', { sectionId: s.sectionB, date: TODAY() }],
      ['/attendance/my-sections'],
      ['/attendance/reports/today'],
      ['/attendance/reports/register', { sectionId: s.sectionA, month }],
      ['/attendance/reports/register/csv', { sectionId: s.sectionA, month, locale: 'en' }],
      [`/attendance/reports/students/${studentId}`, { from: `${month}-01`, to: TODAY() }],
      ['/student-imports'],
      [`/student-imports/${importId}`],
      [`/student-imports/${importId}/rows`],
      [`/student-imports/${importId}/report.csv`, { locale: 'en' }],
    ];
    for (const [path, query] of paths) {
      expect(leaks(await text(s.admin, path, query)), path).toEqual([]);
    }
  });

  it('teacher of the section: no endpoint returns the global name, Bangla name or email', async () => {
    const month = TODAY().slice(0, 7);
    const paths: [string, Record<string, string>?][] = [
      ['/students'],
      [`/students/${studentId}`],
      ['/attendance/sessions', { sectionId: s.sectionA, date: TODAY() }],
      ['/attendance/my-sections'],
      ['/attendance/reports/today'],
      ['/attendance/reports/register/csv', { sectionId: s.sectionA, month, locale: 'en' }],
      [`/attendance/reports/students/${studentId}`, { from: `${month}-01`, to: TODAY() }],
    ];
    for (const [path, query] of paths) {
      expect(leaks(await text(s.teacher, path, query)), path).toEqual([]);
    }
  });

  it('the person as a guardian and teacher here sees only this institute’s data', async () => {
    for (const path of ['/me/children', '/me/context', '/attendance/my-sections']) {
      expect(leaks(await text(person.token, path)), path).toEqual([]);
    }
  });

  it('the typed names are what this institute shows', async () => {
    expect(await text(s.admin, '/staff')).toContain('Typed Teacher');
    expect(await text(s.admin, `/students/${studentId}`)).toContain('Typed Guardian');
    expect(
      await text(s.admin, '/attendance/sessions', { sectionId: s.sectionA, date: TODAY() }),
    ).toContain('Typed Teacher');
  });
});
