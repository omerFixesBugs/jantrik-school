import { withTenant } from '@jantrik/db';
import type {
  ExamRoomView,
  ExamSetupSubjects,
  ExamStaffMember,
  GradingSchemeView,
  SectionSubjectTeachersView,
  SubjectChoicesView,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { examsSchool, type ExamsSchool } from './support/exams.js';

const MATH_MARKS = {
  passRule: 'PER_COMPONENT',
  components: [
    { key: 'cq', kind: 'CQ', nameBn: 'সৃজনশীল', nameEn: 'CQ', fullMarks: 60, passMarks: 20 },
    {
      key: 'MCQ',
      kind: 'MCQ',
      nameBn: 'বহুনির্বাচনি',
      nameEn: 'MCQ',
      fullMarks: 40,
      passMarks: 13,
    },
  ],
  passGroups: [],
};

describe('exams setup (OWNER/ADMIN)', () => {
  let h: Harness;
  let s: ExamsSchool;
  let other: ExamsSchool;

  const auditRows = (tenantId: string, entity: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity }, orderBy: { createdAt: 'asc' } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    other = await examsSchool(h);
  });
  afterAll(() => h.close());

  describe('who may use it', () => {
    const routes = (x: ExamsSchool) =>
      [
        ['get', `/exams/setup/subjects?classLevelId=${x.class9}`],
        ['put', `/exams/setup/subjects/${x.subjects.nine['MATH']}/marks`],
        ['post', '/exams/setup/subjects/load-template'],
        ['get', `/exams/setup/sections/${x.sections.nine}/subject-teachers`],
        ['put', `/exams/setup/sections/${x.sections.nine}/subject-teachers`],
        ['get', `/exams/setup/sections/${x.sections.nine}/subject-choices`],
        ['put', `/exams/setup/sections/${x.sections.nine}/subject-choices`],
        ['get', '/exams/staff'],
        ['get', '/exams/rooms'],
        ['post', '/exams/rooms'],
        ['get', '/exams/grading'],
      ] as const;

    it('teachers, accountants and guardians get 403 on every setup route', async () => {
      for (const token of [s.tokens.teacher, s.tokens.accountant, s.tokens.guardian]) {
        for (const [method, path] of routes(s)) {
          await http(h)[method](path).set(bearer(token)).send({}).expect(403);
        }
      }
    });

    it('the module switched off gives 403 even to the owner', async () => {
      const tenantId = (await createTenant(h, { modules: ['ATTENDANCE'] })).id;
      const owner = await addMember(h, tenantId, { roles: ['OWNER'] });
      const token = (await otpLogin(h, owner.phone)).accessToken;
      await http(h).get('/exams/rooms').set(bearer(token)).expect(403);
      await http(h).get('/exams/grading').set(bearer(token)).expect(403);
    });

    it("another institute's subject or section is not found", async () => {
      await http(h)
        .put(`/exams/setup/subjects/${other.subjects.nine['MATH']}/marks`)
        .set(bearer(s.tokens.admin))
        .send(MATH_MARKS)
        .expect(404);
      await http(h)
        .get(`/exams/setup/sections/${other.sections.nine}/subject-teachers`)
        .set(bearer(s.tokens.admin))
        .expect(404);
      await http(h)
        .get(`/exams/setup/subjects?classLevelId=${other.class9}`)
        .set(bearer(s.tokens.owner))
        .expect(404);
    });
  });

  describe('subject marks', () => {
    it("lists the class's subjects with the template's parts and the grading bands", async () => {
      const r = (
        await http(h)
          .get(`/exams/setup/subjects?classLevelId=${s.class9}`)
          .set(bearer(s.tokens.admin))
          .expect(200)
      ).body as ExamSetupSubjects;
      expect(r.classLevel.code).toBe('CLASS_9');
      expect(r.bands.map((b) => b.letter)).toEqual(['A+', 'A', 'A-', 'B', 'C', 'D', 'F']);
      const ban = r.subjects.find((x) => x.code === 'BAN')!;
      expect(ban).toMatchObject({ passRule: 'COMBINED', fromTemplate: true });
      expect(ban.components.map((c) => c.key)).toEqual(['P1_CQ', 'P1_MCQ', 'P2_CQ', 'P2_MCQ']);
      expect(ban.passGroups).toEqual([
        { kind: 'CQ', passMarks: 46 },
        { kind: 'MCQ', passMarks: 20 },
      ]);
      const bio = r.subjects.find((x) => x.code === 'BIO')!;
      expect(bio).toMatchObject({ isOptional: true, studyGroup: { code: 'SCIENCE' } });
    });

    it('replaces the parts and pass rule; audited', async () => {
      const id = s.subjects.nine['MATH']!;
      const r = (
        await http(h)
          .put(`/exams/setup/subjects/${id}/marks`)
          .set(bearer(s.tokens.admin))
          .send(MATH_MARKS)
          .expect(200)
      ).body as ExamSetupSubjects['subjects'][number];
      expect(r.components.map((c) => [c.key, c.fullMarks, c.passMarks])).toEqual([
        ['CQ', 60, 20],
        ['MCQ', 40, 13],
      ]);
      const audit = await auditRows(s.tenantId, 'subject_components');
      expect(audit.at(-1)).toMatchObject({ entityId: id, action: 'UPDATE' });
      expect(JSON.stringify(audit.at(-1)!.oldValues)).toContain('"fullMarks":70');
    });

    it('COMBINED needs a pass mark for every kind, at most its full marks', async () => {
      const id = s.subjects.nine['BAN']!;
      const parts = [
        {
          key: 'P1',
          kind: 'WRITTEN',
          nameBn: '১ম',
          nameEn: '1st',
          fullMarks: 100,
          passMarks: null,
        },
        {
          key: 'P2',
          kind: 'WRITTEN',
          nameBn: '২য়',
          nameEn: '2nd',
          fullMarks: 100,
          passMarks: null,
        },
      ];
      const put = (body: object) =>
        http(h).put(`/exams/setup/subjects/${id}/marks`).set(bearer(s.tokens.owner)).send(body);
      await put({ passRule: 'COMBINED', components: parts, passGroups: [] }).expect(400);
      await put({
        passRule: 'COMBINED',
        components: parts,
        passGroups: [{ kind: 'WRITTEN', passMarks: 201 }],
      }).expect(400);
      await put({
        passRule: 'COMBINED',
        components: parts,
        passGroups: [{ kind: 'CQ', passMarks: 10 }],
      }).expect(400);
      await put({
        passRule: 'PER_COMPONENT',
        components: parts,
        passGroups: [{ kind: 'WRITTEN', passMarks: 66 }],
      }).expect(400);
      await put({
        passRule: 'PER_COMPONENT',
        components: [parts[0], { ...parts[0], nameEn: 'again' }],
        passGroups: [],
      }).expect(400);
      const ok = await put({
        passRule: 'COMBINED',
        components: parts,
        passGroups: [{ kind: 'WRITTEN', passMarks: 66 }],
      }).expect(200);
      expect(ok.body).toMatchObject({
        passRule: 'COMBINED',
        passGroups: [{ kind: 'WRITTEN', passMarks: 66 }],
      });
    });

    it("loading the template's parts fills only subjects that have none", async () => {
      const ban = s.subjects.six['BAN']!;
      await withTenant(h.prisma, s.tenantId, async (tx) => {
        await tx.subjectComponent.deleteMany({ where: { subjectId: ban } });
        await tx.subject.update({ where: { id: ban }, data: { passRule: 'COMBINED' } });
      });
      const r = await http(h)
        .post('/exams/setup/subjects/load-template')
        .set(bearer(s.tokens.admin))
        .expect(200);
      expect(r.body).toEqual({ filled: 1 });
      const again = await http(h)
        .post('/exams/setup/subjects/load-template')
        .set(bearer(s.tokens.admin))
        .expect(200);
      expect(again.body).toEqual({ filled: 0 });
      const list = (
        await http(h)
          .get(`/exams/setup/subjects?classLevelId=${s.class6}`)
          .set(bearer(s.tokens.admin))
          .expect(200)
      ).body as ExamSetupSubjects;
      expect(list.subjects.find((x) => x.code === 'BAN')).toMatchObject({
        passRule: 'PER_COMPONENT',
        components: [
          { key: 'CQ', fullMarks: 70, passMarks: 23 },
          { key: 'MCQ', fullMarks: 30, passMarks: 10 },
        ],
      });
    });
  });

  describe('subject teachers', () => {
    const put = (assignments: { subjectId: string; userIds: string[] }[], token = s.tokens.admin) =>
      http(h)
        .put(`/exams/setup/sections/${s.sections.six}/subject-teachers`)
        .set(bearer(token))
        .send({ assignments });

    it('assigns teachers per subject; shows the class teacher; audited', async () => {
      const r = (
        await put([
          { subjectId: s.subjects.six['BAN']!, userIds: [s.userIds.teacher] },
          {
            subjectId: s.subjects.six['MATH']!,
            userIds: [s.userIds.otherTeacher, s.userIds.admin],
          },
        ]).expect(200)
      ).body as SectionSubjectTeachersView;
      expect(r.classTeacher?.id).toBe(s.userIds.teacher);
      const ban = r.subjects.find((x) => x.subject.code === 'BAN')!;
      expect(ban.teachers.map((t) => t.id)).toEqual([s.userIds.teacher]);
      const math = r.subjects.find((x) => x.subject.code === 'MATH')!;
      expect(math.teachers.map((t) => t.id).sort()).toEqual(
        [s.userIds.otherTeacher, s.userIds.admin].sort(),
      );
      expect(r.subjects.find((x) => x.subject.code === 'SCI')!.teachers).toEqual([]);
      const audit = await auditRows(s.tenantId, 'section_subject_teachers');
      expect(audit.at(-1)).toMatchObject({ entityId: s.sections.six, action: 'UPDATE' });
      // A second save replaces the whole list.
      const again = (
        await put([
          { subjectId: s.subjects.six['BAN']!, userIds: [s.userIds.otherTeacher] },
        ]).expect(200)
      ).body as SectionSubjectTeachersView;
      expect(again.subjects.filter((x) => x.teachers.length > 0)).toHaveLength(1);
    });

    it("only active staff of this institute; only subjects of the section's class", async () => {
      const guardianOnly = await addMember(h, s.tenantId, { roles: ['GUARDIAN'] });
      for (const userId of [s.userIds.accountant, guardianOnly.userId, other.userIds.teacher]) {
        const r = await put([{ subjectId: s.subjects.six['BAN']!, userIds: [userId] }]).expect(422);
        expect(r.body.code).toBe('NOT_STAFF');
      }
      const r = await put([
        { subjectId: s.subjects.nine['PHY']!, userIds: [s.userIds.teacher] },
      ]).expect(422);
      expect(r.body.code).toBe('SUBJECT_NOT_IN_CLASS');
      await put([{ subjectId: other.subjects.six['BAN']!, userIds: [s.userIds.teacher] }]).expect(
        422,
      );
    });

    it('a subject with a subject teacher cannot be deleted in setup (409 IN_USE)', async () => {
      await put([{ subjectId: s.subjects.six['REL']!, userIds: [s.userIds.teacher] }]).expect(200);
      const r = await http(h)
        .delete(`/setup/subjects/${s.subjects.six['REL']}`)
        .set(bearer(s.tokens.admin))
        .expect(409);
      expect(r.body).toMatchObject({ code: 'IN_USE', usage: { subjectTeachers: 1 } });
    });

    it('lists the staff who can be assigned (no accountants or guardians)', async () => {
      const staff = (await http(h).get('/exams/staff').set(bearer(s.tokens.admin)).expect(200))
        .body as ExamStaffMember[];
      const ids = staff.map((m) => m.id);
      expect(ids).toEqual(
        expect.arrayContaining([s.userIds.owner, s.userIds.admin, s.userIds.teacher]),
      );
      expect(ids).not.toContain(s.userIds.accountant);
    });
  });

  describe('subject choices (the elective pool)', () => {
    const [sci, bus] = [0, 1];
    const put = (
      students: { studentId: string; choices: { subjectId: string; kind: string }[] }[],
    ) =>
      http(h)
        .put(`/exams/setup/sections/${s.sections.nine}/subject-choices`)
        .set(bearer(s.tokens.admin))
        .send({ students });

    it('a science student takes Biology as compulsory and Higher Maths as the 4th', async () => {
      const r = (
        await put([
          {
            studentId: s.students.nine[sci]!.id,
            choices: [
              { subjectId: s.subjects.nine['BIO']!, kind: 'COMPULSORY' },
              { subjectId: s.subjects.nine['HMATH']!, kind: 'OPTIONAL' },
            ],
          },
        ]).expect(200)
      ).body as SubjectChoicesView;
      expect(r.pool.map((p) => p.code).sort()).toEqual(['BIO', 'HMATH']);
      const student = r.students.find((x) => x.id === s.students.nine[sci]!.id)!;
      expect(student.studyGroup?.code).toBe('SCIENCE');
      expect(student.choices).toEqual(
        expect.arrayContaining([
          { subjectId: s.subjects.nine['BIO'], kind: 'COMPULSORY' },
          { subjectId: s.subjects.nine['HMATH'], kind: 'OPTIONAL' },
        ]),
      );
      expect((await auditRows(s.tenantId, 'student_subject_choices')).at(-1)).toMatchObject({
        entityId: s.sections.nine,
      });
    });

    it("refuses a second 4th subject, a non-elective, another group's elective, another section", async () => {
      await put([
        {
          studentId: s.students.nine[sci]!.id,
          choices: [
            { subjectId: s.subjects.nine['BIO']!, kind: 'OPTIONAL' },
            { subjectId: s.subjects.nine['HMATH']!, kind: 'OPTIONAL' },
          ],
        },
      ]).expect(400);
      let r = await put([
        {
          studentId: s.students.nine[sci]!.id,
          choices: [{ subjectId: s.subjects.nine['PHY']!, kind: 'COMPULSORY' }],
        },
      ]).expect(422);
      expect(r.body.code).toBe('NOT_ELECTIVE');
      r = await put([
        {
          studentId: s.students.nine[bus]!.id,
          choices: [{ subjectId: s.subjects.nine['BIO']!, kind: 'OPTIONAL' }],
        },
      ]).expect(422);
      expect(r.body.code).toBe('NOT_ELECTIVE');
      r = await put([
        {
          studentId: s.students.six[0]!.id,
          choices: [{ subjectId: s.subjects.nine['BIO']!, kind: 'OPTIONAL' }],
        },
      ]).expect(422);
      expect(r.body.code).toBe('NOT_IN_SECTION');
    });

    it('a chosen subject cannot be deleted in setup (409 IN_USE)', async () => {
      const r = await http(h)
        .delete(`/setup/subjects/${s.subjects.nine['HMATH']}`)
        .set(bearer(s.tokens.owner))
        .expect(409);
      expect(r.body).toMatchObject({ code: 'IN_USE', usage: { choices: 1 } });
    });
  });

  describe('rooms', () => {
    it('create, list, rename, delete; at most 500 seats; names unique', async () => {
      const created = (
        await http(h)
          .post('/exams/rooms')
          .set(bearer(s.tokens.admin))
          .send({ name: 'Room 101', rows: 8, cols: 5 })
          .expect(201)
      ).body as ExamRoomView;
      expect(created).toMatchObject({ name: 'Room 101', capacity: 40, isActive: true });
      await http(h)
        .post('/exams/rooms')
        .set(bearer(s.tokens.admin))
        .send({ name: 'Hall', rows: 26, cols: 20 })
        .expect(400);
      const dup = await http(h)
        .post('/exams/rooms')
        .set(bearer(s.tokens.admin))
        .send({ name: 'Room 101', rows: 1, cols: 1 })
        .expect(409);
      expect(dup.body.code).toBe('DUPLICATE');
      const renamed = await http(h)
        .patch(`/exams/rooms/${created.id}`)
        .set(bearer(s.tokens.admin))
        .send({ name: 'Room 102', rows: 8, cols: 5, isActive: false })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: 'Room 102', isActive: false });
      const list = (await http(h).get('/exams/rooms').set(bearer(s.tokens.admin)).expect(200))
        .body as ExamRoomView[];
      expect(list.map((r) => r.name)).toEqual(['Room 102']);
      await http(h).delete(`/exams/rooms/${created.id}`).set(bearer(s.tokens.admin)).expect(204);
      await http(h)
        .delete(`/exams/rooms/${other.sections.six}`)
        .set(bearer(s.tokens.admin))
        .expect(404);
      expect((await auditRows(s.tenantId, 'exam_rooms')).map((a) => a.action)).toEqual([
        'CREATE',
        'UPDATE',
        'DELETE',
      ]);
    });
  });

  describe('grading', () => {
    it('shows the default scheme with its bands and GPA rules; edits the rules; audited', async () => {
      const list = (await http(h).get('/exams/grading').set(bearer(s.tokens.admin)).expect(200))
        .body as GradingSchemeView[];
      expect(list).toHaveLength(1);
      const scheme = list[0]!;
      expect(scheme).toMatchObject({
        isDefault: true,
        roundingMode: 'NONE',
        gpaMax: 5,
        optionalBonusAbove: 2,
        gpaDecimals: 2,
        gpaRounding: 'TRUNCATE',
        compulsoryFailZero: true,
      });
      expect(scheme.bands[0]).toEqual({
        minPercent: 80,
        maxPercent: 100,
        letter: 'A+',
        gradePoint: 5,
      });
      const rules = {
        roundingMode: 'ROUND_HALF_UP',
        gpaMax: 5,
        optionalBonusAbove: 2,
        gpaDecimals: 2,
        gpaRounding: 'ROUND_HALF_UP',
        compulsoryFailZero: true,
      };
      const saved = await http(h)
        .put(`/exams/grading/${scheme.id}`)
        .set(bearer(s.tokens.owner))
        .send(rules)
        .expect(200);
      expect(saved.body).toMatchObject({
        roundingMode: 'ROUND_HALF_UP',
        gpaRounding: 'ROUND_HALF_UP',
      });
      await http(h)
        .put(`/exams/grading/${scheme.id}`)
        .set(bearer(s.tokens.owner))
        .send({ ...rules, optionalBonusAbove: 6 })
        .expect(400);
      const otherScheme = (
        await http(h).get('/exams/grading').set(bearer(other.tokens.admin)).expect(200)
      ).body as GradingSchemeView[];
      await http(h)
        .put(`/exams/grading/${otherScheme[0]!.id}`)
        .set(bearer(s.tokens.owner))
        .send(rules)
        .expect(404);
      expect((await auditRows(s.tenantId, 'grading_schemes')).at(-1)).toMatchObject({
        entityId: scheme.id,
        action: 'UPDATE',
      });
    });
  });
});
