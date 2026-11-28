import { withTenant } from '@jantrik/db';
import {
  addDays,
  addYears,
  type FeeDueList,
  type FeeHeadView,
  type FeeLeaversReport,
  type FeeLedger,
  type PromotionApplyCheck,
  type PromotionRunDetail,
  type SetupAcademicYear,
  type StudentProfile,
} from '@jantrik/shared';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { feesSchool, type FeesSchool } from './support/fees.js';

/**
 * P5 Task 9 (S17, review focus 4): dues carry over by not moving. Old dues stay on their year;
 * promoted students and repeaters see them as "previous years"; leavers drop out of the due list
 * but stay on the leavers report; nothing in fee_dues or fee_payments is created, changed or
 * moved by a promotion.
 */
describe('fees across the year: carry-over by not moving', () => {
  let h: Harness;
  let s: FeesSchool;
  let next: SetupAcademicYear;
  let admitted: string;
  let gone: string;
  let session: FeeHeadView;
  let admission: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const ledger = async (studentId: string) =>
    (await api(s.tokens.accountant).get(`/fees/students/${studentId}/ledger`).expect(200))
      .body as FeeLedger;
  const money = () =>
    withTenant(h.prisma, s.tenantId, async (tx) => ({
      dues: await tx.feeDue.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          studentId: true,
          academicYearId: true,
          amountPaisa: true,
          paidPrincipalPaisa: true,
          status: true,
        },
      }),
      payments: await tx.feePayment.count(),
    }));
  const admit = async (name: string, classLevelId: string, sectionId: string) =>
    (
      (
        await api(s.tokens.admin)
          .post('/students', {
            nameEn: name,
            guardians: [
              { phone: randomPhone(), nameEn: 'Guardian', relation: 'FATHER', isPrimary: true },
            ],
            enrolment: { academicYearId: s.yearId, classLevelId, sectionId, roll: null },
          })
          .expect(201)
      ).body as StudentProfile
    ).id;

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    const admin = api(s.tokens.admin);
    const head = async (body: object) =>
      (await admin.post('/fees/heads', body).expect(201)).body as FeeHeadView;
    const tuition = await head({
      nameBn: 'মাসিক বেতন',
      nameEn: 'Tuition',
      kind: 'TUITION',
      frequency: 'MONTHLY',
      dueDay: 10,
    });
    session = await head({
      nameBn: 'সেশন ফি',
      nameEn: 'Session',
      kind: 'SESSION',
      frequency: 'YEARLY',
    });
    admission = await head({
      nameBn: 'ভর্তি ফি',
      nameEn: 'Admission',
      kind: 'ADMISSION',
      frequency: 'ONE_TIME',
      oneTimeFrom: `${s.months.previous}-01`,
    });
    const class7 = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_7' } }),
    );
    await admin
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [s.class6, class7.id, s.class9].flatMap((classLevelId) => [
          { feeHeadId: tuition.id, classLevelId, amountPaisa: 100000 },
          { feeHeadId: session.id, classLevelId, amountPaisa: 200000 },
          { feeHeadId: admission.id, classLevelId, amountPaisa: 300000 },
        ]),
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${s.months.previous}-01`,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
    // A student admitted now (gets the admission fee) and one who will be deactivated.
    admitted = await admit('Admitted Now', s.class6, s.sectionId);
    const section9 = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.section.findFirstOrThrow({ where: { academicYearId: s.yearId, classLevelId: s.class9 } }),
    );
    gone = await admit('=HYPERLINK("x")', s.class9, section9.id);
    // Dues of this year for everyone (the ledger makes them).
    for (const id of [...s.students.map((x) => x.id), admitted, gone]) await ledger(id);
    await admin.post(`/students/${gone}/deactivate`).expect(200);

    // The next year, sections copied (class 6 ক, class 9 ক), plus class 7 ক; amounts copied.
    const start = addDays(s.yearEnd, 1);
    next = (
      await admin
        .post('/setup/academic-years', {
          name: 'Next year',
          startDate: start,
          endDate: addDays(addYears(start, 1), -1),
          copySectionsFrom: s.yearId,
        })
        .expect(201)
    ).body as SetupAcademicYear;
    await admin
      .post('/setup/sections', {
        academicYearId: next.id,
        classLevelId: class7.id,
        name: 'ক',
      })
      .expect(201);
    await admin
      .post('/fees/amounts/copy', { fromAcademicYearId: s.yearId, toAcademicYearId: next.id })
      .expect(200);
  });

  afterAll(() => h.close());

  it('a promotion creates, changes and moves no money row; the current year is switched by hand', async () => {
    const before = await money();
    expect(before.dues.length).toBeGreaterThan(0);
    const admin = api(s.tokens.admin);
    const run = (
      await admin
        .post('/promotions', { fromYearId: s.yearId, toYearId: next.id, classLevelId: s.class6 })
        .expect(201)
    ).body as PromotionRunDetail;
    const rowOf = (id: string) => run.rows.find((r) => r.student.id === id)!;
    const section6 = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.section.findFirstOrThrow({ where: { academicYearId: next.id, classLevelId: s.class6 } }),
    );
    await admin
      .put(`/promotions/${run.id}/rows`, {
        rows: [
          {
            id: rowOf(s.students[1]!.id).id,
            decision: 'REPEAT',
            targetClassLevelId: s.class6,
            targetSectionId: section6.id,
          },
          {
            id: rowOf(s.students[2]!.id).id,
            decision: 'LEAVE',
            leaveStatus: 'TRANSFERRED',
            leftOn: s.today,
          },
        ],
      })
      .expect(200);
    const { version } = (await admin.get(`/promotions/${run.id}/apply-check`).expect(200))
      .body as PromotionApplyCheck;
    await admin.post(`/promotions/${run.id}/apply`, { version }).expect(200);
    await vi.waitFor(
      async () =>
        expect(((await admin.get(`/promotions/${run.id}`)).body as PromotionRunDetail).status).toBe(
          'APPLIED',
        ),
      { timeout: 20_000, interval: 200 },
    );
    expect(await money()).toEqual(before);
    await admin.post(`/setup/academic-years/${next.id}/current`).expect(200);
  });

  it('the due list: the promoted student and the repeater with their old dues as previous years; the leaver gone', async () => {
    const list = (await api(s.tokens.accountant).get('/fees/reports/dues').expect(200))
      .body as FeeDueList;
    const byId = new Map(list.rows.map((r) => [r.student.id, r]));
    for (const id of [s.students[0]!.id, s.students[1]!.id, admitted]) {
      const row = byId.get(id)!;
      expect(row.totalPaisa).toBeGreaterThan(0);
      expect(row.previousYearsPaisa).toBe(row.totalPaisa);
    }
    expect(byId.has(s.students[2]!.id)).toBe(false); // left
    expect(byId.has(s.students[3]!.id)).toBe(false); // not carried over
    expect(byId.has(gone)).toBe(false); // deactivated
    expect(list.totals.previousYearsPaisa).toBe(
      list.rows.reduce((sum, r) => sum + r.previousYearsPaisa, 0),
    );
    const csv = (await api(s.tokens.accountant).get('/fees/reports/dues/csv?locale=en').expect(200))
      .text;
    expect(csv.split('\r\n')[0]).toContain('Previous years (Tk)');
  });

  it('the ledger names the current year, so earlier dues show as previous years', async () => {
    const l = await ledger(s.students[0]!.id);
    expect(l.currentYearId).toBe(next.id);
    expect(l.dues.length).toBeGreaterThan(0);
    expect(l.dues.every((d) => d.academicYear.id === s.yearId)).toBe(true);
  });

  it('the admission fee is never charged again; the session fee is (the new year)', async () => {
    const l = await ledger(admitted);
    const once = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeDue.findMany({ where: { studentId: admitted, feeHeadId: admission.id } }),
    );
    expect(once).toHaveLength(1);
    expect(once[0]!.academicYearId).toBe(s.yearId);
    expect(l.upcoming.some((u) => u.headId === admission.id)).toBe(false);
    expect(l.upcoming).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          headId: session.id,
          periodKey: 'Y',
          periodStart: next.startDate,
        }),
      ]),
    );
  });

  it('the leavers report lists the leaver, the student not carried over and the deactivated one, with what they owe', async () => {
    const report = (
      await api(s.tokens.accountant).get('/fees/reports/leavers-with-dues').expect(200)
    ).body as FeeLeaversReport;
    const byId = new Map(report.rows.map((r) => [r.student.id, r]));
    expect(byId.get(s.students[2]!.id)).toMatchObject({
      kind: 'LEFT',
      status: 'TRANSFERRED',
      leftOn: s.today,
      deactivated: false,
    });
    expect(byId.get(s.students[3]!.id)).toMatchObject({
      kind: 'NOT_CARRIED_OVER',
      status: 'ACTIVE',
    });
    expect(byId.get(gone)).toMatchObject({ kind: 'DEACTIVATED', deactivated: true });
    for (const r of report.rows) expect(r.totalPaisa).toBeGreaterThan(0);
    expect(byId.has(s.students[0]!.id)).toBe(false);
    // The accountant sees masked phones.
    expect(byId.get(s.students[2]!.id)!.guardian!.phone).not.toBe(s.students[2]!.phone);
    expect(report.totals.students).toBe(report.rows.length);

    const res = await api(s.tokens.accountant)
      .get('/fees/reports/leavers-with-dues/csv?locale=en')
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain(s.students[2]!.code);
    // Formula-safe: a name starting with = is written as text.
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
    // The leaver can still pay at the counter.
    const ledgerOfLeaver = await ledger(s.students[2]!.id);
    expect(ledgerOfLeaver.totals.balance).toBeGreaterThan(0);
  });

  it('teachers and guardians cannot read the report', async () => {
    await api(s.tokens.teacher).get('/fees/reports/leavers-with-dues').expect(403);
    await api(s.tokens.guardian).get('/fees/reports/leavers-with-dues').expect(403);
  });
});
