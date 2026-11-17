import { withTenant } from '@jantrik/db';
import type { AdmissionAdmitCards, AdmissionTestClassView } from '@jantrik/shared';
import sharp from 'sharp';
import {
  admissionCycle,
  admissionSchool,
  api,
  staffApplication,
  testClass,
  type AdmissionSchool,
} from './support/admission.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';

/** Sprint 1 P4, task 3: a class's test settings, the test rolls (P4-C) and the admit cards. */
describe('admission test (P4): setup, rolls and admit cards', () => {
  let h: Harness;
  let s: AdmissionSchool;

  const admin = () => api(h, s.tokens.admin);
  const setup = (cc: string, body: object) =>
    admin().patch(`/admission/cycle-classes/${cc}/test`, body);
  const rolls = (cc: string, body: object = {}) =>
    admin().post(`/admission/cycle-classes/${cc}/test-rolls`, body);
  const rollsOf = async (cc: string) =>
    Object.fromEntries(
      (
        await withTenant(h.prisma, s.tenantId, (tx) =>
          tx.admissionApplication.findMany({
            where: { cycleClassId: cc },
            select: { id: true, testRoll: true },
          }),
        )
      ).map((r) => [r.id, r.testRoll]),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await admissionSchool(h);
  });
  afterAll(() => h.close());

  it('a cycle without a test takes no test settings or rolls; teachers get nothing', async () => {
    const plain = await admissionCycle(h, s);
    const cc = plain.classes[0]!.id;
    const res = await setup(cc, { fullMarks: 100 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEST_NOT_REQUIRED');
    expect((await rolls(cc)).body.code).toBe('TEST_NOT_REQUIRED');
    const t = await testClass(h, s, 0);
    await api(h, s.tokens.teacher)
      .patch(`/admission/cycle-classes/${t.cc}/test`, { fullMarks: 100 })
      .expect(403);
    await api(h, s.tokens.teacher).get(`/admission/cycle-classes/${t.cc}/test`).expect(403);
  });

  it('the settings are saved (Bangla digits accepted) and audited; pass marks above the full marks are refused', async () => {
    const t = await testClass(h, s, 0);
    const view = (
      await setup(t.cc, {
        testDate: '2026-12-20',
        testTime: '10:30',
        testVenueBn: 'মূল ভবন',
        fullMarks: '১০০',
        passMarks: 33,
        selectCount: 2,
        waitlistCount: 1,
      }).expect(200)
    ).body as AdmissionTestClassView;
    expect(view).toMatchObject({
      testDate: '2026-12-20',
      testTime: '10:30',
      testVenueBn: 'মূল ভবন',
      fullMarks: 100,
      passMarks: 33,
      selectCount: 2,
      waitlistCount: 1,
      resultsVersion: 0,
      cycle: { requiresTest: true, meritTieBreak: 'OLDER_FIRST' },
    });
    const bad = await setup(t.cc, { passMarks: 120 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('PASS_ABOVE_FULL');
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findFirst({ where: { entity: 'admission_test_setup', entityId: t.cc } }),
    );
    expect(audit?.newValues).toMatchObject({ fullMarks: 100, passMarks: 33 });
  });

  it('rolls: SUBMITTED and SHORTLISTED by application number from the start; a late one gets the next; issuing again changes nothing (P4-C)', async () => {
    const t = await testClass(h, s, 5);
    await admin()
      .post(`/admission/applications/${t.apps[1]!.id}/status`, { status: 'SHORTLISTED' })
      .expect(200);
    await admin()
      .post(`/admission/applications/${t.apps[4]!.id}/status`, {
        status: 'REJECTED',
        reason: 'Too old',
      })
      .expect(200);
    expect((await rolls(t.cc, { startAt: 1001 }).expect(200)).body).toEqual({
      issued: 4,
      from: 1001,
      to: 1004,
    });
    let got = await rollsOf(t.cc);
    expect(t.apps.map((a) => got[a.id])).toEqual([1001, 1002, 1003, 1004, null]);
    const late = await staffApplication(h, s, t.cc, { nameEn: 'Late Applicant' });
    expect((await rolls(t.cc).expect(200)).body).toEqual({ issued: 1, from: 1005, to: 1005 });
    expect((await rolls(t.cc, { startAt: 1 }).expect(200)).body).toEqual({
      issued: 0,
      from: null,
      to: null,
    });
    got = await rollsOf(t.cc);
    expect(got[late.id]).toBe(1005);
    expect(got[t.apps[0]!.id]).toBe(1001);
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.count({ where: { entity: 'admission_test_rolls', entityId: t.cc } }),
    );
    expect(audit).toBe(2);
  });

  it('admit cards: the issued rolls in a range with a photo flag; none issued is 422; another institute 404', async () => {
    const t = await testClass(h, s, 3);
    await setup(t.cc, {
      testDate: '2026-12-20',
      testTime: '10:30',
      testVenueBn: 'মূল ভবন',
    }).expect(200);
    const none = await admin().get(`/admission/cycle-classes/${t.cc}/admit-cards`);
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('ROLLS_NOT_ISSUED');
    const png = await sharp({
      create: { width: 300, height: 400, channels: 3, background: { r: 20, g: 120, b: 60 } },
    })
      .png()
      .toBuffer();
    await http(h)
      .put(`/admission/applications/${t.apps[1]!.id}/photo`)
      .set(bearer(s.tokens.admin))
      .attach('file', png, 'p.png')
      .expect(200);
    await rolls(t.cc, { startAt: 1 }).expect(200);
    const cards = (
      await admin().get(`/admission/cycle-classes/${t.cc}/admit-cards?from=2&to=3`).expect(200)
    ).body as AdmissionAdmitCards;
    expect(cards.cards.map((c) => [c.testRoll, c.applicationNo, c.hasPhoto])).toEqual([
      [2, t.apps[1]!.applicationNo, true],
      [3, t.apps[2]!.applicationNo, false],
    ]);
    expect(cards).toMatchObject({
      testDate: '2026-12-20',
      testTime: '10:30',
      testVenueBn: 'মূল ভবন',
      classLevel: { id: s.class6 },
    });
    const other = await admissionSchool(h);
    await api(h, other.tokens.admin)
      .get(`/admission/cycle-classes/${t.cc}/admit-cards`)
      .expect(404);
  });

  it('an application with a test roll stays in its class (409 HAS_TEST_ROLL)', async () => {
    const t = await testClass(h, s, 1);
    await rolls(t.cc).expect(200);
    const class7 = t.cycle.classes.find((c) => c.classLevel.id === s.class7)!.id;
    const res = await admin().patch(`/admission/applications/${t.apps[0]!.id}`, {
      cycleClassId: class7,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_TEST_ROLL');
  });
});
