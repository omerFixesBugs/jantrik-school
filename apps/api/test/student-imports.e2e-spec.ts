import { withContext, withTenant } from '@jantrik/db';
import {
  IMPORT_FIELDS,
  templateHeader,
  toCsv,
  type ImportPreviewPage,
  type StudentImportSummary,
} from '@jantrik/shared';
import writeXlsxFile from 'write-excel-file/node';
import { zipSync } from 'fflate';
import { assertInflatedSize, assertZipSize } from '../src/imports/spreadsheet.js';
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

const local = () => randomPhone().slice(3); // 01XXXXXXXXX
const reg = () => `2014${String(Math.floor(Math.random() * 1e13)).padStart(13, '0')}`;

describe('student import', () => {
  let h: Harness;
  let tenantId: string;
  let admin: string;
  let teacher: string;
  let otherAdmin: string;

  const upload = (body: Buffer | string, name: string, token = admin) =>
    http(h).post('/student-imports').set(bearer(token)).attach('file', Buffer.from(body), name);
  const summary = async (id: string) =>
    (await http(h).get(`/student-imports/${id}`).set(bearer(admin)).expect(200))
      .body as StudentImportSummary;
  const waitDone = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const s = await summary(id);
      if (s.status === 'DONE' || s.status === 'FAILED') return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('import did not finish');
  };

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    const login = async (t: string, roles: ('ADMIN' | 'TEACHER')[]) =>
      (await otpLogin(h, (await addMember(h, t, { roles })).phone)).accessToken;
    admin = await login(tenantId, ['ADMIN']);
    teacher = await login(tenantId, ['TEACHER']);
    otherAdmin = await login((await createTenant(h)).id, ['ADMIN']);
    await withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const c6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
      await tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: c6.id, name: 'ক' },
      });
      await tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: c6.id, name: 'খ', capacity: 1 },
      });
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('is for OWNER/ADMIN only', async () => {
    await http(h).get('/student-imports/template.csv').set(bearer(teacher)).expect(403);
    await upload('a', 'x.csv', teacher).expect(403);
  });

  it('templates: .xlsx (a zip) and .csv with Bangla + English headers and a BOM', async () => {
    const x = await http(h)
      .get('/student-imports/template.xlsx')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const c = await http(h).get('/student-imports/template.csv').set(bearer(admin)).expect(200);
    expect(c.text.charCodeAt(0)).toBe(0xfeff);
    expect(c.text).toContain('নাম (বাংলা) / Name (Bangla)');
    expect(c.text).toContain('অভিভাবকের মোবাইল / Guardian phone');
  });

  it('upload → auto-mapping → preview with exact errors → run → students, guardians, enrolments', async () => {
    const phone1 = local();
    const sharedReg = reg();
    const csv = toCsv([
      [
        'নাম',
        'Name',
        'Class',
        'Section',
        'Roll',
        'Mobile',
        'Relation',
        'Birth reg',
        'Date of birth',
        'Guardian name',
      ],
      [
        'রাফি',
        'Rafi',
        'ষষ্ঠ শ্রেণি',
        'ক',
        '১',
        phone1.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!),
        'বাবা',
        sharedReg,
        '17/05/2014',
        'Karim',
      ],
      ['মিম', 'Mim', 'Class 6', 'ক', '2', local().slice(1), 'মা', reg(), '2014-02-01', 'Rina'], // Excel dropped the 0
      ['', '', 'Class 6', 'ক', '1', '123', 'cousin', '42', '31/02/2014', ''], // many problems + roll 1 twice
      ['সুমি', 'Sumi', 'Class 6', 'খ', '', local(), '', sharedReg, '', 'Sumi Parent'], // birth reg twice in file
      ['=HYPERLINK("http://evil","x")', '', 'Unknown', '', '', local(), '', '', '', 'X'],
    ]);
    const up = (await upload(csv, 'students.csv').expect(201)).body as StudentImportSummary;
    expect(up).toMatchObject({ status: 'VALIDATED', rowCount: 5 });
    expect(up.mapping).toMatchObject({
      nameBn: 0,
      nameEn: 1,
      classLevel: 2,
      section: 3,
      roll: 4,
      guardianPhone: 5,
      guardianRelation: 6,
      birthRegistrationNo: 7,
      dateOfBirth: 8,
      guardianNameEn: 9,
    });
    expect(up.counts).toMatchObject({ ok: 2, error: 3 });

    const errors = (
      await http(h)
        .get(`/student-imports/${up.id}/rows?filter=error`)
        .set(bearer(admin))
        .expect(200)
    ).body as ImportPreviewPage;
    const byRow = new Map(errors.rows.map((r) => [r.row, r.errors.map((e) => e.code)]));
    expect(byRow.get(4)).toEqual(
      expect.arrayContaining([
        'NAME_MISSING',
        'PHONE_INVALID',
        'RELATION_UNKNOWN',
        'BIRTH_REG_INVALID',
        'DATE_INVALID',
      ]),
    );
    expect(byRow.get(5)).toEqual(['BIRTH_REG_DUPLICATE_IN_FILE']);
    expect(byRow.get(6)).toEqual(['CLASS_UNKNOWN']);

    const started = (
      await http(h).post(`/student-imports/${up.id}/run`).set(bearer(admin)).expect(202)
    ).body as StudentImportSummary;
    expect(started.status).toBe('QUEUED');
    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(admin)).expect(409); // no second run
    const done = await waitDone(up.id);
    expect(done).toMatchObject({ status: 'DONE', counts: { imported: 2, error: 3 } });

    const students = await withTenant(h.prisma, tenantId, (tx) =>
      tx.student.findMany({
        include: { enrolments: true, guardians: { include: { guardian: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const rafi = students.find((s) => s.nameEn === 'Rafi')!;
    expect(rafi.birthRegistrationNo).toBe(sharedReg);
    expect(rafi.enrolments[0]!.roll).toBe(1);
    expect(rafi.guardians[0]!.guardian.phone).toBe(`+88${phone1}`);
    expect(rafi.guardians[0]!.relation).toBe('FATHER');
    // Raw rows are cleared when done.
    const row = await withTenant(h.prisma, tenantId, (tx) =>
      tx.studentImport.findUniqueOrThrow({ where: { id: up.id } }),
    );
    expect(row.rows).toBeNull();

    // The report is formula-safe.
    const report = await http(h)
      .get(`/student-imports/${up.id}/report.csv?locale=en`)
      .set(bearer(admin))
      .expect(200);
    expect(report.text).toContain('Imported');
    expect(report.text).not.toMatch(/(^|,)=HYPERLINK/m);

    // Re-importing the same file creates no duplicates.
    const again = (await upload(csv, 'students.csv').expect(201)).body as StudentImportSummary;
    // Sumi shares Rafi's birth registration number, so she matches him too.
    expect(again.counts).toMatchObject({ ok: 0, exists: 3 });
    await http(h).post(`/student-imports/${again.id}/run`).set(bearer(admin)).expect(422);
    const count = await withTenant(h.prisma, tenantId, (tx) =>
      tx.student.count({ where: { nameEn: 'Rafi' } }),
    );
    expect(count).toBe(1);
  });

  it('reads .xlsx: Bangla headers, numbers, dates; capacity respected', async () => {
    const xlsx = await writeXlsxFile(
      [
        [
          templateHeader('nameBn'),
          templateHeader('classLevel'),
          templateHeader('section'),
          templateHeader('guardianPhone'),
          templateHeader('dateOfBirth'),
          templateHeader('guardianNameBn'),
        ],
        ['আরিফ', 'ষষ্ঠ শ্রেণি', 'খ', Number(local()), new Date('2014-03-04T00:00:00Z'), 'বাবা'],
        ['নাবিল', 'ষষ্ঠ শ্রেণি', 'খ', local(), null, 'মা'], // খ has one seat
      ],
      { dateFormat: 'yyyy-mm-dd' },
    ).toBuffer();
    const up = (await upload(xlsx, 'students.xlsx').expect(201)).body as StudentImportSummary;
    expect(up.counts).toMatchObject({ ok: 1, error: 1 });
    const rows = (
      await http(h).get(`/student-imports/${up.id}/rows`).set(bearer(admin)).expect(200)
    ).body as ImportPreviewPage;
    expect(rows.rows[0]!.values.dateOfBirth).toBe('2014-03-04');
    expect(rows.rows[1]!.errors.map((e) => e.code)).toEqual(['SECTION_FULL']);
    // Remap: ignore the date column.
    const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, up.mapping[f]]));
    mapping['dateOfBirth'] = null;
    const remapped = (
      await http(h)
        .put(`/student-imports/${up.id}/mapping`)
        .set(bearer(admin))
        .send({ mapping })
        .expect(200)
    ).body as StudentImportSummary;
    expect(remapped.mapping.dateOfBirth).toBeNull();
  });

  it('refuses bad files: type, size, rows, zip bombs', async () => {
    await upload('hello', 'notes.txt').expect(422);
    await upload(Buffer.alloc(6 * 1024 * 1024, 65), 'big.csv').expect(413);
    const many = toCsv([
      ['Name', 'Class', 'Mobile'],
      ...Array.from({ length: 5001 }, () => ['A', 'Class 6', local()]),
    ]);
    const r = await upload(many, 'many.csv').expect(422);
    expect(r.body.code).toBe('TOO_MANY_ROWS');
    // A fake .xlsx declaring a 60 MB file inside.
    const bomb = fakeZip(60 * 1024 * 1024);
    expect(() => assertZipSize(bomb)).toThrow();
    await upload(bomb, 'bomb.xlsx').expect(422);
    // A real deflate bomb: 60 MB of zeros compress to ~60 KB. Counting what really inflates
    // catches it even if the central directory lies about the sizes.
    const real = Buffer.from(zipSync({ 'xl/sheet.xml': new Uint8Array(60 * 1024 * 1024) }));
    expect(real.length).toBeLessThan(1024 * 1024);
    expect(() => assertInflatedSize(real)).toThrow();
    // A normal small archive passes.
    expect(() =>
      assertInflatedSize(Buffer.from(zipSync({ 'a.xml': new Uint8Array(1000) }))),
    ).not.toThrow();
  });

  it("another institute cannot see or run this institute's imports", async () => {
    const up = (
      await upload(
        toCsv([
          ['Name', 'Class', 'Mobile'],
          ['A', 'Class 6', local()],
        ]),
        'a.csv',
      ).expect(201)
    ).body as StudentImportSummary;
    await http(h).get(`/student-imports/${up.id}`).set(bearer(otherAdmin)).expect(404);
    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(otherAdmin)).expect(404);
    await http(h).get(`/student-imports/${up.id}/report.csv`).set(bearer(otherAdmin)).expect(404);
    const theirs = (await http(h).get('/student-imports').set(bearer(otherAdmin)).expect(200))
      .body as StudentImportSummary[];
    expect(theirs.map((i) => i.id)).not.toContain(up.id);
  });
  it('guardians: phone + name links; nameless links only one known guardian; never guessed', async () => {
    const e164 = (l: string) => `+88${l}`;
    const linked = local();
    const otherName = local();
    const solo = local();
    const two = local();
    const fresh = local();
    const named = local();
    const ids = await withTenant(h.prisma, tenantId, async (tx) => {
      const mk = (phone: string, nameEn: string) =>
        tx.guardian.create({
          data: { tenantId, phone: e164(phone), nameEn },
          select: { id: true },
        });
      return {
        karim: (await mk(linked, 'Karim Uddin')).id,
        other: (await mk(otherName, 'Karim Uddin')).id,
        solo: (await mk(solo, 'Solo Parent')).id,
        twoA: (await mk(two, 'Parent A')).id,
        twoB: (await mk(two, 'Parent B')).id,
      };
    });
    const csv = toCsv([
      ['Name', 'Class', 'Section', 'Mobile', 'Guardian name'],
      ['Rafi', 'Class 6', 'ক', linked, 'karim  uddin'], // 2: same name (case, spaces) → linked
      ['Mim', 'Class 6', 'ক', otherName, 'Someone Else'], // 3: name differs → new guardian
      ['Nila', 'Class 6', 'ক', solo, ''], // 4: no name, one guardian → linked by phone
      ['Tuli', 'Class 6', 'ক', two, ''], // 5: no name, two guardians → error
      ['Joy', 'Class 6', 'ক', fresh, ''], // 6: no name, unknown → generated name
      ['Joya', 'Class 6', 'ক', fresh, ''], // 7: sibling of Joy → linked by phone (row 6's)
      ['Rumi', 'Class 6', 'ক', named, 'Father Six'], // 8: new
      ['Rumki', 'Class 6', 'ক', named, 'Father Six'], // 9: sibling → linked (row 8's)
    ]);
    const up = (await upload(csv, 'guardians.csv').expect(201)).body as StudentImportSummary;
    const preview = (
      await http(h).get(`/student-imports/${up.id}/rows`).set(bearer(admin)).expect(200)
    ).body as ImportPreviewPage;
    const byRow = new Map(preview.rows.map((r) => [r.row, r]));
    const note = (row: number) => byRow.get(row)!.notes?.map((n) => n.code) ?? [];
    expect(note(2)).toEqual(['GUARDIAN_LINKED']);
    expect(note(3)).toEqual(['GUARDIAN_NEW_SAME_PHONE']);
    expect(note(4)).toEqual(['GUARDIAN_LINKED_BY_PHONE_ONLY']);
    expect(byRow.get(5)).toMatchObject({
      status: 'ERROR',
      errors: [{ code: 'GUARDIAN_NAME_NEEDED', field: 'guardianNameBn' }],
    });
    expect(note(6)).toEqual(['GUARDIAN_NAME_GENERATED']);
    expect(note(7)).toEqual(['GUARDIAN_LINKED_BY_PHONE_ONLY']);
    expect(note(8)).toEqual([]);
    expect(note(9)).toEqual(['GUARDIAN_LINKED']);

    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(admin)).expect(202);
    const done = await waitDone(up.id);
    expect(done.counts).toMatchObject({ imported: 7, error: 1 });
    const guardianOf = async (nameEn: string) =>
      withTenant(h.prisma, tenantId, async (tx) => {
        const st = await tx.student.findFirstOrThrow({
          where: { nameEn },
          orderBy: { createdAt: 'desc' },
          select: { guardians: { select: { guardian: true } } },
        });
        return st.guardians[0]!.guardian;
      });
    expect((await guardianOf('Rafi')).id).toBe(ids.karim);
    const mim = await guardianOf('Mim');
    expect(mim.id).not.toBe(ids.other);
    expect(mim.nameEn).toBe('Someone Else');
    expect((await guardianOf('Nila')).id).toBe(ids.solo);
    const joy = await guardianOf('Joy');
    expect(joy).toMatchObject({ nameBn: 'Joy-এর অভিভাবক', nameEn: 'Guardian of Joy' });
    // The child's name is the institute's label only, never the person's own (global) name.
    const own = await withContext(h.prisma, { userId: joy.userId! }, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: joy.userId! },
        select: { name: true, nameBn: true },
      }),
    );
    expect(own).toEqual({ name: 'Guardian', nameBn: null });
    expect((await guardianOf('Joya')).id).toBe(joy.id);
    expect((await guardianOf('Rumki')).id).toBe((await guardianOf('Rumi')).id);
    // Notes and the error are in the report too.
    const report = await http(h)
      .get(`/student-imports/${up.id}/report.csv`)
      .query({ locale: 'en' })
      .set(bearer(admin))
      .expect(200);
    for (const text of [
      'Notes',
      'Guardian 1: linked to an existing guardian',
      'Guardian 1: name did not match; added as a new guardian with this phone',
      'Guardian 1: no name in the list; linked by phone only, please check',
      'Guardian 1: no name; named after the student, rename later',
      'Several guardians have this phone; add the guardian name to pick one',
    ]) {
      expect(report.text).toContain(text);
    }
  });
  it('guardians that changed between the check and the run: the row is not imported', async () => {
    const phone = local();
    const csv = toCsv([
      ['Name', 'Class', 'Section', 'Mobile', 'Guardian name'],
      ['Shanto', 'Class 6', 'ক', phone, ''], // preview: unknown phone → a generated guardian
    ]);
    const up = (await upload(csv, 'changed.csv').expect(201)).body as StudentImportSummary;
    const preview = (
      await http(h).get(`/student-imports/${up.id}/rows`).set(bearer(admin)).expect(200)
    ).body as ImportPreviewPage;
    expect(preview.rows[0]!.notes?.map((n) => n.code)).toEqual(['GUARDIAN_NAME_GENERATED']);
    // Meanwhile someone adds a guardian on that phone.
    await withTenant(h.prisma, tenantId, (tx) =>
      tx.guardian.create({ data: { tenantId, phone: `+88${phone}`, nameEn: 'Neighbour' } }),
    );
    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(admin)).expect(202);
    expect((await waitDone(up.id)).counts).toMatchObject({ imported: 0, error: 1 });
    const after = (
      await http(h).get(`/student-imports/${up.id}/rows`).set(bearer(admin)).expect(200)
    ).body as ImportPreviewPage;
    expect(after.rows[0]).toMatchObject({
      status: 'ERROR',
      errors: [{ code: 'GUARDIAN_CHANGED', field: 'guardianNameBn' }],
    });
    expect(after.rows[0]!.notes).toBeUndefined(); // the preview's "will be named" is gone
    const report = await http(h)
      .get(`/student-imports/${up.id}/report.csv`)
      .query({ locale: 'en' })
      .set(bearer(admin))
      .expect(200);
    expect(report.text).toContain('The guardians on this phone changed after the check');
    expect(report.text).not.toContain('named after the student');
  });
});

/** A minimal zip: one central-directory entry claiming `size` uncompressed bytes. */
function fakeZip(size: number): Buffer {
  const name = Buffer.from('xl/sheet.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt32LE(size, 24);
  cd.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, cd, name, eocd]);
}
