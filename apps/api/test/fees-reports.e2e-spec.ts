import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  FeeCollections,
  FeeDueList,
  FeeHeadView,
  FeeLedger,
  FeeReceipt,
  FeeReminderPreview,
  FeeReminderRun,
  FeeReminderStatus,
  FeeSummary,
} from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';

/** Reports, reminders and the dashboard card (step 9, phase E). */
describe('fee reports and reminders', () => {
  let h: Harness;
  let s: FeesSchool;
  let tuition: FeeHeadView;
  let receipt: FeeReceipt;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const ledger = async (studentId: string) =>
    (await api(s.tokens.accountant).get(`/fees/students/${studentId}/ledger`).expect(200))
      .body as FeeLedger;
  const pay = async (studentId: string, amount?: number) => {
    const view = await ledger(studentId);
    const due = view.dues[0]!;
    return (
      await api(s.tokens.accountant)
        .post('/fees/payments', {
          studentId,
          dueIds: [due.id],
          amountPaisa: amount ?? due.balance.total,
          expectedOutstandingPaisa: due.balance.total,
          clientRequestId: randomUUID(),
        })
        .expect(201)
    ).body as FeeReceipt;
  };
  const reminderLogs = () =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findMany({ where: { purpose: 'FEE_REMINDER' } }),
    );

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
          fine: { type: 'FLAT', amountPaisa: 5000, capPaisa: null },
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [
          { feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 100000 },
          { feeHeadId: tuition.id, classLevelId: s.class9, amountPaisa: 150000 },
        ],
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
    // A name that a spreadsheet would run as a formula.
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({
        where: { id: s.students[3]!.id },
        data: { nameEn: '=HYPERLINK("http://x","y")' },
      }),
    );
    for (const st of s.students) await ledger(st.id); // their dues exist
    receipt = await pay(s.students[2]!.id); // last month, paid in full (with its flat fine)
  });

  afterAll(() => h.close());

  it('due list by class and section, with totals; defaulters only', async () => {
    const all = (await api(s.tokens.accountant).get('/fees/reports/dues').expect(200))
      .body as FeeDueList;
    const row = (id: string) => all.rows.find((r) => r.student.id === id);
    // Last month ৳1000 + its flat fine ৳50, and this month ৳1000 (fined too once past the 10th).
    const lateDues = Number(s.today.slice(8)) > 10 ? 2 : 1;
    expect(row(s.students[0]!.id)).toMatchObject({
      openDues: 2,
      principalPaisa: 200000,
      finePaisa: 5000 * lateDues,
    });
    expect(row(s.students[2]!.id)?.principalPaisa).toBe(100000); // paid last month
    expect(row(s.students[0]!.id)?.guardian?.phone).toMatch(/^01\d•+\d{3}$/);
    expect(all.totals.totalPaisa).toBe(all.rows.reduce((sum, r) => sum + r.totalPaisa, 0));

    const nine = (
      await api(s.tokens.admin).get(`/fees/reports/dues?classLevelId=${s.class9}`).expect(200)
    ).body as FeeDueList;
    expect(nine.rows.map((r) => r.student.id)).toEqual([s.students[3]!.id]);
    expect(nine.rows[0]!.guardian?.phone).toBe(s.students[3]!.phone);

    const defaulters = (
      await api(s.tokens.accountant).get('/fees/reports/dues?overdueOnly=1&minDays=1').expect(200)
    ).body as FeeDueList;
    expect(defaulters.rows.every((r) => r.overduePaisa > 0)).toBe(true);
    expect(defaulters.rows.some((r) => r.student.id === s.students[2]!.id)).toBe(
      (row(s.students[2]!.id)?.overduePaisa ?? 0) > 0,
    );
    await api(s.tokens.teacher).get('/fees/reports/dues').expect(403);
  });

  it('CSV: Bangla-safe (BOM), ASCII digits, formulas made inert', async () => {
    const res = await api(s.tokens.admin).get('/fees/reports/dues/csv?locale=en').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(text).not.toMatch(/[০-৯]/);
    const bn = await api(s.tokens.admin).get('/fees/reports/dues/csv?locale=bn').expect(200);
    expect(bn.text).not.toMatch(/[০-৯]/); // digits stay ASCII in files people re-use
  });

  it('collections by method, head, day and collector; void payments left out', async () => {
    const extra = await pay(s.students[0]!.id, 30000);
    await api(s.tokens.admin)
      .post(`/fees/payments/${extra.id}/void`, { reason: 'ভুল ছাত্র' })
      .expect(200);
    const q = (groupBy: string) =>
      api(s.tokens.accountant)
        .get(`/fees/reports/collections?from=${s.today}&to=${s.today}&groupBy=${groupBy}`)
        .expect(200)
        .then((r) => r.body as FeeCollections);
    const byMethod = await q('method');
    expect(byMethod.rows).toEqual([
      expect.objectContaining({ key: 'CASH', count: 1, amountPaisa: receipt.amountPaisa }),
    ]);
    const byHead = await q('head');
    expect(byHead.rows).toEqual([
      expect.objectContaining({
        key: tuition.id,
        nameEn: 'Monthly tuition',
        amountPaisa: receipt.amountPaisa,
      }),
    ]);
    expect((await q('day')).rows).toEqual([
      expect.objectContaining({ key: s.today, amountPaisa: receipt.amountPaisa }),
    ]);
    expect((await q('collector')).rows).toEqual([
      expect.objectContaining({ key: s.userIds.accountant, amountPaisa: receipt.amountPaisa }),
    ]);
    await api(s.tokens.accountant)
      .get(`/fees/reports/collections?from=${s.today}&to=2000-01-01&groupBy=day`)
      .expect(400);
  });

  it('sums beyond 2³¹ paisa stay exact', async () => {
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      for (let i = 1; i <= 3; i++) {
        await tx.feePayment.create({
          data: {
            tenantId: s.tenantId,
            studentId: s.students[1]!.id,
            receiptYear: 2021,
            receiptNo: i,
            method: 'CASH',
            channel: 'COUNTER',
            amountPaisa: 1_000_000_000,
            paidOn: new Date('2021-03-01'),
            recordedOn: new Date('2021-03-01'),
            collectedById: s.userIds.accountant,
            clientRequestId: randomUUID(),
          },
        });
      }
    });
    const res = (
      await api(s.tokens.admin)
        .get('/fees/reports/collections?from=2021-01-01&to=2021-12-31&groupBy=month')
        .expect(200)
    ).body as FeeCollections;
    expect(res.total).toEqual({ count: 3, amountPaisa: 3_000_000_000 });
    expect(res.rows).toEqual([
      expect.objectContaining({ key: '2021-03', amountPaisa: 3_000_000_000 }),
    ]);
  });

  it('reminders: preview with count and cost, confirm, never twice per period', async () => {
    await api(s.tokens.accountant).post('/fees/reminders/preview', {}).expect(403);
    const preview = (
      await api(s.tokens.admin).post('/fees/reminders/preview', { minDays: 1 }).expect(200)
    ).body as FeeReminderPreview;
    expect(preview.students).toBeGreaterThan(0);
    expect(preview.toSend).toBe(preview.students - preview.withoutPhone - preview.alreadyReminded);
    expect(preview.costPaisa).toBe(preview.segments * 30); // the platform's default rate
    expect(preview.sampleText).toContain('বকেয়া');

    const stale = await api(s.tokens.admin)
      .post('/fees/reminders', { minDays: 1, expectedRecipients: preview.toSend + 1 })
      .expect(409);
    expect(stale.body.code).toBe('PREVIEW_CHANGED');
    const run = (
      await api(s.tokens.admin)
        .post('/fees/reminders', { minDays: 1, expectedRecipients: preview.toSend })
        .expect(202)
    ).body as FeeReminderRun;
    expect(run.queued).toBe(preview.toSend);
    await vi.waitFor(
      async () => {
        const status = (await api(s.tokens.admin).get(`/fees/reminders/${run.runId}`).expect(200))
          .body as FeeReminderStatus;
        expect(status.counts.SENT).toBe(preview.toSend);
      },
      { timeout: 10_000, interval: 200 },
    );
    const again = (
      await api(s.tokens.admin).post('/fees/reminders/preview', { minDays: 1 }).expect(200)
    ).body as FeeReminderPreview;
    expect(again).toMatchObject({ toSend: 0, alreadyReminded: preview.toSend });
    expect(await reminderLogs()).toHaveLength(preview.toSend);
  });

  it('a held reminder is cancelled when the student pays before it goes out', async () => {
    const fresh = await feesSchool(h);
    const admin = api(fresh.tokens.admin);
    const head = (
      await admin
        .post('/fees/heads', {
          nameBn: 'বেতন',
          nameEn: 'Tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: fresh.yearId,
        amounts: [{ feeHeadId: head.id, classLevelId: fresh.class6, amountPaisa: 100000 }],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${fresh.months.previous}-01`,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
    await withTenant(h.prisma, fresh.tenantId, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: fresh.tenantId },
        data: { dailySmsCap: 0 },
      }),
    );
    const id = fresh.students[2]!.id;
    const view = (await api(fresh.tokens.accountant).get(`/fees/students/${id}/ledger`).expect(200))
      .body as FeeLedger;
    const preview = (
      await admin.post('/fees/reminders/preview', { classLevelId: fresh.class6 }).expect(200)
    ).body as FeeReminderPreview;
    expect(preview.wouldBeHeld).toBe(preview.toSend);
    await admin
      .post('/fees/reminders', { classLevelId: fresh.class6, expectedRecipients: preview.toSend })
      .expect(202);
    const logs = () =>
      withTenant(h.prisma, fresh.tenantId, (tx) =>
        tx.smsLog.findMany({ where: { purpose: 'FEE_REMINDER', relatedId: id } }),
      );
    await vi.waitFor(async () => expect((await logs())[0]?.status).toBe('HELD_OVER_LIMIT'), {
      timeout: 10_000,
    });
    const total = view.dues.reduce((sum, d) => sum + d.balance.total, 0);
    await api(fresh.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: view.dues.map((d) => d.id),
        amountPaisa: total,
        expectedOutstandingPaisa: total,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    await admin.post('/attendance/sms/held/send').expect(200);
    expect((await logs())[0]?.status).toBe('CANCELLED');
  });

  it('the dashboard card: this month, last month to date, overdue, waiting transfers', async () => {
    const summary = (await api(s.tokens.accountant).get('/fees/summary').expect(200))
      .body as FeeSummary;
    expect(summary.today).toBe(s.today);
    expect(summary.month).toEqual({ collectedPaisa: receipt.amountPaisa, count: 1 });
    expect(summary.overdue.students).toBeGreaterThan(0);
    expect(summary.pendingSubmissions).toBe(0);
    await api(s.tokens.teacher).get('/fees/summary').expect(403);
    await api(s.tokens.guardian).get('/fees/summary').expect(403);
  });
});
