import { withTenant } from '@jantrik/db';
import type {
  AdmissionApplicationDetail,
  AdmissionBulkApproveStatus,
  AdmissionCycleView,
  StudentProfile,
} from '@jantrik/shared';
import sharp from 'sharp';
import {
  admissionCycle,
  admissionSchool,
  api,
  staffApplication,
  type AdmissionSchool,
} from './support/admission.js';
import { AdmissionApplicationsService } from '../src/admission/applications.service.js';
import { AdmissionApprovalService } from '../src/admission/approval.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { platform, platformAdminCookie } from './support/platform.js';

interface ApproveBody {
  studentId: string;
  studentCode: string;
  photo: 'MOVED' | 'NONE' | 'STORAGE_FULL';
  application: AdmissionApplicationDetail;
}

/** Sprint 1 P3a: approval into a student with admit(), one at a time and in bulk (review focus 5). */
describe('admission (staff): approval', () => {
  let h: Harness;
  let s: AdmissionSchool;
  let cycle: AdmissionCycleView;
  let class6: string;

  const approve = (id: string, body: object = {}, token = s.tokens.admin) =>
    api(h, token).post(`/admission/applications/${id}/approve`, body);
  const student = async (id: string, token = s.tokens.admin) =>
    (await api(h, token).get(`/students/${id}`).expect(200)).body as StudentProfile;
  const studentsNamed = (nameEn: string) =>
    withTenant(h.prisma, s.tenantId, (tx) => tx.student.count({ where: { nameEn } }));
  const bulkDone = async (cycleClassId: string) =>
    vi.waitFor(
      async () => {
        const st = (
          await api(h, s.tokens.admin)
            .get(`/admission/cycle-classes/${cycleClassId}/bulk-approve`)
            .expect(200)
        ).body as AdmissionBulkApproveStatus;
        if (st.running) throw new Error('still running');
        return st;
      },
      { timeout: 60_000, interval: 250 },
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await admissionSchool(h);
    cycle = await admissionCycle(h, s);
    class6 = cycle.classes.find((c) => c.classLevel.id === s.class6)!.id;
  });

  afterAll(() => h.close());

  it('an application becomes a student of the cycle’s year, with its guardian (a login), roll and photo', async () => {
    const a = await staffApplication(h, s, class6, {
      nameEn: 'Approve One',
      religion: 'ISLAM',
      fatherNameBn: 'করিম',
      guardianOccupation: 'কৃষক',
    });
    const png = await sharp({
      create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    await http(h)
      .put(`/admission/applications/${a.id}/photo`)
      .set(bearer(s.tokens.admin))
      .attach('file', png, 'p.png')
      .expect(200);
    const res = await approve(a.id, { sectionId: s.sectionA, roll: '৪১', studentCode: 'ADM-001' });
    expect(res.status).toBe(200);
    const body = res.body as ApproveBody;
    expect(body).toMatchObject({ studentCode: 'ADM-001', photo: 'MOVED' });
    expect(body.application).toMatchObject({
      status: 'ADMITTED',
      approvable: false,
      student: { id: body.studentId, studentCode: 'ADM-001' },
      hasPhoto: false,
    });
    const p = await student(body.studentId);
    expect(p).toMatchObject({
      nameEn: 'Approve One',
      religion: 'ISLAM',
      fatherNameBn: 'করিম',
      dateOfBirth: '2019-05-01',
      birthRegistrationNo: a.birthRegistrationNo,
    });
    const enrolment = p.enrolments.find((e) => e.academicYear.id === s.nextYearId)!;
    expect(enrolment).toMatchObject({ roll: 41, section: { id: s.sectionA } });
    expect(p.guardians[0]).toMatchObject({ phone: a.phone, relation: 'FATHER', isPrimary: true });
    const guardian = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.guardian.findFirstOrThrow({
        where: { phone: a.phone },
        select: { userId: true, occupation: true },
      }),
    );
    expect(guardian.userId).not.toBeNull();
    expect(guardian.occupation).toBe('কৃষক');
    const membership = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.membership.findFirst({ where: { userId: guardian.userId!, role: 'GUARDIAN' } }),
    );
    expect(membership).not.toBeNull();
    // The photo moved: the student has it, the application's copy is gone.
    await api(h, s.tokens.admin).get(`/students/${body.studentId}/photo`).expect(200);
    await api(h, s.tokens.admin).get(`/admission/applications/${a.id}/photo`).expect(404);
    // Approving again, or editing, is refused.
    expect((await approve(a.id)).body.code).toBe('ALREADY_ADMITTED');
    expect(
      (await api(h, s.tokens.admin).patch(`/admission/applications/${a.id}`, { nameEn: 'x' })).body
        .code,
    ).toBe('APPLICATION_ADMITTED');
  });

  it('a phone the institute knows needs a choice: 409 and nothing written; then linked to the chosen guardian', async () => {
    const first = await staffApplication(h, s, class6, { nameEn: 'Sibling One' });
    const firstBody = (await approve(first.id).expect(200)).body as ApproveBody;
    const second = await staffApplication(h, s, class6, {
      nameEn: 'Sibling Two',
      nameBn: 'ভাই দুই',
      phone: first.phone,
    });
    const refused = await approve(second.id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GUARDIAN_CHOICE_REQUIRED');
    expect(await studentsNamed('Sibling Two')).toBe(0);
    const guardianId = (await student(firstBody.studentId)).guardians[0]!.guardianId;
    const ok = (await approve(second.id, { guardianId }).expect(200)).body as ApproveBody;
    expect((await student(ok.studentId)).guardians[0]!.guardianId).toBe(guardianId);
  });

  it('two approvals at once make one student; the other gets 409', async () => {
    const a = await staffApplication(h, s, class6, { nameEn: 'Race Twice' });
    const [r1, r2] = await Promise.all([approve(a.id), approve(a.id)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await studentsNamed('Race Twice')).toBe(1);
  });

  it('waitlisted, rejected or withdrawn applications cannot be approved; a teacher cannot approve', async () => {
    const a = await staffApplication(h, s, class6);
    await api(h, s.tokens.admin)
      .post(`/admission/applications/${a.id}/status`, { status: 'REJECTED', reason: 'Too young' })
      .expect(200);
    const res = await approve(a.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPLICATION_NOT_APPROVABLE');
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.admissionApplication.update({ where: { id: a.id }, data: { status: 'WAITLISTED' } }),
    );
    expect((await approve(a.id)).body.code).toBe('APPLICATION_NOT_APPROVABLE');
    const b = await staffApplication(h, s, class6);
    await approve(b.id, {}, s.tokens.teacher).expect(403);
  });

  it('with an admission test, only SELECTED applications may be approved (P3-H)', async () => {
    const tested = await admissionCycle(h, s, { requiresTest: true });
    const a = await staffApplication(h, s, tested.classes[0]!.id);
    expect((await approve(a.id)).body.code).toBe('APPLICATION_NOT_APPROVABLE');
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.admissionApplication.update({ where: { id: a.id }, data: { status: 'SELECTED' } }),
    );
    await approve(a.id).expect(200);
  });

  it("the wrong year's section is refused by admit() (nothing written)", async () => {
    const a = await staffApplication(h, s, class6, { nameEn: 'Wrong Section' });
    const res = await approve(a.id, { sectionId: s.section2026 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SECTION_MISMATCH');
    expect(await studentsNamed('Wrong Section')).toBe(0);
  });

  it('when storage is full the student is made without the photo; it stays on the application (P3-V)', async () => {
    const a = await staffApplication(h, s, class6, { nameEn: 'Storage Full' });
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await http(h)
      .put(`/admission/applications/${a.id}/photo`)
      .set(bearer(s.tokens.admin))
      .attach('file', png, 'p.png')
      .expect(200);
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.storedFileUsage.upsert({
        where: { tenantId: s.tenantId },
        create: { tenantId: s.tenantId, bytesUsed: 10n * 1024n * 1024n * 1024n },
        update: { bytesUsed: { increment: 10n * 1024n * 1024n * 1024n } },
      });
    });
    const body = (await approve(a.id).expect(200)).body as ApproveBody;
    expect(body.photo).toBe('STORAGE_FULL');
    expect(body.application.hasPhoto).toBe(true);
    expect((await student(body.studentId)).nameEn).toBe('Storage Full');
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.storedFileUsage.update({
        where: { tenantId: s.tenantId },
        data: { bytesUsed: { decrement: 10n * 1024n * 1024n * 1024n } },
      }),
    );
  });

  describe('bulk approval (a job acting as the admin, P3-T)', () => {
    /** An application staff marked SELECTED (bulk approves only those, review S2). */
    const selected = async (t: AdmissionSchool, cycleClassId: string, over: object) => {
      const a = await staffApplication(h, t, cycleClassId, over as Record<string, unknown>);
      await api(h, t.tokens.admin)
        .post(`/admission/applications/${a.id}/status`, { status: 'SELECTED' })
        .expect(200);
      return a;
    };

    it('approves only SELECTED applications: submitted and shortlisted ones stay (review S2)', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      const chosen = await selected(t, cc, { nameEn: 'Chosen One', nameBn: 'বাছাই এক' });
      const waiting = await staffApplication(h, t, cc, {
        nameEn: 'Not Chosen',
        nameBn: 'বাছাই নয়',
      });
      await api(h, t.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionB })
        .expect(202);
      await vi.waitFor(
        async () => {
          const r = (
            await api(h, t.tokens.admin)
              .get(`/admission/cycle-classes/${cc}/bulk-approve`)
              .expect(200)
          ).body as AdmissionBulkApproveStatus;
          if (r.running) throw new Error('running');
          expect(r.admitted).toBe(1);
        },
        { timeout: 60_000, interval: 250 },
      );
      const statuses = await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.admissionApplication.findMany({
          where: { id: { in: [chosen.id, waiting.id] } },
          select: { id: true, status: true },
        }),
      );
      expect(statuses.find((x) => x.id === chosen.id)!.status).toBe('ADMITTED');
      expect(statuses.find((x) => x.id === waiting.id)!.status).toBe('SUBMITTED');
    });

    it('30 applications, 2 of them on phones the institute knows: 28 students, 2 problems; a re-run picks up the rest', async () => {
      const bulk = await admissionCycle(h, s);
      const cc = bulk.classes.find((c) => c.classLevel.id === s.class6)!.id;
      const known = await staffApplication(h, s, class6, { nameEn: 'Known Phone' });
      await approve(known.id).expect(200);
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const phone = i < 2 ? known.phone : randomPhone();
        const a = await selected(s, cc, {
          nameEn: `Bulk ${i}`,
          nameBn: `বাল্ক ${i}`,
          phone,
        });
        ids.push(a.id);
      }
      await api(h, s.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: s.sectionB })
        .expect(202);
      const st = await bulkDone(cc);
      expect(st.admitted).toBe(28);
      expect(st.problems.map((p) => p.code)).toEqual([
        'GUARDIAN_CHOICE_REQUIRED',
        'GUARDIAN_CHOICE_REQUIRED',
      ]);
      expect(st.problems.map((p) => p.applicationId).sort()).toEqual(ids.slice(0, 2).sort());
      // A re-run picks up only what is left: the two still need a choice, nothing is made twice.
      await api(h, s.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: s.sectionB })
        .expect(202);
      const again = await bulkDone(cc);
      expect(again.admitted).toBe(28);
      expect(again.problems).toHaveLength(2);
    });

    it('the student limit stops a run and marks the rest', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      for (let i = 0; i < 4; i++) {
        await selected(t, cc, { nameEn: `Limit ${i}`, nameBn: `সীমা ${i}` });
      }
      await platform(h, await platformAdminCookie(h))
        .put(`/platform/institutes/${t.tenantId}/limits`)
        .send({ studentLimit: 2, smsDailyCap: null })
        .expect(200);
      await api(h, t.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionB })
        .expect(202);
      const st = await vi.waitFor(
        async () => {
          const r = (
            await api(h, t.tokens.admin)
              .get(`/admission/cycle-classes/${cc}/bulk-approve`)
              .expect(200)
          ).body as AdmissionBulkApproveStatus;
          if (r.running) throw new Error('running');
          return r;
        },
        { timeout: 60_000, interval: 250 },
      );
      expect(st.admitted).toBe(2);
      expect(st.problems.map((p) => p.code)).toEqual(['STUDENT_LIMIT', 'STUDENT_LIMIT']);
    });

    it('a full section stops a run; a section of another class or year is refused up front', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.section.update({ where: { id: t.sectionA }, data: { capacity: 1 } }),
      );
      for (let i = 0; i < 3; i++) {
        await selected(t, cc, { nameEn: `Full ${i}`, nameBn: `পূর্ণ ${i}` });
      }
      const wrong = await api(h, t.tokens.admin).post(
        `/admission/cycle-classes/${cc}/bulk-approve`,
        {
          sectionId: t.section2026,
        },
      );
      expect(wrong.status).toBe(422);
      expect(wrong.body.code).toBe('SECTION_MISMATCH');
      await api(h, t.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionA })
        .expect(202);
      const st = await vi.waitFor(
        async () => {
          const r = (
            await api(h, t.tokens.admin)
              .get(`/admission/cycle-classes/${cc}/bulk-approve`)
              .expect(200)
          ).body as AdmissionBulkApproveStatus;
          if (r.running) throw new Error('running');
          return r;
        },
        { timeout: 60_000, interval: 250 },
      );
      expect(st.admitted).toBe(1);
      expect(st.problems.map((p) => p.code)).toEqual(['SECTION_FULL', 'SECTION_FULL']);
    });

    it('an approval during a bulk run on the same application makes one student', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      const apps = [];
      for (let i = 0; i < 8; i++) {
        apps.push(await selected(t, cc, { nameEn: `Both ${i}`, nameBn: `দুটি ${i}` }));
      }
      const [, ...singles] = await Promise.all([
        api(h, t.tokens.admin)
          .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionB })
          .expect(202),
        ...apps.map((a) =>
          api(h, t.tokens.admin).post(`/admission/applications/${a.id}/approve`, {
            sectionId: t.sectionB,
          }),
        ),
      ]);
      expect(singles.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      await vi.waitFor(
        async () => {
          const r = (
            await api(h, t.tokens.admin)
              .get(`/admission/cycle-classes/${cc}/bulk-approve`)
              .expect(200)
          ).body as AdmissionBulkApproveStatus;
          if (r.running) throw new Error('running');
        },
        { timeout: 60_000, interval: 250 },
      );
      for (let i = 0; i < 8; i++) {
        const n = await withTenant(h.prisma, t.tenantId, (tx) =>
          tx.student.count({ where: { nameEn: `Both ${i}` } }),
        );
        expect(n).toBe(1);
      }
    });

    it('an application moved off SELECTED between the run reading it and locking it is not approved (review round 2, NIT 7)', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      const a = await selected(t, cc, { nameEn: 'Moved Off', nameBn: 'সরানো' });
      // The run has read SELECTED (no lock); before it locks the row, staff shortlist it again.
      const applications = h.app.get(AdmissionApplicationsService);
      const real = applications.lockRow.bind(applications);
      let moved = false;
      vi.spyOn(applications, 'lockRow').mockImplementation(async (id: string) => {
        if (id === a.id && !moved) {
          moved = true;
          await api(h, t.tokens.admin)
            .post(`/admission/applications/${a.id}/status`, { status: 'SHORTLISTED' })
            .expect(200);
        }
        return real(id);
      });
      try {
        const go = await h.app
          .get(TenantJobRunner)
          .run(
            t.tenantId,
            () =>
              h.app.get(AdmissionApprovalService).approveInBulk(a.id, t.sectionB, t.userIds.admin),
            { actorUserId: t.userIds.admin },
          );
        expect(go).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
      expect(moved).toBe(true);
      expect(await studentsNamed('Moved Off')).toBe(0);
      const after = await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.admissionApplication.findUniqueOrThrow({
          where: { id: a.id },
          select: { status: true, studentId: true },
        }),
      );
      expect(after).toEqual({ status: 'SHORTLISTED', studentId: null });
    });

    it('a second start while one runs is refused; other institutes and teachers cannot start one', async () => {
      const t = await admissionSchool(h);
      const c = await admissionCycle(h, t);
      const cc = c.classes.find((x) => x.classLevel.id === t.class6)!.id;
      await api(h, s.tokens.admin)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionB })
        .expect(404);
      await api(h, t.tokens.teacher)
        .post(`/admission/cycle-classes/${cc}/bulk-approve`, { sectionId: t.sectionB })
        .expect(403);
    });
  });
});
