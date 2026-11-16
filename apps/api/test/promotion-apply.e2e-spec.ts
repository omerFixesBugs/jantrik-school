import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type { PromotionApplyCheck, PromotionRunDetail } from '@jantrik/shared';
import { applyJobId, PromotionApplyService } from '../src/promotion/promotion-apply.service.js';
import { PromotionProcessor } from '../src/promotion/promotion.processor.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { promotionSchool, promotionsQueue, type PromotionSchool } from './support/promotion.js';

/** P5 Task 5 (review focus 1 and 2): applying a run, resuming it, never twice. */
describe('promotion apply', () => {
  let h: Harness;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
    patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
  });
  const createRun = async (s: PromotionSchool, n: 6 | 7 | 10) =>
    (
      await api(s.tokens.admin)
        .post('/promotions', { fromYearId: s.y2026, toYearId: s.y2027, classLevelId: s.classes[n] })
        .expect(201)
    ).body as PromotionRunDetail;
  const check = async (s: PromotionSchool, runId: string) =>
    (await api(s.tokens.admin).get(`/promotions/${runId}/apply-check`).expect(200))
      .body as PromotionApplyCheck;
  const run = async (s: PromotionSchool, runId: string, token = s.tokens.admin) =>
    (await api(token).get(`/promotions/${runId}`).expect(200)).body as PromotionRunDetail;
  const startApply = async (s: PromotionSchool, runId: string, expectStatus = 200) =>
    api(s.tokens.admin)
      .post(`/promotions/${runId}/apply`, { version: (await check(s, runId)).version })
      .expect(expectStatus);
  const enrolments2027 = (s: PromotionSchool) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.enrolment.findMany({
        where: { academicYearId: s.y2027 },
        select: { id: true, studentId: true, classLevelId: true, sectionId: true, roll: true },
      }),
    );
  const currentYear = (s: PromotionSchool) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.academicYear.findFirstOrThrow({ where: { isCurrent: true }, select: { id: true } }),
    );
  /** Runs the job's work here, as the worker would (the queue is paused in these tests). */
  const processRun = (s: PromotionSchool, runId: string, actorUserId = s.userIds.admin) =>
    h.app.get(PromotionProcessor).run({ tenantId: s.tenantId, runId, actorUserId });
  const removeJob = async (runId: string) =>
    (await promotionsQueue(h).getJob(applyJobId(runId)))?.remove();

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await promotionsQueue(h).resume();
    await h.close();
  });

  it('happy path (worker): one enrolment per promoted or repeating row, no roll, leavers graduated, the year unchanged', async () => {
    const s = await promotionSchool(h);
    const six = await createRun(s, 6);
    const ten = await createRun(s, 10);
    await startApply(s, six.id);
    await startApply(s, ten.id);
    await vi.waitFor(
      async () => {
        expect((await run(s, six.id)).status).toBe('APPLIED');
        expect((await run(s, ten.id)).status).toBe('APPLIED');
      },
      { timeout: 20_000, interval: 200 },
    );
    const enrolled = await enrolments2027(s);
    expect(enrolled).toHaveLength(4);
    expect(enrolled.every((e) => e.roll === null)).toBe(true);
    const of = (id: string) => enrolled.find((e) => e.studentId === id)!;
    const [passed, failed, absent] = s.students.six;
    expect(of(passed!.id)).toMatchObject({
      classLevelId: s.classes[7],
      sectionId: s.sections[2027][7].ka,
    });
    expect(of(failed!.id)).toMatchObject({
      classLevelId: s.classes[6],
      sectionId: s.sections[2027][6].ka,
    });
    expect(of(absent!.id).classLevelId).toBe(s.classes[7]);
    expect(of(s.students.sixB[0]!.id).sectionId).toBe(s.sections[2027][7].kha);

    const applied = await run(s, six.id);
    expect(applied.rows.every((r) => r.applyOutcome === 'ENROLLED' && r.toEnrolmentId)).toBe(true);
    expect(applied.lastError).toBeNull();

    const graduates = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.findMany({
        where: { id: { in: s.students.ten.map((t) => t.id) } },
        select: { status: true, leftOn: true, deletedAt: true },
      }),
    );
    expect(graduates).toEqual([
      { status: 'GRADUATED', leftOn: new Date('2026-12-31'), deletedAt: null },
      { status: 'GRADUATED', leftOn: new Date('2026-12-31'), deletedAt: null },
    ]);
    // Their 2026 rolls stay (history).
    const tenRolls = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.enrolment.findMany({
        where: { studentId: { in: s.students.ten.map((t) => t.id) } },
        select: { roll: true },
      }),
    );
    expect(tenRolls.map((r) => r.roll).sort()).toEqual([1, 2]);
    const studentAudit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.count({
        where: { entity: 'student', entityId: { in: s.students.ten.map((t) => t.id) } },
      }),
    );
    expect(studentAudit).toBe(2);
    expect((await currentYear(s)).id).toBe(s.y2026);
  });

  describe('with the queue paused (the test drives the job)', () => {
    beforeAll(async () => {
      await promotionsQueue(h).pause();
    });

    it('kill and resume: a failure after some sections stops the job; running it again finishes without duplicates', async () => {
      const s = await promotionSchool(h);
      const six = await createRun(s, 6);
      await startApply(s, six.id);
      const apply = h.app.get(PromotionApplyService);
      const original = apply.applySection.bind(apply);
      let calls = 0;
      const spy = vi.spyOn(apply, 'applySection').mockImplementation(async (runId, sectionId) => {
        calls++;
        if (calls === 2) throw new Error('worker died');
        return original(runId, sectionId);
      });
      try {
        await expect(processRun(s, six.id)).rejects.toThrow('worker died');
        const stopped = await run(s, six.id);
        expect(stopped).toMatchObject({ status: 'APPLYING', lastError: 'ERROR' });
        const done = stopped.rows.filter((r) => r.appliedAt).length;
        expect(done).toBeGreaterThan(0);
        expect(done).toBeLessThan(stopped.rows.length);
        // The queued job is still there, so resume is refused until it is gone.
        await api(s.tokens.admin).post(`/promotions/${six.id}/resume`).expect(409);
        await removeJob(six.id);
        await api(s.tokens.admin).post(`/promotions/${six.id}/resume`).expect(200);
        await processRun(s, six.id);
      } finally {
        spy.mockRestore();
      }
      const finished = await run(s, six.id);
      expect(finished).toMatchObject({ status: 'APPLIED', lastError: null });
      const enrolled = await enrolments2027(s);
      expect(enrolled).toHaveLength(finished.rows.length);
      expect(new Set(enrolled.map((e) => e.studentId)).size).toBe(enrolled.length);
      expect(finished.rows.every((r) => r.applyOutcome === 'ENROLLED')).toBe(true);
      await removeJob(six.id);
    });

    it('concurrent apply: one 200, one 409 RUN_APPLYING, exactly one job', async () => {
      const s = await promotionSchool(h);
      const seven = await createRun(s, 7);
      const { version } = await check(s, seven.id);
      const [a, b] = await Promise.all(
        [0, 1].map(() => api(s.tokens.admin).post(`/promotions/${seven.id}/apply`, { version })),
      );
      expect([a!.status, b!.status].sort()).toEqual([200, 409]);
      expect([a!.body.code, b!.body.code]).toContain('RUN_APPLYING');
      const jobs = (await promotionsQueue(h).getJobs(['waiting', 'paused', 'delayed'])).filter(
        (j) => j.data.runId === seven.id,
      );
      expect(jobs.map((j) => j.id)).toEqual([applyJobId(seven.id)]);
      await removeJob(seven.id);
    });

    it('two executions of a section at once apply each row once', async () => {
      const s = await promotionSchool(h);
      const six = await createRun(s, 6);
      await startApply(s, six.id);
      const apply = h.app.get(PromotionApplyService);
      const jobs = h.app.get(TenantJobRunner);
      const section = s.sections[2027][7].ka;
      const opts = { actorUserId: s.userIds.admin };
      const [x, y] = await Promise.all([
        jobs.run(s.tenantId, () => apply.applySection(six.id, section), opts),
        jobs.run(s.tenantId, () => apply.applySection(six.id, section), opts),
      ]);
      expect(x.enrolled + y.enrolled).toBe(2);
      expect(Math.min(x.enrolled, y.enrolled)).toBe(0);
      const inSection = (await enrolments2027(s)).filter((e) => e.sectionId === section);
      expect(inSection).toHaveLength(2);
      await processRun(s, six.id);
      expect((await enrolments2027(s)).length).toBe(4);
      await removeJob(six.id);
    });

    it('already enrolled by hand → ALREADY_ENROLLED (untouched); deactivated → SKIPPED_DEACTIVATED', async () => {
      const s = await promotionSchool(h);
      const six = await createRun(s, 6);
      const admin = api(s.tokens.admin);
      const [passed, , absent] = s.students.six;
      await admin
        .post(`/students/${passed!.id}/enrolments`, {
          academicYearId: s.y2027,
          classLevelId: s.classes[7],
          sectionId: s.sections[2027][7].kha,
          roll: 9,
        })
        .expect(201);
      await admin.post(`/students/${absent!.id}/deactivate`).expect(200);
      await startApply(s, six.id);
      await processRun(s, six.id);
      const done = await run(s, six.id);
      expect(done.status).toBe('APPLIED');
      const rowOf = (id: string) => done.rows.find((r) => r.student.id === id)!;
      expect(rowOf(passed!.id).applyOutcome).toBe('ALREADY_ENROLLED');
      expect(rowOf(absent!.id).applyOutcome).toBe('SKIPPED_DEACTIVATED');
      const own = (await enrolments2027(s)).find((e) => e.studentId === passed!.id)!;
      expect(own).toMatchObject({ sectionId: s.sections[2027][7].kha, roll: 9 });
      expect(rowOf(passed!.id).toEnrolmentId).toBe(own.id);
      expect((await enrolments2027(s)).some((e) => e.studentId === absent!.id)).toBe(false);
      await removeJob(six.id);
    });

    it('a full section is refused at apply; filled meanwhile, the job stops and resumes after the capacity is raised', async () => {
      const s = await promotionSchool(h, { capacity: 1 });
      const six = await createRun(s, 6);
      const admin = api(s.tokens.admin);
      const full = await startApply(s, six.id, 422);
      expect(full.body.code).toBe('SECTION_FULL');
      expect(full.body.sections).toEqual([
        { sectionId: s.sections[2027][7].ka, capacity: 1, enrolled: 0, incoming: 2 },
      ]);
      // Raise 7 ক to 2, apply, then an admission takes a seat before the job runs.
      await admin.patch(`/setup/sections/${s.sections[2027][7].ka}`, { capacity: 2 }).expect(200);
      await startApply(s, six.id);
      await admin
        .post('/students', {
          nameEn: 'Late admission',
          guardians: [
            { phone: randomPhone(), nameEn: 'Guardian', relation: 'FATHER', isPrimary: true },
          ],
          enrolment: {
            academicYearId: s.y2027,
            classLevelId: s.classes[7],
            sectionId: s.sections[2027][7].ka,
            roll: null,
          },
        })
        .expect(201);
      await expect(processRun(s, six.id)).rejects.toThrow('SECTION_FULL');
      expect(await run(s, six.id)).toMatchObject({ status: 'APPLYING', lastError: 'SECTION_FULL' });
      await removeJob(six.id);
      await admin.patch(`/setup/sections/${s.sections[2027][7].ka}`, { capacity: 3 }).expect(200);
      await admin.post(`/promotions/${six.id}/resume`).expect(200);
      await processRun(s, six.id);
      expect(await run(s, six.id)).toMatchObject({ status: 'APPLIED', lastError: null });
      await removeJob(six.id);
    });

    it('an applied row cannot be edited; rows added by a refresh after APPLIED apply alone', async () => {
      const s = await promotionSchool(h);
      const seven = await createRun(s, 7);
      await startApply(s, seven.id);
      await processRun(s, seven.id);
      const done = await run(s, seven.id);
      expect(done.status).toBe('APPLIED');
      const admin = api(s.tokens.admin);
      const edit = await admin
        .put(`/promotions/${seven.id}/rows`, {
          rows: [{ id: done.rows[0]!.id, decision: 'REPEAT', targetClassLevelId: s.classes[7] }],
        })
        .expect(409);
      expect(edit.body.code).toBe('ROW_APPLIED');
      // A new student of class 7 (2026), then refresh and apply again.
      const late = await withTenant(h.prisma, s.tenantId, async (tx) => {
        const st = await tx.student.create({
          data: { tenantId: s.tenantId, studentCode: `LATE-${Date.now()}`, nameBn: 'দেরি' },
        });
        await tx.enrolment.create({
          data: {
            tenantId: s.tenantId,
            studentId: st.id,
            academicYearId: s.y2026,
            classLevelId: s.classes[7],
            sectionId: s.sections[2026][7].ka,
            roll: 3,
          },
        });
        return st.id;
      });
      const refreshed = (await admin.post(`/promotions/${seven.id}/refresh`).expect(200))
        .body as PromotionRunDetail;
      expect(refreshed).toMatchObject({ status: 'APPLIED', counts: { pending: 1, total: 3 } });
      await removeJob(seven.id);
      await startApply(s, seven.id);
      await processRun(s, seven.id);
      const again = await run(s, seven.id);
      expect(again).toMatchObject({ status: 'APPLIED', counts: { pending: 0 } });
      expect((await enrolments2027(s)).filter((e) => e.studentId === late)).toHaveLength(1);
      expect(await enrolments2027(s)).toHaveLength(3);
      await removeJob(seven.id);
    });

    it('the actor lost ADMIN: the job stops with ACTOR_NOT_ADMIN', async () => {
      const s = await promotionSchool(h);
      const seven = await createRun(s, 7);
      await startApply(s, seven.id);
      await h.access.setMemberRoles(s.tenantId, s.userIds.admin, ['TEACHER']);
      await expect(processRun(s, seven.id)).rejects.toThrow('ACTOR_NOT_ADMIN');
      expect(await run(s, seven.id, s.tokens.owner)).toMatchObject({
        status: 'APPLYING',
        lastError: 'ACTOR_NOT_ADMIN',
      });
      expect(await enrolments2027(s)).toHaveLength(0);
      // The owner resumes it as themselves.
      await removeJob(seven.id);
      await api(s.tokens.owner).post(`/promotions/${seven.id}/resume`).expect(200);
      await processRun(s, seven.id, s.userIds.owner);
      expect((await run(s, seven.id, s.tokens.owner)).status).toBe('APPLIED');
      await removeJob(seven.id);
    });

    it("repeaters keep their subject choices; promoted students don't", async () => {
      const s = await promotionSchool(h);
      const [passed, failed] = s.students.six;
      await withTenant(h.prisma, s.tenantId, async (tx) => {
        const subject = await tx.subject.findFirstOrThrow({
          where: { classLevelId: s.classes[6] },
          orderBy: { sortOrder: 'asc' },
        });
        for (const st of [passed!, failed!])
          await tx.studentSubjectChoice.create({
            data: {
              tenantId: s.tenantId,
              academicYearId: s.y2026,
              studentId: st.id,
              subjectId: subject.id,
              kind: 'COMPULSORY',
            },
          });
      });
      const six = await createRun(s, 6);
      await startApply(s, six.id);
      await processRun(s, six.id);
      const choices = await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.studentSubjectChoice.findMany({
          where: { academicYearId: s.y2027 },
          select: { studentId: true },
        }),
      );
      expect(choices.map((c) => c.studentId)).toEqual([failed!.id]);
      await removeJob(six.id);
    });

    it('600 students in one class and one section apply in one section transaction (< 15 s)', async () => {
      const s = await promotionSchool(h, { modules: [] });
      await withTenant(
        h.prisma,
        s.tenantId,
        async (tx) => {
          const ids = Array.from({ length: 600 }, () => randomUUID());
          await tx.student.createMany({
            data: ids.map((id, i) => ({
              id,
              tenantId: s.tenantId,
              studentCode: `BIG-${i}-${id.slice(0, 6)}`,
              nameBn: `ছাত্র ${i}`,
            })),
          });
          await tx.enrolment.createMany({
            data: ids.map((studentId, i) => ({
              tenantId: s.tenantId,
              studentId,
              academicYearId: s.y2026,
              classLevelId: s.classes[8],
              sectionId: s.sections[2026][8].ka,
              roll: i + 1,
            })),
          });
        },
        { timeout: 60_000 },
      );
      const eight = (
        await api(s.tokens.admin)
          .post('/promotions', {
            fromYearId: s.y2026,
            toYearId: s.y2027,
            classLevelId: s.classes[8],
          })
          .expect(201)
      ).body as PromotionRunDetail;
      expect(eight.rows).toHaveLength(600);
      await startApply(s, eight.id);
      const started = Date.now();
      await processRun(s, eight.id);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect((await run(s, eight.id)).status).toBe('APPLIED');
      expect(await enrolments2027(s)).toHaveLength(600);
      await removeJob(eight.id);
    }, 60_000);

    it('nothing to apply, a stale version, a run of another institute', async () => {
      const s = await promotionSchool(h);
      const seven = await createRun(s, 7);
      const admin = api(s.tokens.admin);
      const stale = await admin
        .post(`/promotions/${seven.id}/apply`, { version: 'not-the-version' })
        .expect(409);
      expect(stale.body.code).toBe('PREVIEW_CHANGED');
      await startApply(s, seven.id);
      await processRun(s, seven.id);
      const nothing = await startApply(s, seven.id, 422);
      expect(nothing.body.code).toBe('NOTHING_TO_APPLY');
      const other = await promotionSchool(h);
      await api(other.tokens.admin).get(`/promotions/${seven.id}/apply-check`).expect(404);
      await api(other.tokens.admin).post(`/promotions/${seven.id}/resume`).expect(404);
      await api(s.tokens.teacher).post(`/promotions/${seven.id}/resume`).expect(403);
      await removeJob(seven.id);
    });
  });
});
