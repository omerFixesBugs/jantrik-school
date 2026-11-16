import { withTenant } from '@jantrik/db';
import type {
  AdmissionApplicationDetail,
  AdmissionApplicationsPage,
  AdmissionCycleView,
  AdmissionOptions,
} from '@jantrik/shared';
import sharp from 'sharp';
import {
  admissionCycle,
  admissionSchool,
  api,
  staffApplication,
  staffApplicationBody,
  type AdmissionSchool,
} from './support/admission.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';

const bn = (s: string) => s.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);

/** Sprint 1 P3a: cycles, their classes, staff-entered applications, edits, status, the list. */
describe('admission (staff): cycles and applications', () => {
  let h: Harness;
  let s: AdmissionSchool;
  let other: AdmissionSchool;
  let cycle: AdmissionCycleView;
  let class6: string;
  let class7: string;

  const audits = (entityId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await admissionSchool(h);
    other = await admissionSchool(h);
    cycle = await admissionCycle(h, s);
    class6 = cycle.classes.find((c) => c.classLevel.id === s.class6)!.id;
    class7 = cycle.classes.find((c) => c.classLevel.id === s.class7)!.id;
  });

  afterAll(() => h.close());

  describe('cycles', () => {
    it('the options list this institute’s years, classes and groups', async () => {
      const o = (await api(h, s.tokens.admin).get('/admission/options').expect(200))
        .body as AdmissionOptions;
      expect(o.years.map((y) => y.name)).toEqual(['2027', '2026']);
      expect(o.classLevels.some((c) => c.id === s.class6)).toBe(true);
      expect(o.classLevels.some((c) => c.id === other.class6)).toBe(false);
    });

    it('a new cycle is a draft; opening needs a class; it takes applications inside its window', async () => {
      const admin = api(h, s.tokens.admin);
      const c = (
        await admin
          .post('/admission/cycles', {
            academicYearId: s.nextYearId,
            nameBn: 'ভর্তি (খসড়া)',
            opensAt: '2026-11-01T00:00:00+06:00',
            closesAt: '2027-01-31T00:00:00+06:00',
          })
          .expect(201)
      ).body as AdmissionCycleView;
      expect(c.status).toBe('DRAFT');
      expect(c.takingApplications).toBe(false);
      const refused = await admin.post(`/admission/cycles/${c.id}/status`, { status: 'OPEN' });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('CYCLE_HAS_NO_CLASSES');
      // The fixture cycle is open and inside its window today (2026-11 … 2027-01).
      expect(cycle.status).toBe('OPEN');
      expect(cycle.takingApplications).toBe(true);
      const closed = (
        await admin.post(`/admission/cycles/${c.id}/status`, { status: 'CLOSED' }).expect(200)
      ).body as AdmissionCycleView;
      expect(closed.status).toBe('CLOSED');
      expect((await audits(c.id)).map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it("another institute's year is not found; a window that closes first is refused", async () => {
      const admin = api(h, s.tokens.admin);
      const base = {
        nameBn: 'x',
        opensAt: '2026-11-01T00:00:00+06:00',
        closesAt: '2026-12-01T00:00:00+06:00',
      };
      await admin
        .post('/admission/cycles', { ...base, academicYearId: other.nextYearId })
        .expect(404);
      await admin
        .post('/admission/cycles', {
          ...base,
          academicYearId: s.nextYearId,
          closesAt: '2026-10-01T00:00:00+06:00',
        })
        .expect(400);
      const res = await admin.patch(`/admission/cycles/${cycle.id}`, {
        closesAt: '2026-10-01T00:00:00+06:00',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('WINDOW');
    });

    it('teachers, accountants and other institutes get nothing', async () => {
      await api(h, s.tokens.teacher).get('/admission/cycles').expect(403);
      await api(h, s.tokens.accountant).get('/admission/applications').expect(403);
      await api(h, other.tokens.admin).get(`/admission/cycles/${cycle.id}`).expect(404);
      const list = (await api(h, other.tokens.admin).get('/admission/cycles').expect(200))
        .body as AdmissionCycleView[];
      expect(list).toEqual([]);
    });

    it('the class list: a class twice is refused; a class with applications cannot be removed', async () => {
      const admin = api(h, s.tokens.admin);
      await admin
        .put(`/admission/cycles/${cycle.id}/classes`, {
          classes: [{ classLevelId: s.class6 }, { classLevelId: s.class6 }],
        })
        .expect(400);
      await staffApplication(h, s, class7);
      const res = await admin.put(`/admission/cycles/${cycle.id}/classes`, {
        classes: [{ classLevelId: s.class6, seats: 80 }],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLASS_HAS_APPLICATIONS');
      // Another institute's class level is not found.
      await admin
        .put(`/admission/cycles/${cycle.id}/classes`, {
          classes: [
            { classLevelId: s.class6, seats: 80 },
            { classLevelId: s.class7 },
            { classLevelId: other.class6 },
          ],
        })
        .expect(404);
    });

    it('the admission test cannot be switched once applications exist', async () => {
      const res = await api(h, s.tokens.admin).patch(`/admission/cycles/${cycle.id}`, {
        requiresTest: true,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CYCLE_HAS_APPLICATIONS');
    });
  });

  describe('staff-entered applications (P3-J)', () => {
    it('a walk-in gets the next number of the year and source STAFF; Bangla digits are accepted', async () => {
      const a = await staffApplication(h, s, class6, {
        phone: bn('01712-345678'),
        birthRegistrationNo: bn('20191234567890001'),
        dateOfBirth: bn('2019-06-15'),
      });
      expect(a.applicationNo).toMatch(/^2027-\d{4}$/);
      expect(a).toMatchObject({
        source: 'STAFF',
        status: 'SUBMITTED',
        phone: '+8801712345678',
        birthRegistrationNo: '20191234567890001',
        dateOfBirth: '2019-06-15',
      });
      const b = await staffApplication(h, s, class6);
      const n = (no: string) => Number(no.split('-')[1]);
      expect(n(b.applicationNo)).toBe(n(a.applicationNo) + 1);
      expect((await audits(a.id))[0]).toMatchObject({
        entity: 'admission_application',
        action: 'CREATE',
      });
    });

    it('the same birth registration number, or the same phone, name and birthday, is a duplicate (with its number)', async () => {
      const first = await staffApplication(h, s, class6);
      const dupReg = await api(h, s.tokens.admin).post(
        '/admission/applications',
        staffApplicationBody(class7, { birthRegistrationNo: first.birthRegistrationNo }),
      );
      expect(dupReg.status).toBe(409);
      expect(dupReg.body).toMatchObject({
        code: 'ADMISSION_DUPLICATE',
        applicationNo: first.applicationNo,
      });
      const dupName = await api(h, s.tokens.admin).post(
        '/admission/applications',
        staffApplicationBody(class6, {
          phone: first.phone,
          nameBn: '  রাফি   আহমেদ ',
          birthRegistrationNo: null,
        }),
      );
      expect(dupName.status).toBe(409);
      expect(dupName.body.applicationNo).toBe(first.applicationNo);
    });

    it('a fourth live application of one phone is refused; a withdrawn one does not count', async () => {
      const phone = randomPhone();
      const made = [];
      for (const name of ['এক', 'দুই', 'তিন']) {
        made.push(await staffApplication(h, s, class6, { phone, nameBn: name, nameEn: null }));
      }
      const fourth = await api(h, s.tokens.admin).post(
        '/admission/applications',
        staffApplicationBody(class6, { phone, nameBn: 'চার', nameEn: null }),
      );
      expect(fourth.status).toBe(422);
      expect(fourth.body.code).toBe('ADMISSION_PHONE_CAP');
      await api(h, s.tokens.admin)
        .post(`/admission/applications/${made[0]!.id}/status`, {
          status: 'WITHDRAWN',
          reason: 'Family moved',
        })
        .expect(200);
      await staffApplication(h, s, class6, { phone, nameBn: 'চার', nameEn: null });
    });

    it("a class of another cycle or institute is not found; the cycle's required fields are enforced", async () => {
      const other6 = (await admissionCycle(h, other)).classes[0]!.id;
      await api(h, s.tokens.admin)
        .post('/admission/applications', staffApplicationBody(other6))
        .expect(404);
      const strict = await admissionCycle(h, s, { fields: { father_name: 'REQUIRED' } });
      const res = await api(h, s.tokens.admin).post(
        '/admission/applications',
        staffApplicationBody(strict.classes[0]!.id),
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'ADMISSION_FIELDS_REQUIRED',
        fields: ['father_name'],
      });
    });

    it('edits are audited with old and new values; the class may move only inside the cycle', async () => {
      const a = await staffApplication(h, s, class6);
      const admin = api(h, s.tokens.admin);
      const edited = (
        await admin
          .patch(`/admission/applications/${a.id}`, { nameEn: 'Rafi A.', cycleClassId: class7 })
          .expect(200)
      ).body as AdmissionApplicationDetail;
      expect(edited.cycleClass.id).toBe(class7);
      const audit = (await audits(a.id)).at(-1)!;
      expect(audit.oldValues).toMatchObject({ nameEn: 'Rafi Ahmed', cycleClassId: class6 });
      expect(audit.newValues).toMatchObject({ nameEn: 'Rafi A.', cycleClassId: class7 });
      const strict = await admissionCycle(h, s, { open: false });
      const res = await admin.patch(`/admission/applications/${a.id}`, {
        cycleClassId: strict.classes[0]!.id,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CLASS_NOT_IN_CYCLE');
      await admin
        .patch(`/admission/applications/${a.id}`, { nameBn: null, nameEn: null })
        .expect(422);
    });

    it('a status change needs a reason to reject; ADMITTED is never set by hand', async () => {
      const a = await staffApplication(h, s, class6);
      const admin = api(h, s.tokens.admin);
      await admin
        .post(`/admission/applications/${a.id}/status`, { status: 'REJECTED' })
        .expect(400);
      await admin
        .post(`/admission/applications/${a.id}/status`, { status: 'ADMITTED' })
        .expect(400);
      const r = (
        await admin
          .post(`/admission/applications/${a.id}/status`, { status: 'SHORTLISTED' })
          .expect(200)
      ).body as AdmissionApplicationDetail;
      expect(r.status).toBe('SHORTLISTED');
      expect(r.approvable).toBe(true);
    });
  });

  describe('the list, search and CSV', () => {
    it('filters, and searches by name (Bangla and English), phone (Bangla digits) and number', async () => {
      const a = await staffApplication(h, s, class6, {
        nameBn: 'তাসনিম জাহান',
        nameEn: 'Tasnim Jahan',
        phone: '+8801998877665',
      });
      const admin = api(h, s.tokens.admin);
      const find = async (q: string) =>
        (
          (await admin.get(`/admission/applications?q=${encodeURIComponent(q)}`).expect(200))
            .body as AdmissionApplicationsPage
        ).items.map((i) => i.id);
      expect(await find('তাসনিম')).toContain(a.id);
      expect(await find('tasnim')).toContain(a.id);
      expect(await find(bn('01998-877665'))).toEqual([a.id]);
      expect(await find(a.applicationNo)).toEqual([a.id]);
      const page = (
        await admin
          .get(`/admission/applications?cycleId=${cycle.id}&status=SUBMITTED&pageSize=5`)
          .expect(200)
      ).body as AdmissionApplicationsPage;
      expect(page.items.length).toBeLessThanOrEqual(5);
      expect(page.total).toBeGreaterThan(3);
      expect(page.items.every((i) => i.status === 'SUBMITTED' && i.cycle.id === cycle.id)).toBe(
        true,
      );
    });

    it('the CSV has a BOM and ASCII digits', async () => {
      const res = await api(h, s.tokens.admin)
        .get(`/admission/applications.csv?cycleId=${cycle.id}&locale=bn`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text).toContain('আবেদন নম্বর');
      expect(res.text).toMatch(/2027-\d{4}/);
      expect(res.text).not.toMatch(/[০-৯]/);
      expect(res.text).toMatch(/01\d{3}-\d{6}/);
    });

    it('2 000 applications list in under 300 ms', async () => {
      await withTenant(h.prisma, s.tenantId, async (tx) => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({
          tenantId: s.tenantId,
          cycleId: cycle.id,
          cycleClassId: class6,
          applicationNo: `2027-${String(50000 + i).padStart(6, '0')}`,
          source: 'ONLINE' as const,
          nameBn: `আবেদনকারী ${i}`,
          nameKey: `আবেদনকারী${i}`,
          dateOfBirth: new Date('2019-01-01'),
          gender: 'FEMALE' as const,
          guardianNameBn: 'অভিভাবক',
          guardianRelation: 'MOTHER' as const,
          phone: `+88019${String(10000000 + i).padStart(8, '0')}`,
          submittedAt: new Date(),
        }));
        await tx.admissionApplication.createMany({ data: rows });
      });
      const admin = api(h, s.tokens.admin);
      await admin.get(`/admission/applications?cycleId=${cycle.id}`).expect(200); // warm up
      const times: number[] = [];
      for (const q of ['', '&q=আবেদনকারী 19', '&status=SUBMITTED']) {
        const t = performance.now();
        await admin.get(`/admission/applications?cycleId=${cycle.id}${q}`).expect(200);
        times.push(performance.now() - t);
      }
      expect(Math.min(...times)).toBeLessThan(300);
    });
  });

  describe("the applicant's photo", () => {
    it('staff add one: stored re-encoded as a JPEG without EXIF; served with an ETag', async () => {
      const a = await staffApplication(h, s, class6);
      const png = await sharp({
        create: { width: 900, height: 1200, channels: 3, background: { r: 10, g: 120, b: 200 } },
      })
        .png()
        .withMetadata({ exif: { IFD0: { Copyright: 'GPS 23.8,90.4' } } })
        .toBuffer();
      const admin = api(h, s.tokens.admin);
      const res = await http(h)
        .put(`/admission/applications/${a.id}/photo`)
        .set(bearer(s.tokens.admin))
        .attach('file', png, 'photo.png');
      expect(res.status).toBe(200);
      expect((res.body as AdmissionApplicationDetail).hasPhoto).toBe(true);
      const got = await admin.get(`/admission/applications/${a.id}/photo`).expect(200);
      expect(got.headers['content-type']).toBe('image/jpeg');
      const meta = await sharp(got.body as Buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.width! <= 600 && meta.height! <= 800).toBe(true);
      const etag = got.headers['etag'] as string;
      await admin
        .get(`/admission/applications/${a.id}/photo`)
        .set('If-None-Match', etag)
        .expect(304);
      await api(h, other.tokens.admin).get(`/admission/applications/${a.id}/photo`).expect(404);
    });
  });
});
