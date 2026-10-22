import { withTenant } from '@jantrik/db';
import type {
  FeeAmountsMatrix,
  FeeConcessionView,
  FeeHeadView,
  FeeSettingsView,
  FeeSiblingsView,
  FeeStudentHit,
  FeeTermView,
} from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';

/** Fee setup (step 9, phase A): OWNER/ADMIN; money destinations OWNER only. */
describe('fee setup', () => {
  let h: Harness;
  let s: FeesSchool;
  let other: FeesSchool; // another institute
  let tuition: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
    patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
    delete: (path: string) => http(h).delete(path).set(bearer(token)),
  });
  const audits = (entity: string) =>
    withTenant(h.prisma, s.tenantId, (tx) => tx.auditLog.findMany({ where: { entity } }));

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    other = await feesSchool(h);
    tuition = (
      await api(s.tokens.admin)
        .post('/fees/heads', {
          nameBn: 'মাসিক বেতন',
          nameEn: 'Monthly tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
          fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
          siblingEligible: true,
        })
        .expect(201)
    ).body as FeeHeadView;
  });

  afterAll(() => h.close());

  describe('who may', () => {
    it('setup is for OWNER/ADMIN: teachers, accountants and guardians get 403', async () => {
      for (const token of [s.tokens.teacher, s.tokens.accountant, s.tokens.guardian]) {
        await api(token).get('/fees/heads').expect(403);
        await api(token).get('/fees/settings').expect(403);
      }
      await http(h).get('/fees/heads').expect(401);
      await api(s.tokens.owner).get('/fees/heads').expect(200);
    });

    it('needs the FEES module', async () => {
      const noFees = await feesSchool(h, { modules: ['ATTENDANCE'] });
      await api(noFees.tokens.admin).get('/fees/heads').expect(403);
    });

    it("another institute's rows are 404", async () => {
      await api(other.tokens.admin).patch(`/fees/heads/${tuition.id}`, { nameEn: 'x' }).expect(404);
      await api(other.tokens.admin)
        .post('/fees/concessions', {
          studentId: s.students[0]!.id,
          feeHeadId: tuition.id,
          category: 'GENERAL',
          type: 'FIXED',
          value: 100,
          validFrom: '2026-01-01',
        })
        .expect(404);
    });
  });

  describe('settings', () => {
    it('defaults until saved; saved and audited', async () => {
      const before = (await api(s.tokens.admin).get('/fees/settings').expect(200))
        .body as FeeSettingsView;
      expect(before).toEqual({
        duesFrom: null,
        receiptSmsEnabled: true,
        sibling: null,
        receiptNote: null,
        saved: false,
      });
      const body = {
        duesFrom: '2026-09-01',
        receiptSmsEnabled: true,
        sibling: { type: 'PERCENT', value: 50, fromChild: 2 },
        receiptNote: 'ধন্যবাদ',
      };
      const saved = (await api(s.tokens.admin).put('/fees/settings', body).expect(200))
        .body as FeeSettingsView;
      expect(saved).toEqual({ ...body, saved: true });
      expect(await audits('fee_settings')).toHaveLength(1);
    });

    it('dues start on the 1st of a month; a percentage is 1–100', async () => {
      const base = { receiptSmsEnabled: true, sibling: null, receiptNote: null };
      await api(s.tokens.admin)
        .put('/fees/settings', { ...base, duesFrom: '2026-09-15' })
        .expect(400);
      await api(s.tokens.admin)
        .put('/fees/settings', {
          ...base,
          duesFrom: null,
          sibling: { type: 'PERCENT', value: 150 },
        })
        .expect(400);
    });
  });

  describe('heads', () => {
    it('created with its fine rule; listed; audited', async () => {
      expect(tuition).toMatchObject({
        frequency: 'MONTHLY',
        dueDay: 10,
        fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
        isActive: true,
      });
      const heads = (await api(s.tokens.admin).get('/fees/heads').expect(200))
        .body as FeeHeadView[];
      expect(heads.map((x) => x.id)).toContain(tuition.id);
      expect((await audits('fee_head')).length).toBeGreaterThan(0);
    });

    it('a monthly head needs a due day; a per-day fine needs a cap', async () => {
      const base = { nameBn: 'ক', nameEn: 'k', kind: 'OTHER', frequency: 'MONTHLY' };
      await api(s.tokens.admin).post('/fees/heads', base).expect(400);
      await api(s.tokens.admin)
        .post('/fees/heads', {
          ...base,
          dueDay: 5,
          fine: { type: 'PER_DAY', amountPaisa: 500, capPaisa: null },
        })
        .expect(400);
    });

    it('fields that do not apply are cleared; a change that breaks the head is 422', async () => {
      const yearly = (
        await api(s.tokens.admin)
          .post('/fees/heads', {
            nameBn: 'সেশন ফি',
            nameEn: 'Session fee',
            kind: 'SESSION',
            frequency: 'YEARLY',
            dueDay: 9,
            dueOffsetDays: 30,
          })
          .expect(201)
      ).body as FeeHeadView;
      expect(yearly.dueDay).toBeNull();
      const res = await api(s.tokens.admin)
        .patch(`/fees/heads/${yearly.id}`, { frequency: 'MONTHLY' })
        .expect(422);
      expect(res.body.code).toBe('INVALID_HEAD');
    });

    it('deactivated, never deleted; the name is free again', async () => {
      const exam = (
        await api(s.tokens.admin)
          .post('/fees/heads', {
            nameBn: 'পরীক্ষা ফি',
            nameEn: 'Exam fee',
            kind: 'EXAM',
            frequency: 'PER_TERM',
          })
          .expect(201)
      ).body as FeeHeadView;
      await api(s.tokens.admin)
        .post('/fees/heads', {
          nameBn: 'পরীক্ষা ফি',
          nameEn: 'Exam',
          kind: 'EXAM',
          frequency: 'PER_TERM',
        })
        .expect(409);
      await api(s.tokens.admin).patch(`/fees/heads/${exam.id}`, { isActive: false }).expect(200);
      await api(s.tokens.admin)
        .post('/fees/heads', {
          nameBn: 'পরীক্ষা ফি',
          nameEn: 'Exam',
          kind: 'EXAM',
          frequency: 'PER_TERM',
        })
        .expect(201);
      await api(s.tokens.admin).delete(`/fees/heads/${exam.id}`).expect(404);
    });
  });

  describe('terms', () => {
    it('created per year, dates in order; unused ones can be deleted', async () => {
      const term = (
        await api(s.tokens.admin)
          .post('/fees/terms', {
            academicYearId: s.yearId,
            nameBn: 'প্রথম সাময়িক',
            nameEn: 'First term',
            opensOn: '2026-04-20',
            dueDate: '2026-05-05',
          })
          .expect(201)
      ).body as FeeTermView;
      await api(s.tokens.admin)
        .post('/fees/terms', {
          academicYearId: s.yearId,
          nameBn: 'উল্টো',
          nameEn: 'Backwards',
          opensOn: '2026-05-05',
          dueDate: '2026-04-20',
        })
        .expect(400);
      await api(s.tokens.admin)
        .patch(`/fees/terms/${term.id}`, { opensOn: '2026-06-01' })
        .expect(422);
      const terms = (
        await api(s.tokens.admin).get(`/fees/terms?academicYearId=${s.yearId}`).expect(200)
      ).body as FeeTermView[];
      expect(terms.map((t) => t.id)).toEqual([term.id]);
      await api(other.tokens.admin).delete(`/fees/terms/${term.id}`).expect(404);
      await api(s.tokens.admin).delete(`/fees/terms/${term.id}`).expect(204);
    });
  });

  describe('amounts', () => {
    it('a grid per year: class amounts, a study group override, removal with null', async () => {
      await api(s.tokens.admin)
        .put('/fees/amounts', {
          academicYearId: s.yearId,
          amounts: [
            { feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 100000 },
            { feeHeadId: tuition.id, classLevelId: s.class9, amountPaisa: 150000 },
            {
              feeHeadId: tuition.id,
              classLevelId: s.class9,
              studyGroupId: s.science,
              amountPaisa: 180000,
            },
          ],
        })
        .expect(200);
      let grid = (
        await api(s.tokens.admin).get(`/fees/amounts?academicYearId=${s.yearId}`).expect(200)
      ).body as FeeAmountsMatrix;
      expect(grid.amounts).toHaveLength(3);
      expect(grid.classLevels.length).toBeGreaterThan(5);
      expect(grid.heads.map((x) => x.id)).toContain(tuition.id);

      await api(s.tokens.admin)
        .put('/fees/amounts', {
          academicYearId: s.yearId,
          amounts: [
            { feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 120000 },
            {
              feeHeadId: tuition.id,
              classLevelId: s.class9,
              studyGroupId: s.science,
              amountPaisa: null,
            },
          ],
        })
        .expect(200);
      grid = (await api(s.tokens.admin).get(`/fees/amounts?academicYearId=${s.yearId}`).expect(200))
        .body as FeeAmountsMatrix;
      expect(grid.amounts).toEqual(
        expect.arrayContaining([
          {
            feeHeadId: tuition.id,
            classLevelId: s.class6,
            studyGroupId: null,
            amountPaisa: 120000,
          },
          {
            feeHeadId: tuition.id,
            classLevelId: s.class9,
            studyGroupId: null,
            amountPaisa: 150000,
          },
        ]),
      );
      expect(grid.amounts).toHaveLength(2);
      expect((await audits('fee_amounts')).length).toBeGreaterThan(0);
    });

    it("another institute's head or class cannot be priced", async () => {
      await api(other.tokens.admin)
        .put('/fees/amounts', {
          academicYearId: other.yearId,
          amounts: [{ feeHeadId: tuition.id, classLevelId: other.class6, amountPaisa: 100 }],
        })
        .expect(404);
    });

    it("copies last year's amounts into a new year", async () => {
      const next = await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.academicYear.create({
          data: {
            tenantId: s.tenantId,
            name: '2027',
            startDate: new Date('2027-01-01'),
            endDate: new Date('2027-12-31'),
          },
        }),
      );
      const res = await api(s.tokens.admin)
        .post('/fees/amounts/copy', { fromAcademicYearId: s.yearId, toAcademicYearId: next.id })
        .expect(200);
      expect(res.body).toEqual({ copied: 2 });
      // Nothing is overwritten on a second copy.
      const again = await api(s.tokens.admin)
        .post('/fees/amounts/copy', { fromAcademicYearId: s.yearId, toAcademicYearId: next.id })
        .expect(200);
      expect(again.body).toEqual({ copied: 0 });
    });
  });

  describe('concessions', () => {
    it('half free studentship: the percentage is set for you; one at a time; ended, not deleted', async () => {
      const student = s.students[2]!.id;
      const created = (
        await api(s.tokens.admin)
          .post('/fees/concessions', {
            studentId: student,
            feeHeadId: tuition.id,
            category: 'FREE_HALF',
            validFrom: '2026-01-01',
          })
          .expect(201)
      ).body as FeeConcessionView;
      expect(created).toMatchObject({ type: 'PERCENT', value: 50, endedOn: null });

      const overlap = await api(s.tokens.admin)
        .post('/fees/concessions', {
          studentId: student,
          feeHeadId: tuition.id,
          category: 'GENERAL',
          type: 'FIXED',
          value: 10000,
          validFrom: '2026-06-01',
        })
        .expect(409);
      expect(overlap.body.code).toBe('CONCESSION_OVERLAP');

      await api(s.tokens.admin)
        .post(`/fees/concessions/${created.id}/end`, {
          endedOn: '2026-07-01',
          reason: 'ফলাফল খারাপ',
        })
        .expect(200);
      // Overlapping the ended one's dates is still refused; from its end it is fine.
      await api(s.tokens.admin)
        .post('/fees/concessions', {
          studentId: student,
          feeHeadId: tuition.id,
          category: 'GENERAL',
          type: 'FIXED',
          value: 10000,
          validFrom: '2026-06-01',
        })
        .expect(409);
      await api(s.tokens.admin)
        .post('/fees/concessions', {
          studentId: student,
          feeHeadId: tuition.id,
          category: 'GENERAL',
          type: 'FIXED',
          value: 10000,
          validFrom: '2026-07-01',
        })
        .expect(201);

      const list = (
        await api(s.tokens.admin).get(`/fees/concessions?studentId=${student}`).expect(200)
      ).body as FeeConcessionView[];
      expect(list).toHaveLength(2);
      expect((await audits('fee_concession')).length).toBeGreaterThanOrEqual(3);
    });

    it('a scholarship needs a reason; accountants cannot grant concessions', async () => {
      await api(s.tokens.admin)
        .post('/fees/concessions', {
          studentId: s.students[3]!.id,
          feeHeadId: tuition.id,
          category: 'SCHOLARSHIP',
          type: 'PERCENT',
          value: 25,
          validFrom: '2026-01-01',
        })
        .expect(400);
      await api(s.tokens.accountant)
        .post('/fees/concessions', {
          studentId: s.students[3]!.id,
          feeHeadId: tuition.id,
          category: 'GENERAL',
          type: 'PERCENT',
          value: 25,
          validFrom: '2026-01-01',
        })
        .expect(403);
    });
  });

  describe('siblings', () => {
    it('a shared guardian phone is only a suggestion until an admin confirms the family', async () => {
      let view = (await api(s.tokens.admin).get('/fees/siblings').expect(200))
        .body as FeeSiblingsView;
      expect(view.families).toEqual([]);
      const suggestion = view.suggestions.find((x) =>
        x.students.some((st) => st.id === s.students[0]!.id),
      );
      expect(suggestion?.students.map((st) => st.id).sort()).toEqual(
        [s.students[0]!.id, s.students[1]!.id].sort(),
      );
      expect(suggestion?.phoneMasked).toMatch(/^01\d•+\d{3}$/);

      await api(s.tokens.teacher)
        .post('/fees/siblings', { studentIds: [s.students[0]!.id, s.students[1]!.id] })
        .expect(403);
      await api(s.tokens.admin)
        .post('/fees/siblings', { studentIds: [s.students[0]!.id, s.students[1]!.id] })
        .expect(201);
      view = (await api(s.tokens.admin).get('/fees/siblings').expect(200)).body as FeeSiblingsView;
      expect(view.families).toHaveLength(1);
      expect(view.families[0]!.members.map((m) => m.rank).sort()).toEqual([1, 2]);
      expect(
        view.suggestions.some((x) => x.students.some((st) => st.id === s.students[0]!.id)),
      ).toBe(false);
      expect((await audits('fee_sibling_group')).length).toBeGreaterThan(0);
    });

    it('a student in another family cannot be pulled in; removal needs a reason', async () => {
      const second = await api(s.tokens.admin)
        .post('/fees/siblings', { studentIds: [s.students[2]!.id, s.students[3]!.id] })
        .expect(201);
      const conflict = await api(s.tokens.admin)
        .post('/fees/siblings', { studentIds: [s.students[0]!.id, s.students[2]!.id] })
        .expect(409);
      expect(conflict.body.code).toBe('DIFFERENT_FAMILIES');
      const groupId = (second.body as { groupId: string }).groupId;
      await api(s.tokens.admin)
        .post(`/fees/siblings/${groupId}/members/${s.students[3]!.id}/remove`, {})
        .expect(400);
      await api(s.tokens.admin)
        .post(`/fees/siblings/${groupId}/members/${s.students[3]!.id}/remove`, {
          reason: 'চাচাতো ভাই, আপন নয়',
        })
        .expect(200);
      await api(other.tokens.admin)
        .post('/fees/siblings', { studentIds: [s.students[3]!.id, other.students[0]!.id] })
        .expect(404);
    });
  });

  describe('student search', () => {
    it('by name or guardian phone; the accountant sees the phone masked', async () => {
      const phone = s.students[2]!.phone; // +8801…
      const local = `0${phone.slice(4)}`;
      const asAdmin = (await api(s.tokens.admin).get(`/fees/students?q=${local}`).expect(200))
        .body as FeeStudentHit[];
      expect(asAdmin.map((x) => x.id)).toEqual([s.students[2]!.id]);
      expect(asAdmin[0]!.guardian?.phone).toBe(phone);

      const asAccountant = (
        await api(s.tokens.accountant).get(`/fees/students?q=${local}`).expect(200)
      ).body as FeeStudentHit[];
      expect(asAccountant.map((x) => x.id)).toEqual([s.students[2]!.id]);
      expect(asAccountant[0]!.guardian?.phone).toMatch(/^01\d•+\d{3}$/);
      expect(JSON.stringify(asAccountant)).not.toContain(phone.slice(4));

      const byName = (
        await api(s.tokens.accountant)
          .get(`/fees/students?q=${encodeURIComponent('Student 4')}`)
          .expect(200)
      ).body as FeeStudentHit[];
      expect(byName.map((x) => x.id)).toContain(s.students[3]!.id);
      expect(byName.find((x) => x.id === s.students[3]!.id)?.enrolment?.roll).toBe(4);

      await api(s.tokens.teacher).get('/fees/students?q=ছাত্র').expect(403);
      const elsewhere = (await api(other.tokens.admin).get(`/fees/students?q=${local}`).expect(200))
        .body as FeeStudentHit[];
      expect(elsewhere).toEqual([]);
    });
  });
});
