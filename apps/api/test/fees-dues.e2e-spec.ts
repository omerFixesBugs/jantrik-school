import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type { FeeHeadView, FeeLedger } from '@jantrik/shared';
import { FeeDuesProcessor } from '../src/fees/dues/fee-dues.processor.js';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';

/** Dues (step 9, phase B): generated idempotently, lazily and nightly; the student ledger. */
describe('fee dues', () => {
  let h: Harness;
  let s: FeesSchool;
  let tuition: FeeHeadView;
  let admission: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const ledger = async (studentId: string, token = s.tokens.accountant) =>
    (await api(token).get(`/fees/students/${studentId}/ledger`).expect(200)).body as FeeLedger;
  const dueCount = (studentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) => tx.feeDue.count({ where: { studentId } }));

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    const admin = api(s.tokens.admin);
    tuition = (
      await admin
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
    admission = (
      await admin
        .post('/fees/heads', {
          nameBn: 'ভর্তি ফি',
          nameEn: 'Admission fee',
          kind: 'ADMISSION',
          frequency: 'ONE_TIME',
          dueOffsetDays: 7,
          oneTimeFrom: `${s.months.previous}-01`,
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
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
          { feeHeadId: admission.id, classLevelId: s.class6, amountPaisa: 500000 },
        ],
      })
      .expect(200);
  });

  afterAll(() => h.close());

  it('nothing is due until the owner sets the month dues start', async () => {
    const before = await ledger(s.students[2]!.id);
    expect(before.dues).toEqual([]);
    await api(s.tokens.admin)
      .put('/fees/settings', {
        duesFrom: `${s.months.previous}-01`,
        receiptSmsEnabled: true,
        sibling: { type: 'PERCENT', value: 50, fromChild: 2 },
        receiptNote: null,
      })
      .expect(200);
  });

  it('the ledger generates the monthly dues from that month to now, once', async () => {
    const id = s.students[2]!.id;
    const first = await ledger(id);
    expect(first.dues.map((d) => d.periodKey)).toEqual([s.months.previous, s.months.current]);
    const last = first.dues[0]!;
    expect(last).toMatchObject({
      amountPaisa: 100000,
      dueDate: `${s.months.previous}-10`,
      overdue: true,
      // A month or more late: the per-day fine has reached its cap.
      balance: { principal: 100000, fine: 10000, total: 110000 },
    });
    // Old student, admitted before the admission fee applies: none.
    expect(first.dues.some((d) => d.head.id === admission.id)).toBe(false);
    // Later months of this year can be paid ahead.
    expect(first.upcoming.length).toBeGreaterThan(0);
    expect(first.upcoming[0]!.periodKey > s.months.current).toBe(true);

    await Promise.all(Array.from({ length: 5 }, () => ledger(id)));
    expect(await dueCount(id)).toBe(2);
  });

  it('a study group amount overrides the class amount', async () => {
    const dues = (await ledger(s.students[3]!.id)).dues;
    expect(dues.length).toBe(2);
    expect(dues.every((d) => d.amountPaisa === 180000)).toBe(true);
  });

  it('teachers and other institutes cannot see a ledger', async () => {
    await api(s.tokens.teacher).get(`/fees/students/${s.students[2]!.id}/ledger`).expect(403);
    const other = await feesSchool(h);
    await api(other.tokens.admin).get(`/fees/students/${s.students[2]!.id}/ledger`).expect(404);
  });

  it('a new admission pays the admission fee once and months from the admission month', async () => {
    const newcomer = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const student = await tx.student.create({
        data: { tenantId: s.tenantId, studentCode: `N-${randomUUID().slice(0, 8)}`, nameEn: 'New' },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: student.id,
          academicYearId: s.yearId,
          classLevelId: s.class6,
          sectionId: s.sectionId,
          roll: 50,
        },
      });
      return student;
    });
    const dues = (await ledger(newcomer.id)).dues;
    expect(
      dues
        .map((d) => `${d.head.id === admission.id ? 'admission' : 'tuition'}:${d.periodKey}`)
        .sort(),
    ).toEqual(['admission:ONCE', `tuition:${s.months.current}`].sort());
    const once = dues.find((d) => d.periodKey === 'ONCE')!;
    expect(once.dueDate >= s.today).toBe(true);
  });

  it('only a confirmed family gets the sibling discount', async () => {
    const [a, b] = [s.students[0]!.id, s.students[1]!.id];
    const unconfirmed = [...(await ledger(a)).dues, ...(await ledger(b)).dues];
    expect(unconfirmed.every((d) => d.concessionPaisa === 0)).toBe(true);

    await api(s.tokens.admin)
      .post('/fees/siblings', { studentIds: [a, b] })
      .expect(201);
    // Existing dues keep their snapshot until an admin recalculates unpaid dues.
    expect(
      [...(await ledger(a)).dues, ...(await ledger(b)).dues].every((d) => d.concessionPaisa === 0),
    ).toBe(true);
    const res = await api(s.tokens.admin)
      .post('/fees/dues/recalculate', { studentIds: [a, b] })
      .expect(200);
    expect(res.body.updated).toBe(2); // the younger child's two months
    const after = [...(await ledger(a)).dues, ...(await ledger(b)).dues];
    expect(after.filter((d) => d.concessionSource === 'SIBLING')).toHaveLength(2);
    expect(
      after
        .filter((d) => d.concessionSource === 'SIBLING')
        .every((d) => d.concessionPaisa === 50000),
    ).toBe(true);
    const family = (await ledger(b)).family ?? (await ledger(a)).family;
    expect(family?.rank).toBeDefined();
  });

  it('an admin waives part or all of a fine, with a reason; the accountant cannot', async () => {
    const due = (await ledger(s.students[2]!.id)).dues[0]!;
    await api(s.tokens.accountant)
      .post(`/fees/dues/${due.id}/waive-fine`, { amountPaisa: 3000, reason: 'অসুস্থ ছিল' })
      .expect(403);
    await api(s.tokens.admin)
      .post(`/fees/dues/${due.id}/waive-fine`, { amountPaisa: 3000, reason: 'অসুস্থ ছিল' })
      .expect(200);
    let after = (await ledger(s.students[2]!.id)).dues[0]!;
    expect(after.balance.fine).toBe(7000);
    expect(after.fineWaivedPaisa).toBe(3000);
    await api(s.tokens.admin)
      .post(`/fees/dues/${due.id}/waive-fine`, {
        amountPaisa: null,
        reason: 'প্রধান শিক্ষকের সিদ্ধান্ত',
      })
      .expect(200);
    const view = await ledger(s.students[2]!.id);
    after = view.dues[0]!;
    expect(after).toMatchObject({ fineWaivedAll: true, balance: { fine: 0, principal: 100000 } });
    expect(view.waivers).toHaveLength(2);
    const audits = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.count({ where: { entity: 'fee_due', entityId: due.id } }),
    );
    expect(audits).toBe(2);
  });

  it('an admin cancels a due with a reason; it stays visible and is never generated again', async () => {
    const id = s.students[3]!.id;
    const due = (await ledger(id)).dues[0]!;
    await api(s.tokens.accountant)
      .post(`/fees/dues/${due.id}/cancel`, { reason: 'ভুল ক্লাস' })
      .expect(403);
    await api(s.tokens.admin).post(`/fees/dues/${due.id}/cancel`, { reason: 'x' }).expect(400);
    await api(s.tokens.admin)
      .post(`/fees/dues/${due.id}/cancel`, { reason: 'ভুল ক্লাসে ভর্তি' })
      .expect(200);
    await api(s.tokens.admin).post(`/fees/dues/${due.id}/cancel`, { reason: 'আবার' }).expect(409);
    const view = await ledger(id);
    const cancelled = view.dues.find((d) => d.id === due.id)!;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', balance: { total: 0 } });
    expect(view.dues).toHaveLength(2);
  });

  it("recalculating rewrites only untouched dues to today's setup", async () => {
    const id = s.students[2]!.id; // its first due has fine waivers: touched
    await api(s.tokens.admin)
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [{ feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 120000 }],
      })
      .expect(200);
    expect((await ledger(id)).dues.map((d) => d.amountPaisa)).toEqual([100000, 100000]);
    await api(s.tokens.accountant).post('/fees/dues/recalculate', {}).expect(403);
    // The whole institute is recalculated in the background, chunk by chunk.
    await api(s.tokens.admin).post('/fees/dues/recalculate', {}).expect(202);
    await vi.waitFor(
      async () =>
        expect((await ledger(id)).dues.map((d) => d.amountPaisa)).toEqual([100000, 120000]),
      { timeout: 10_000, interval: 200 },
    );
    const run = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findFirst({
        where: { entity: 'fee_dues_recalculation' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(run?.actorUserId).toBe(s.userIds.admin);
  });

  it('"generate now" runs in the background for the whole institute', async () => {
    const newcomer = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: {
          tenantId: s.tenantId,
          studentCode: `G-${randomUUID().slice(0, 8)}`,
          nameEn: 'Gen',
          createdAt: new Date('2020-01-01'),
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: st.id,
          academicYearId: s.yearId,
          classLevelId: s.class6,
        },
      });
      return st;
    });
    await api(s.tokens.accountant).post('/fees/dues/generate', {}).expect(403);
    await api(s.tokens.admin).post('/fees/dues/generate', {}).expect(202);
    await vi.waitFor(async () => expect(await dueCount(newcomer.id)).toBe(2), {
      timeout: 10_000,
      interval: 200,
    });
  });

  it('the nightly job generates every student’s dues, even after its Redis list was lost', async () => {
    const fresh = await feesSchool(h);
    const admin = api(fresh.tokens.admin);
    const head = (
      await admin
        .post('/fees/heads', {
          nameBn: 'বেতন',
          nameEn: 'Tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 5,
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: fresh.yearId,
        amounts: [
          { feeHeadId: head.id, classLevelId: fresh.class6, amountPaisa: 50000 },
          { feeHeadId: head.id, classLevelId: fresh.class9, amountPaisa: 50000 },
        ],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${fresh.months.current}-01`,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
    const total = () => withTenant(h.prisma, fresh.tenantId, (tx) => tx.feeDue.count());
    expect(await total()).toBe(0);

    // Saving the settings listed the institute for the nightly run.
    await h.app.get(FeeDuesProcessor).generateAll();
    expect(await total()).toBe(4);
    await h.app.get(FeeDuesProcessor).generateAll();
    expect(await total()).toBe(4);
    const run = await withTenant(h.prisma, fresh.tenantId, (tx) =>
      tx.auditLog.findFirst({ where: { entity: 'fee_dues_run' } }),
    );
    expect(run?.actorUserId).toBeNull();

    // Redis lost the list: the lazy path still produces dues on the next ledger view.
    await h.redis.del('fees:tenants');
    const newcomer = await withTenant(h.prisma, fresh.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: {
          tenantId: fresh.tenantId,
          studentCode: `L-${randomUUID().slice(0, 8)}`,
          nameEn: 'Late',
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: fresh.tenantId,
          studentId: st.id,
          academicYearId: fresh.yearId,
          classLevelId: fresh.class6,
        },
      });
      return st;
    });
    const view = (
      await api(fresh.tokens.accountant).get(`/fees/students/${newcomer.id}/ledger`).expect(200)
    ).body as FeeLedger;
    expect(view.dues).toHaveLength(1);
  });
});
