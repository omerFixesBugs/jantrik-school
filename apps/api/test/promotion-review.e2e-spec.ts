import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  addDays,
  todayIn,
  type AttendanceSheet,
  type PromotionApplyCheck,
  type PromotionRunDetail,
  type RollsPreview,
  type StudentProfile,
  type SwitchCheck,
} from '@jantrik/shared';
import { applyJobId, PromotionApplyService } from '../src/promotion/promotion-apply.service.js';
import { PromotionProcessor } from '../src/promotion/promotion.processor.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { promotionSchool, promotionsQueue, type PromotionSchool } from './support/promotion.js';
import { school } from './support/school.js';

/** The fixes after the review of PR #21 (P5a), each with the scenario that showed the problem. */
describe('promotion: review fixes', () => {
  let h: Harness;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
    patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
    del: (path: string) => http(h).delete(path).set(bearer(token)),
  });
  const createRun = async (s: PromotionSchool, n: 6 | 7 | 10) =>
    (
      await api(s.tokens.admin)
        .post('/promotions', { fromYearId: s.y2026, toYearId: s.y2027, classLevelId: s.classes[n] })
        .expect(201)
    ).body as PromotionRunDetail;
  const run = async (s: PromotionSchool, id: string) =>
    (await api(s.tokens.admin).get(`/promotions/${id}`).expect(200)).body as PromotionRunDetail;
  const startApply = async (s: PromotionSchool, id: string, expectStatus = 200) => {
    const { version } = (await api(s.tokens.admin).get(`/promotions/${id}/apply-check`))
      .body as PromotionApplyCheck;
    return api(s.tokens.admin).post(`/promotions/${id}/apply`, { version }).expect(expectStatus);
  };
  const processRun = (s: PromotionSchool, id: string) =>
    h.app
      .get(PromotionProcessor)
      .run({ tenantId: s.tenantId, runId: id, actorUserId: s.userIds.admin });
  const removeJob = async (id: string) =>
    (await promotionsQueue(h).getJob(applyJobId(id)))?.remove();

  beforeAll(async () => {
    h = await createHarness();
    await promotionsQueue(h).pause();
  });

  afterAll(async () => {
    await promotionsQueue(h).resume();
    await h.close();
  });

  it('round 2 SF-A: after a placement correction, the roll group follows the class the student is in now', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    const seven = await createRun(s, 7);
    await api(s.tokens.admin)
      .put(`/promotions/${seven.id}/rows`, {
        rows: seven.rows.map((r) => ({
          id: r.id,
          decision: 'REPEAT',
          targetClassLevelId: s.classes[7],
          targetSectionId: s.sections[2027][7].ka,
        })),
      })
      .expect(200);
    for (const id of [six.id, seven.id]) {
      await startApply(s, id);
      await processRun(s, id);
      await removeJob(id);
    }
    const enrolmentOf = async (studentId: string) =>
      (
        (await api(s.tokens.admin).get(`/students/${studentId}`).expect(200)).body as StudentProfile
      ).enrolments.find((e) => e.academicYear.id === s.y2027)!;
    const [passed, failed] = s.students.six;
    // The failed one was kept back by mistake: moved up to 7 ক. The passed one goes back to 6 ক.
    await api(s.tokens.admin)
      .patch(`/students/${failed!.id}/enrolments/${(await enrolmentOf(failed!.id)).id}`, {
        classLevelId: s.classes[7],
        sectionId: s.sections[2027][7].ka,
      })
      .expect(200);
    await api(s.tokens.admin)
      .patch(`/students/${passed!.id}/enrolments/${(await enrolmentOf(passed!.id)).id}`, {
        classLevelId: s.classes[6],
        sectionId: s.sections[2027][6].ka,
      })
      .expect(200);
    const preview = async (n: 6 | 7) =>
      (
        await api(s.tokens.admin)
          .get(`/promotions/rolls?toYearId=${s.y2027}&classLevelId=${s.classes[n]}`)
          .expect(200)
      ).body as RollsPreview;
    const rowOf = (p: RollsPreview, id: string) =>
      p.sections.flatMap((x) => x.rows).find((r) => r.studentId === id)!;
    // Now in class 7, coming from class 6: promoted, not a class-7 repeater.
    expect(rowOf(await preview(7), failed!.id)).toMatchObject({ group: 'PROMOTED' });
    // Back in class 6, the run's own class: a repeater (class 6's own run, so its merit place stays).
    expect(rowOf(await preview(6), passed!.id)).toMatchObject({
      group: 'REPEATER',
      meritPosition: 2,
    });
  });

  it('round 2 SF-B: a student who left does not hold a seat', async () => {
    const s = await promotionSchool(h, { capacity: 2 });
    const admin = api(s.tokens.admin);
    const enrol = (studentId: string) =>
      admin.post(`/students/${studentId}/enrolments`, {
        academicYearId: s.y2027,
        classLevelId: s.classes[7],
        sectionId: s.sections[2027][7].ka,
        roll: null,
      });
    const [a, , c] = s.students.six;
    await enrol(a!.id).expect(201);
    await enrol(c!.id).expect(201);
    await admin
      .post(`/students/${a!.id}/leave`, { status: 'TRANSFERRED', leftOn: '2026-12-01' })
      .expect(200);
    // The seat a left is free again.
    await enrol(s.students.sixB[0]!.id).expect(201);
    // The apply-check counts only students still here.
    const run7 = await createRun(s, 7);
    const check = (await admin.get(`/promotions/${run7.id}/apply-check`).expect(200))
      .body as PromotionApplyCheck;
    expect(check.sections.find((x) => x.section.id === s.sections[2027][8].ka)).toMatchObject({
      enrolled: 0,
    });
    const six = await createRun(s, 6);
    const check6 = (await admin.get(`/promotions/${six.id}/apply-check`).expect(200))
      .body as PromotionApplyCheck;
    expect(check6.sections.find((x) => x.section.id === s.sections[2027][7].ka)).toMatchObject({
      enrolled: 2,
    });
  });

  it('SF2: a run comes only from the year just before the new one', async () => {
    const s = await promotionSchool(h);
    const y2025 = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: '2025',
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-12-31'),
        },
      }),
    );
    const res = await api(s.tokens.admin)
      .post('/promotions', { fromYearId: y2025.id, toYearId: s.y2027, classLevelId: s.classes[6] })
      .expect(422);
    expect(res.body).toMatchObject({ code: 'YEAR_ORDER', field: 'fromYearId' });
  });

  it('MUST-FIX 1: a placement applied by mistake is corrected in the new year; the current year is refused', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    const failed = s.students.six[1]!; // REPEAT by default (failed): say that was a mistake
    // Their 2026 choice is copied for a repeater.
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const subject = await tx.subject.findFirstOrThrow({
        where: { classLevelId: s.classes[6] },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.studentSubjectChoice.create({
        data: {
          tenantId: s.tenantId,
          academicYearId: s.y2026,
          studentId: failed.id,
          subjectId: subject.id,
          kind: 'COMPULSORY',
        },
      });
    });
    await startApply(s, six.id);
    await processRun(s, six.id);
    await removeJob(six.id);
    const profile = (await api(s.tokens.admin).get(`/students/${failed.id}`).expect(200))
      .body as StudentProfile;
    const e2027 = profile.enrolments.find((e) => e.academicYear.id === s.y2027)!;
    expect(e2027.classLevel.id).toBe(s.classes[6]);

    const fixed = (
      await api(s.tokens.admin)
        .patch(`/students/${failed.id}/enrolments/${e2027.id}`, {
          classLevelId: s.classes[7],
          sectionId: s.sections[2027][7].kha,
        })
        .expect(200)
    ).body as StudentProfile;
    expect(fixed.enrolments.find((e) => e.id === e2027.id)).toMatchObject({
      classLevel: { id: s.classes[7] },
      section: { id: s.sections[2027][7].kha },
      roll: null,
    });
    const after = await withTenant(h.prisma, s.tenantId, async (tx) => ({
      choices: await tx.studentSubjectChoice.count({
        where: { studentId: failed.id, academicYearId: s.y2027 },
      }),
      audit: await tx.auditLog.findFirst({
        where: { entity: 'enrolment', entityId: e2027.id },
        orderBy: { createdAt: 'desc' },
      }),
    }));
    expect(after.choices).toBe(0); // class 6's subjects no longer apply
    expect(after.audit).toMatchObject({
      oldValues: { classLevelId: s.classes[6] },
      newValues: { classLevelId: s.classes[7], reason: 'placement' },
    });
    // A section of the wrong class, and the current year's enrolment, are refused.
    await api(s.tokens.admin)
      .patch(`/students/${failed.id}/enrolments/${e2027.id}`, {
        classLevelId: s.classes[7],
        sectionId: s.sections[2027][8].ka,
      })
      .expect(422);
    const e2026 = profile.enrolments.find((e) => e.academicYear.id === s.y2026)!;
    const now = await api(s.tokens.admin)
      .patch(`/students/${failed.id}/enrolments/${e2026.id}`, { classLevelId: s.classes[7] })
      .expect(422);
    expect(now.body.code).toBe('NOT_A_NEW_YEAR');
    // Something of the new year already depends on it (an exam roster): refused.
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const exam = await tx.exam.create({
        data: {
          tenantId: s.tenantId,
          academicYearId: s.y2027,
          kind: 'HALF_YEARLY',
          nameBn: 'অর্ধবার্ষিক',
          nameEn: 'Half-yearly',
          startsOn: new Date('2027-06-01'),
          endsOn: new Date('2027-06-10'),
          resultMode: 'GPA',
          meritOrder: ['GPA', 'ROLL'],
          failedRanking: 'AFTER_PASSED',
        },
      });
      await tx.examClass.create({
        data: { tenantId: s.tenantId, examId: exam.id, classLevelId: s.classes[7] },
      });
      await tx.examCandidate.create({
        data: {
          tenantId: s.tenantId,
          examId: exam.id,
          studentId: failed.id,
          classLevelId: s.classes[7],
          sectionId: s.sections[2027][7].kha,
        },
      });
    });
    const used = await api(s.tokens.admin)
      .patch(`/students/${failed.id}/enrolments/${e2027.id}`, {
        classLevelId: s.classes[7],
        sectionId: s.sections[2027][7].ka,
      })
      .expect(409);
    expect(used.body).toMatchObject({ code: 'ENROLMENT_IN_USE', exams: 1 });
    await api(s.tokens.teacher)
      .patch(`/students/${failed.id}/enrolments/${e2027.id}`, { classLevelId: s.classes[7] })
      .expect(403);
  });

  it('SF3: rolls are not numbered before the runs into the class are applied, unless forced', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    const seven = await createRun(s, 7);
    // Class 7's two students repeat into 7 ক; only class 7's run is applied.
    await api(s.tokens.admin)
      .put(`/promotions/${seven.id}/rows`, {
        rows: seven.rows.map((r) => ({
          id: r.id,
          decision: 'REPEAT',
          targetClassLevelId: s.classes[7],
          targetSectionId: s.sections[2027][7].ka,
        })),
      })
      .expect(200);
    await startApply(s, seven.id);
    await processRun(s, seven.id);
    await removeJob(seven.id);
    const p = (
      await api(s.tokens.admin)
        .get(`/promotions/rolls?toYearId=${s.y2027}&classLevelId=${s.classes[7]}`)
        .expect(200)
    ).body as RollsPreview;
    expect(p.pendingRuns).toEqual([
      expect.objectContaining({
        runId: six.id,
        pending: 3,
        classLevel: expect.objectContaining({ id: s.classes[6] }),
      }),
    ]);
    const body = {
      toYearId: s.y2027,
      classLevelId: s.classes[7],
      version: p.version,
      sections: p.sections.map((x) => ({
        sectionId: x.section.id,
        rolls: x.rows.map((r) => ({ enrolmentId: r.enrolmentId, roll: r.proposed! })),
      })),
    };
    const refused = await api(s.tokens.admin).put('/promotions/rolls', body).expect(409);
    expect(refused.body.code).toBe('RUNS_PENDING');
    await api(s.tokens.admin)
      .put('/promotions/rolls', { ...body, force: true })
      .expect(200);
  });

  it('NIT 8 and SF7: no roll proposed for a leaver; the switch check counts enrolments without a section', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    // The absent student gets no section in 2027.
    const absent = six.rows.find((r) => r.student.id === s.students.six[2]!.id)!;
    await api(s.tokens.admin)
      .put(`/promotions/${six.id}/rows`, {
        rows: [{ id: absent.id, decision: 'PROMOTE', targetClassLevelId: s.classes[7] }],
      })
      .expect(200);
    await startApply(s, six.id);
    await processRun(s, six.id);
    await removeJob(six.id);
    const passed = s.students.six[0]!;
    await api(s.tokens.admin)
      .post(`/students/${passed.id}/leave`, { status: 'TRANSFERRED', leftOn: '2026-12-20' })
      .expect(200);
    const p = (
      await api(s.tokens.admin)
        .get(`/promotions/rolls?toYearId=${s.y2027}&classLevelId=${s.classes[7]}`)
        .expect(200)
    ).body as RollsPreview;
    expect(p.sections.flatMap((x) => x.rows).map((r) => r.studentId)).not.toContain(passed.id);
    expect(p.withoutSection).toBe(1);
    const check = (
      await api(s.tokens.admin).get(`/promotions/switch-check?toYearId=${s.y2027}`).expect(200)
    ).body as SwitchCheck;
    expect(check).toMatchObject({ withoutSection: 1, clean: false });
  });

  it('SF5: a run stopped by a full section can be fixed by moving rows, then resumed', async () => {
    const s = await promotionSchool(h, { capacity: 2 });
    const six = await createRun(s, 6);
    await startApply(s, six.id);
    // An admission fills 7 ক before the job runs.
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: {
          tenantId: s.tenantId,
          studentCode: `F-${randomUUID().slice(0, 8)}`,
          nameBn: 'পূর্ণ',
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: st.id,
          academicYearId: s.y2027,
          classLevelId: s.classes[7],
          sectionId: s.sections[2027][7].ka,
        },
      });
    });
    // While the job is still in the queue, edits wait.
    const row = (await run(s, six.id)).rows.find((r) => r.student.id === s.students.six[2]!.id)!;
    const move = {
      rows: [
        {
          id: row.id,
          decision: 'PROMOTE',
          targetClassLevelId: s.classes[7],
          targetSectionId: s.sections[2027][7].kha,
        },
      ],
    };
    expect(
      (await api(s.tokens.admin).put(`/promotions/${six.id}/rows`, move).expect(409)).body.code,
    ).toBe('RUN_APPLYING');
    await expect(processRun(s, six.id)).rejects.toThrow('SECTION_FULL');
    await removeJob(six.id);
    expect(await run(s, six.id)).toMatchObject({ status: 'APPLYING', lastError: 'SECTION_FULL' });
    // Stopped: the row moves to 7 খ, then resume.
    await api(s.tokens.admin).put(`/promotions/${six.id}/rows`, move).expect(200);
    await api(s.tokens.admin).post(`/promotions/${six.id}/resume`).expect(200);
    await processRun(s, six.id);
    await removeJob(six.id);
    expect(await run(s, six.id)).toMatchObject({ status: 'APPLIED', lastError: null });
    const stopped = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.count({
        where: {
          entity: 'promotion_run',
          entityId: six.id,
          newValues: { path: ['step'], equals: 'stopped' },
        },
      }),
    );
    expect(stopped).toBe(1);
  });

  it('SF6: a run with no applied row is deleted (and its year can go); an applied one stays', async () => {
    const s = await promotionSchool(h);
    const y2028 = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: '2028',
          startDate: new Date('2028-01-01'),
          endDate: new Date('2028-12-31'),
        },
      }),
    );
    const empty = (
      await api(s.tokens.admin)
        .post('/promotions', {
          fromYearId: s.y2027,
          toYearId: y2028.id,
          classLevelId: s.classes[6],
        })
        .expect(201)
    ).body as PromotionRunDetail;
    await api(s.tokens.admin).del(`/promotions/${empty.id}`).expect(204);
    await api(s.tokens.admin).get(`/promotions/${empty.id}`).expect(404);
    await api(s.tokens.admin).del(`/setup/academic-years/${y2028.id}`).expect(204);

    const seven = await createRun(s, 7);
    await startApply(s, seven.id);
    await processRun(s, seven.id);
    await removeJob(seven.id);
    const kept = await api(s.tokens.admin).del(`/promotions/${seven.id}`).expect(409);
    expect(kept.body.code).toBe('RUN_HAS_APPLIED');
    await api(s.tokens.teacher).del(`/promotions/${seven.id}`).expect(403);
  });

  it('NIT 11: a job that dies among the leavers resumes and marks each leaver once', async () => {
    const s = await promotionSchool(h);
    const ten = await createRun(s, 10);
    await startApply(s, ten.id);
    const apply = h.app.get(PromotionApplyService);
    const original = apply.applyLeavers.bind(apply);
    let calls = 0;
    const spy = vi.spyOn(apply, 'applyLeavers').mockImplementation(async (id, limit) => {
      calls++;
      // The first chunk handles one leaver, then the worker dies.
      if (calls === 1) return original(id, 1);
      if (calls === 2) throw new Error('worker died');
      return original(id, limit);
    });
    try {
      await expect(processRun(s, ten.id)).rejects.toThrow('worker died');
      const halfway = await run(s, ten.id);
      expect(halfway.rows.filter((r) => r.appliedAt).length).toBe(1);
      await removeJob(ten.id);
      await api(s.tokens.admin).post(`/promotions/${ten.id}/resume`).expect(200);
      await processRun(s, ten.id);
    } finally {
      spy.mockRestore();
    }
    await removeJob(ten.id);
    expect((await run(s, ten.id)).status).toBe('APPLIED');
    const audits = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'student', entityId: { in: s.students.ten.map((t) => t.id) } },
        select: { entityId: true },
      }),
    );
    expect(audits.map((a) => a.entityId).sort()).toEqual(s.students.ten.map((t) => t.id).sort());
  });

  it('NIT 11: a section waits for the run’s apply lock held elsewhere', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    await startApply(s, six.id);
    const apply = h.app.get(PromotionApplyService);
    const jobs = h.app.get(TenantJobRunner);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Another transaction holds the run's advisory lock.
    const holder = withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('promotion:' || ${six.id}, 0))`;
      locked();
      await held;
    });
    await isLocked;
    let finished = false;
    const section = jobs
      .run(s.tenantId, () => apply.applySection(six.id, s.sections[2027][7].ka), {
        actorUserId: s.userIds.admin,
      })
      .then((r) => {
        finished = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(finished).toBe(false); // waiting for the lock
    release();
    await holder;
    expect((await section).enrolled).toBe(2);
    await removeJob(six.id);
  });

  it('SF4: a leaver is on registers before the day they left, not from it', async () => {
    const t = await school(h);
    const today = todayIn('Asia/Dhaka');
    const yesterday = addDays(today, -1);
    const leaver = t.a[0]!;
    await api(t.admin)
      .post(`/students/${leaver.id}/leave`, { status: 'TRANSFERRED', leftOn: today })
      .expect(200);
    const sheet = async (date: string) =>
      (
        await api(t.admin)
          .get(`/attendance/sessions?sectionId=${t.sectionA}&date=${date}`)
          .expect(200)
      ).body as AttendanceSheet;
    expect((await sheet(today)).students.map((x) => x.id)).not.toContain(leaver.id);
    expect((await sheet(yesterday)).students.map((x) => x.id)).toContain(leaver.id);
    // Today's register is saved without them; a record for them is refused.
    const others = t.a.slice(1).map((x) => ({ studentId: x.id, status: 'PRESENT' }));
    await api(t.admin)
      .put('/attendance/sessions', {
        sectionId: t.sectionA,
        date: today,
        baseVersion: 0,
        submissionId: randomUUID(),
        records: [...others, { studentId: leaver.id, status: 'PRESENT' }],
      })
      .expect(422);
    await api(t.admin)
      .put('/attendance/sessions', {
        sectionId: t.sectionA,
        date: today,
        baseVersion: 0,
        submissionId: randomUUID(),
        records: others,
      })
      .expect(200);
  });
});
