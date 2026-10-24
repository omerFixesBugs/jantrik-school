import { randomUUID } from 'node:crypto';
import { findOrCreateUser, withContext, withTenant } from '@jantrik/db';
import { ZkDeviceSimulator } from '@jantrik/device-sim';
import { todayIn, toCsv, type StudentImportSummary } from '@jantrik/shared';
import {
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomIp,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
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

    // A gate device: the teacher has a device ID, punches, and trusted the device's address.
    ingest = await createIngestHarness();
    const created = (
      await http(h)
        .post('/attendance/devices')
        .set(bearer(s.admin))
        .send({
          serialNo: `N${randomUUID().replace(/-/g, '').slice(0, 15)}`,
          name: 'Gate',
          direction: 'IN',
        })
        .expect(201)
    ).body as { id: string; serialNo: string };
    deviceId = created.id;
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.devicePerson.create({
        data: { tenantId: s.tenantId, deviceUserId: '9001', staffUserId: userId },
      }),
    );
    const device = new ZkDeviceSimulator({
      baseUrl: ingest.baseUrl,
      sn: created.serialNo,
      forwardedFor: randomIp(),
    });
    expect((await device.punch('9001')).status).toBe(200);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.deviceSourceIp.updateMany({ where: { deviceId }, data: { trustedById: userId } }),
    );
    const punchId = (
      (await http(h).get('/attendance/devices/punches').set(bearer(s.admin)).expect(200)).body as {
        punches: { id: string }[];
      }
    ).punches[0]!.id;
    keep(
      'POST punch review',
      await http(h)
        .post(`/attendance/devices/punches/${punchId}/review`)
        .set(bearer(s.admin))
        .send({ action: 'OK' })
        .expect(200),
    );
  });
  let importId: string;
  let ingest: IngestHarness;
  let deviceId: string;

  afterAll(async () => {
    await ingest.queue.obliterate({ force: true });
    await ingest.close();
    await h.close();
  });

  it('the writes made while setting up return no global names either', () => {
    expect(writes.length).toBe(7);
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
      ['/guardians', { phone: person.phone }],
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
      ['/attendance/devices'],
      ['/attendance/devices/punches'],
      ['/attendance/devices/punches', { deviceId }],
      [`/attendance/devices/${deviceId}/ips`],
      ['/attendance/devices/unknown-ids'],
      ['/attendance/devices/alerts'],
      ['/attendance/device-people'],
      ['/attendance/device-people/collisions'],
      ['/attendance/device-people/csv', { locale: 'en' }],
      ['/attendance/device-people/csv', { locale: 'bn' }],
      ['/attendance/device-people/stale'],
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

  it('device people: answers naming people use staff profiles (defaults, import, ID taken)', async () => {
    const send = (method: 'post' | 'put', path: string, body: object) =>
      http(h)[method](path).set(bearer(s.admin)).send(body);
    const bodies = [
      (
        await send('post', '/attendance/device-people/defaults', {
          kind: 'ALL',
          dryRun: true,
        }).expect(200)
      ).body,
      (
        await http(h)
          .post('/attendance/device-people/import')
          .set(bearer(s.admin))
          .attach(
            'file',
            Buffer.from(
              toCsv([
                ['staff_phone', 'device_id'],
                [person.phone.slice(3), '9002'],
              ]),
            ),
            'ids.csv',
          )
          .expect(200)
      ).body,
      (
        await send('put', '/attendance/device-people', { studentId, deviceUserId: '9001' }).expect(
          409,
        )
      ).body,
    ];
    for (const body of bodies) expect(leaks(JSON.stringify(body))).toEqual([]);
    expect(JSON.stringify(bodies[1])).toContain('Typed Teacher');
    expect(bodies[2]).toMatchObject({
      holder: { name: 'Typed Teacher', nameBn: 'টাইপ করা শিক্ষক' },
    });
  });

  it('the typed names are what this institute shows', async () => {
    expect(await text(s.admin, '/staff')).toContain('Typed Teacher');
    expect(await text(s.admin, `/students/${studentId}`)).toContain('Typed Guardian');
    expect(
      await text(s.admin, '/attendance/sessions', { sectionId: s.sectionA, date: TODAY() }),
    ).toContain('Typed Teacher');
    // The punch feed and who trusted the device's address.
    expect(await text(s.admin, '/attendance/devices/punches')).toContain('Typed Teacher');
    expect(await text(s.admin, `/attendance/devices/${deviceId}/ips`)).toContain('Typed Teacher');
    expect(await text(s.admin, '/attendance/device-people')).toContain('Typed Teacher');
    expect(await text(s.admin, '/attendance/device-people/csv', { locale: 'en' })).toContain(
      'Typed Teacher',
    );
  });
});
