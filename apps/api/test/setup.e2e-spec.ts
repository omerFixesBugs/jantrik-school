import { withTenant } from '@jantrik/db';
import {
  suggestNextYear,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupLabel,
  type SetupSection,
  type SetupShift,
  type SetupStudyGroup,
  type SetupSubject,
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

describe('institute setup', () => {
  let h: Harness;
  let tenantId: string;
  let admin: string;
  let teacher: string;
  let otherAdmin: string; // another tenant
  let year: SetupAcademicYear | undefined;

  const get = <T>(path: string, token = admin) =>
    http(h)
      .get(path)
      .set(bearer(token))
      .expect(200)
      .then((r) => r.body as T);

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    const login = async (t: string, roles: ('ADMIN' | 'TEACHER')[]) =>
      (await otpLogin(h, (await addMember(h, t, { roles })).phone)).accessToken;
    admin = await login(tenantId, ['ADMIN']);
    teacher = await login(tenantId, ['TEACHER']);
    otherAdmin = await login((await createTenant(h)).id, ['ADMIN']);
    [year] = await get<SetupAcademicYear[]>('/setup/academic-years');
  });

  afterAll(async () => {
    await h.close();
  });

  it('is for OWNER/ADMIN only', async () => {
    await http(h).get('/setup/class-levels').set(bearer(teacher)).expect(403);
    await http(h).get('/setup/class-levels').expect(401);
  });

  describe('academic years', () => {
    it('one current year; create next year copies sections but no students', async () => {
      expect(year!.isCurrent).toBe(true);
      const classLevels = await get<SetupClassLevel[]>('/setup/class-levels');
      const section = (
        await http(h)
          .post('/setup/sections')
          .set(bearer(admin))
          .send({
            academicYearId: year!.id,
            classLevelId: classLevels[0]!.id,
            name: 'ক',
            capacity: 40,
          })
          .expect(201)
      ).body as SetupSection;

      const next = suggestNextYear(year!);
      expect(next).toMatchObject({ name: '2027', startDate: '2027-01-01', endDate: '2027-12-31' });
      const created = (
        await http(h)
          .post('/setup/academic-years')
          .set(bearer(admin))
          .send({ ...next, copySectionsFrom: year!.id })
          .expect(201)
      ).body as SetupAcademicYear;
      expect(created).toMatchObject({ isCurrent: false, sectionCount: 1, enrolmentCount: 0 });
      const copied = await get<SetupSection[]>(`/setup/sections?academicYearId=${created.id}`);
      expect(copied).toMatchObject([
        { name: 'ক', capacity: 40, classLevelId: section.classLevelId },
      ]);

      // Same name again: 409.
      await http(h).post('/setup/academic-years').set(bearer(admin)).send(next).expect(409);

      await http(h)
        .post(`/setup/academic-years/${created.id}/current`)
        .set(bearer(admin))
        .expect(200);
      const years = await get<SetupAcademicYear[]>('/setup/academic-years');
      expect(years.filter((y) => y.isCurrent).map((y) => y.id)).toEqual([created.id]);
      // Back to the original current year for the rest of the tests.
      await http(h)
        .post(`/setup/academic-years/${year!.id}/current`)
        .set(bearer(admin))
        .expect(200);
    });

    it('rejects bad ranges and refuses deleting a year in use', async () => {
      await http(h)
        .post('/setup/academic-years')
        .set(bearer(admin))
        .send({ name: 'x', startDate: '2030-01-01', endDate: '2029-12-31' })
        .expect(400);
      const r = await http(h)
        .delete(`/setup/academic-years/${year!.id}`)
        .set(bearer(admin))
        .expect(409);
      expect(r.body.code).toBe('IN_USE');
      const empty = (
        await http(h)
          .post('/setup/academic-years')
          .set(bearer(admin))
          .send({ name: '2040', startDate: '2040-01-01', endDate: '2040-12-31' })
          .expect(201)
      ).body as SetupAcademicYear;
      await http(h).delete(`/setup/academic-years/${empty.id}`).set(bearer(admin)).expect(204);
    });
  });

  describe('class levels, sections, shifts, subjects, groups', () => {
    it('class level in use cannot be deleted, only deactivated', async () => {
      const [cl] = await get<SetupClassLevel[]>('/setup/class-levels');
      expect(cl!.usage.subjects).toBeGreaterThan(0); // copied from the template
      const r = await http(h)
        .delete(`/setup/class-levels/${cl!.id}`)
        .set(bearer(admin))
        .expect(409);
      expect(r.body).toMatchObject({ code: 'IN_USE', usage: { subjects: cl!.usage.subjects } });
      const off = (
        await http(h)
          .patch(`/setup/class-levels/${cl!.id}`)
          .set(bearer(admin))
          .send({ isActive: false })
          .expect(200)
      ).body as SetupClassLevel;
      expect(off.isActive).toBe(false);
      // No new sections in a deactivated class level.
      await http(h)
        .post('/setup/sections')
        .set(bearer(admin))
        .send({ academicYearId: year!.id, classLevelId: cl!.id, name: 'নতুন' })
        .expect(422);
      await http(h)
        .patch(`/setup/class-levels/${cl!.id}`)
        .set(bearer(admin))
        .send({ isActive: true })
        .expect(200);
    });

    it('creates, renames and deletes an unused class level; codes are normalised and unique', async () => {
      const created = (
        await http(h)
          .post('/setup/class-levels')
          .set(bearer(admin))
          .send({ code: 'play group', nameBn: 'প্লে', nameEn: 'Play' })
          .expect(201)
      ).body as SetupClassLevel;
      expect(created.code).toBe('PLAY_GROUP');
      await http(h)
        .post('/setup/class-levels')
        .set(bearer(admin))
        .send({ code: 'PLAY_GROUP', nameBn: 'x', nameEn: 'x' })
        .expect(409);
      await http(h)
        .patch(`/setup/class-levels/${created.id}`)
        .set(bearer(admin))
        .send({ nameEn: 'Playgroup' })
        .expect(200);
      await http(h).delete(`/setup/class-levels/${created.id}`).set(bearer(admin)).expect(204);
    });

    it('shifts: HH:MM with Bangla digits, end after start; a section can use one', async () => {
      const shift = (
        await http(h)
          .post('/setup/shifts')
          .set(bearer(admin))
          .send({ nameBn: 'প্রভাতি', nameEn: 'Morning', startTime: '০৭:৩০', endTime: '12:00' })
          .expect(201)
      ).body as SetupShift;
      expect(shift).toMatchObject({ startTime: '07:30', endTime: '12:00', usage: { sections: 0 } });
      await http(h)
        .post('/setup/shifts')
        .set(bearer(admin))
        .send({ nameBn: 'x', nameEn: 'Late', startTime: '12:00', endTime: '11:00' })
        .expect(400);
      await http(h)
        .patch(`/setup/shifts/${shift.id}`)
        .set(bearer(admin))
        .send({ endTime: '07:00' })
        .expect(422);

      const [cl] = await get<SetupClassLevel[]>('/setup/class-levels');
      const section = (
        await http(h)
          .post('/setup/sections')
          .set(bearer(admin))
          .send({ academicYearId: year!.id, classLevelId: cl!.id, name: 'খ', shiftId: shift.id })
          .expect(201)
      ).body as SetupSection;
      expect(section.shiftId).toBe(shift.id);
      await http(h).delete(`/setup/shifts/${shift.id}`).set(bearer(admin)).expect(409);
      await http(h).delete(`/setup/sections/${section.id}`).set(bearer(admin)).expect(204);
      await http(h).delete(`/setup/shifts/${shift.id}`).set(bearer(admin)).expect(204);
    });

    it('section with students cannot be deleted; capacity cannot go below enrolment', async () => {
      const [cl] = await get<SetupClassLevel[]>('/setup/class-levels');
      const section = (
        await http(h)
          .post('/setup/sections')
          .set(bearer(admin))
          .send({ academicYearId: year!.id, classLevelId: cl!.id, name: 'গ' })
          .expect(201)
      ).body as SetupSection;
      await withTenant(h.prisma, tenantId, async (tx) => {
        for (const roll of [1, 2]) {
          const s = await tx.student.create({
            data: { tenantId, studentCode: `G-${roll}-${Date.now()}`, nameEn: 'S' },
          });
          await tx.enrolment.create({
            data: {
              tenantId,
              studentId: s.id,
              academicYearId: year!.id,
              classLevelId: cl!.id,
              sectionId: section.id,
              roll,
            },
          });
        }
      });
      await http(h).delete(`/setup/sections/${section.id}`).set(bearer(admin)).expect(409);
      await http(h)
        .patch(`/setup/sections/${section.id}`)
        .set(bearer(admin))
        .send({ capacity: 1 })
        .expect(422);
      await http(h)
        .patch(`/setup/sections/${section.id}`)
        .set(bearer(admin))
        .send({ isActive: false })
        .expect(200);
      await http(h)
        .post('/setup/sections')
        .set(bearer(admin))
        .send({ academicYearId: year!.id, classLevelId: cl!.id, name: 'গ' })
        .expect(409);
    });

    it('subjects per class level with an optional group and optional flag', async () => {
      const [cl] = await get<SetupClassLevel[]>('/setup/class-levels');
      const group = (
        await http(h)
          .post('/setup/study-groups')
          .set(bearer(admin))
          .send({ code: 'ARTS', nameBn: 'কলা', nameEn: 'Arts' })
          .expect(201)
      ).body as SetupStudyGroup;
      const subject = (
        await http(h)
          .post('/setup/subjects')
          .set(bearer(admin))
          .send({
            classLevelId: cl!.id,
            studyGroupId: group.id,
            code: 'MUSIC',
            nameBn: 'সংগীত',
            nameEn: 'Music',
            isOptional: true,
          })
          .expect(201)
      ).body as SetupSubject;
      expect(subject).toMatchObject({ isOptional: true, studyGroupId: group.id });
      const list = await get<SetupSubject[]>(`/setup/subjects?classLevelId=${cl!.id}`);
      expect(list.map((s) => s.code)).toContain('MUSIC');
      await http(h).delete(`/setup/study-groups/${group.id}`).set(bearer(admin)).expect(409);
      await http(h).delete(`/setup/subjects/${subject.id}`).set(bearer(admin)).expect(204);
      await http(h).delete(`/setup/study-groups/${group.id}`).set(bearer(admin)).expect(204);
    });
  });

  describe('review fixes', () => {
    it('a PATCH of only isActive keeps the other fields (sortOrder)', async () => {
      const g = (
        await http(h)
          .post('/setup/study-groups')
          .set(bearer(admin))
          .send({ code: 'VOC', nameBn: 'কারিগরি', nameEn: 'Vocational', sortOrder: 7 })
          .expect(201)
      ).body as SetupStudyGroup;
      const off = (
        await http(h)
          .patch(`/setup/study-groups/${g.id}`)
          .set(bearer(admin))
          .send({ isActive: false })
          .expect(200)
      ).body as SetupStudyGroup;
      expect(off).toMatchObject({ isActive: false, sortOrder: 7, code: 'VOC' });
    });

    it("another tenant's shift, group or year cannot be used", async () => {
      const theirShift = (
        await http(h)
          .post('/setup/shifts')
          .set(bearer(otherAdmin))
          .send({ nameBn: 'x', nameEn: 'Theirs', startTime: '08:00', endTime: '09:00' })
          .expect(201)
      ).body as SetupShift;
      const theirGroup = (
        await http(h)
          .post('/setup/study-groups')
          .set(bearer(otherAdmin))
          .send({ code: 'THEIRS', nameBn: 'x', nameEn: 'x' })
          .expect(201)
      ).body as SetupStudyGroup;
      const theirYear = (await get<SetupAcademicYear[]>('/setup/academic-years', otherAdmin))[0]!;
      const [cl] = await get<SetupClassLevel[]>('/setup/class-levels');
      await http(h)
        .post('/setup/sections')
        .set(bearer(admin))
        .send({ academicYearId: year!.id, classLevelId: cl!.id, name: 'চ', shiftId: theirShift.id })
        .expect(404);
      await http(h)
        .post('/setup/subjects')
        .set(bearer(admin))
        .send({
          classLevelId: cl!.id,
          studyGroupId: theirGroup.id,
          code: 'X1',
          nameBn: 'x',
          nameEn: 'x',
        })
        .expect(404);
      await http(h)
        .post('/setup/academic-years')
        .set(bearer(admin))
        .send({
          name: '2050',
          startDate: '2050-01-01',
          endDate: '2050-12-31',
          copySectionsFrom: theirYear.id,
        })
        .expect(404);
    });
  });

  describe('labels', () => {
    it('edits labels (shown in /me/context) and keeps the template defaults', async () => {
      const labels = await get<SetupLabel[]>('/setup/labels');
      expect(labels.find((l) => l.key === 'section')).toMatchObject({
        bn: 'শাখা',
        defaultEn: 'Section',
      });
      await http(h)
        .put('/setup/labels')
        .set(bearer(admin))
        .send({ labels: [{ key: 'section', bn: 'ব্যাচ', en: 'Batch' }] })
        .expect(200);
      const ctx = await get<{ labels: Record<string, { bn: string; en: string }> }>('/me/context');
      expect(ctx.labels['section']).toEqual({ bn: 'ব্যাচ', en: 'Batch' });
      await http(h)
        .put('/setup/labels')
        .set(bearer(admin))
        .send({ labels: [{ key: 'not_a_label', bn: 'x', en: 'x' }] })
        .expect(400);
    });
  });

  describe('tenant isolation', () => {
    it("another institute's admin sees none of it and cannot touch it", async () => {
      const mine = await get<SetupClassLevel[]>('/setup/class-levels');
      const theirs = await get<SetupClassLevel[]>('/setup/class-levels', otherAdmin);
      expect(theirs.map((c) => c.id)).not.toEqual(expect.arrayContaining([mine[0]!.id]));
      await http(h)
        .patch(`/setup/class-levels/${mine[0]!.id}`)
        .set(bearer(otherAdmin))
        .send({ nameEn: 'Hacked' })
        .expect(404);
      await http(h).delete(`/setup/academic-years/${year!.id}`).set(bearer(otherAdmin)).expect(404);
      await http(h)
        .post(`/setup/academic-years/${year!.id}/current`)
        .set(bearer(otherAdmin))
        .expect(404);
      // Creating a section in my year from the other tenant: the year is not found there.
      await http(h)
        .post('/setup/sections')
        .set(bearer(otherAdmin))
        .send({ academicYearId: year!.id, classLevelId: theirs[0]!.id, name: 'x' })
        .expect(404);
      expect(
        await get<SetupSection[]>(`/setup/sections?academicYearId=${year!.id}`, otherAdmin),
      ).toEqual([]);
    });

    it('every setup change is audited', async () => {
      const rows = await withTenant(h.prisma, tenantId, (tx) =>
        tx.auditLog.findMany({ select: { entity: true, action: true } }),
      );
      const entities = new Set(rows.map((r) => `${r.entity}:${r.action}`));
      for (const e of [
        'academic_year:CREATE',
        'academic_year:UPDATE',
        'academic_year:DELETE',
        'class_level:UPDATE',
        'class_level:DELETE',
        'section:CREATE',
        'shift:CREATE',
        'subject:CREATE',
        'study_group:DELETE',
        'tenant_labels:UPDATE',
      ])
        expect(entities).toContain(e);
    });
  });
});
