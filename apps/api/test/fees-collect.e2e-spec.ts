import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type { FeeClosing, FeeHeadView, FeeLedger, FeeReceipt } from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';

/** The fee counter (step 9, phase C): collect cash, receipts, SMS, void, daily closing. */
describe('fee collection', () => {
  let h: Harness;
  let s: FeesSchool;
  let tuition: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const ledger = async (studentId: string, token = s.tokens.accountant) =>
    (await api(token).get(`/fees/students/${studentId}/ledger`).expect(200)).body as FeeLedger;
  /** Pay `amount` (default: all) of the given dues as the counter would. */
  const collect = async (
    studentId: string,
    opts: {
      dueIds?: string[];
      amount?: number;
      token?: string;
      expect?: number;
      requestId?: string;
    } = {},
  ) => {
    const view = await ledger(studentId);
    const chosen = view.dues.filter(
      (d) =>
        d.status === 'OPEN' && d.balance.total > 0 && (!opts.dueIds || opts.dueIds.includes(d.id)),
    );
    const outstanding = chosen.reduce((sum, d) => sum + d.balance.total, 0);
    return api(opts.token ?? s.tokens.accountant)
      .post('/fees/payments', {
        studentId,
        dueIds: chosen.map((d) => d.id),
        amountPaisa: opts.amount ?? outstanding,
        expectedOutstandingPaisa: outstanding,
        clientRequestId: opts.requestId ?? randomUUID(),
      })
      .expect(opts.expect ?? 201);
  };
  const smsLogs = () =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findMany({ where: { purpose: 'FEE_RECEIPT' }, orderBy: { createdAt: 'asc' } }),
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
          fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
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
        receiptSmsEnabled: true,
        sibling: null,
        receiptNote: 'ধন্যবাদ',
      })
      .expect(200);
  });

  afterAll(() => h.close());

  it('cash for an overdue month: receipt, the due cleared, an SMS to the primary guardian', async () => {
    const student = s.students[2]!;
    const due = (await ledger(student.id)).dues[0]!; // last month, fine at its cap
    const receipt = (await collect(student.id, { dueIds: [due.id] })).body as FeeReceipt;
    const year = s.today.slice(0, 4);
    expect(receipt).toMatchObject({
      receiptNumber: `${year}-000001`,
      status: 'ACTIVE',
      method: 'CASH',
      amountPaisa: 110000,
      paidOn: s.today,
      lines: [{ dueId: due.id, principalPaisa: 100000, finePaisa: 10000 }],
      institute: { receiptNote: 'ধন্যবাদ' },
    });
    expect(receipt.collectedBy?.id).toBe(s.userIds.accountant);
    const after = (await ledger(student.id)).dues.find((d) => d.id === due.id)!;
    expect(after).toMatchObject({ principalClearedOn: s.today, balance: { total: 0 } });

    await vi.waitFor(
      () => expect(h.sms.sentTo(student.phone).join(' ')).toContain(receipt.receiptNumber),
      {
        timeout: 5000,
      },
    );
    const [log] = await smsLogs();
    expect(log).toMatchObject({
      status: 'SENT',
      dedupeKey: `receipt:${receipt.id}`,
      phone: student.phone,
    });
    expect(log!.costPaisa).toBeGreaterThan(0);
  });

  it('partial payment: principal oldest first; the fine keeps running', async () => {
    const id = s.students[3]!.id;
    const before = await ledger(id);
    const receipt = (await collect(id, { amount: 50000 })).body as FeeReceipt;
    expect(receipt.lines).toEqual([
      expect.objectContaining({ dueId: before.dues[0]!.id, principalPaisa: 50000, finePaisa: 0 }),
    ]);
    const after = await ledger(id);
    expect(after.dues[0]!.balance.principal).toBe(100000);
    expect(after.dues[0]!.balance.fine).toBe(before.dues[0]!.balance.fine);
    expect(after.totals.balance).toBe(before.totals.balance - 50000);
    expect(after.payments.map((p) => p.receiptNumber)).toEqual([receipt.receiptNumber]);
  });

  it('paying ahead creates that month inside the payment', async () => {
    const id = s.students[2]!.id;
    const view = await ledger(id);
    const next = view.upcoming.find((u) => u.headId === tuition.id)!;
    const res = await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        advance: [{ headId: next.headId, periodKey: next.periodKey }],
        amountPaisa: next.amountPaisa,
        expectedOutstandingPaisa: next.amountPaisa,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    expect((res.body as FeeReceipt).lines[0]!.periodKey).toBe(next.periodKey);
    const after = await ledger(id);
    expect(after.upcoming.some((u) => u.periodKey === next.periodKey)).toBe(false);
    expect(after.dues.find((d) => d.periodKey === next.periodKey)?.balance.total).toBe(0);
  });

  it('a retried request returns the same receipt; a different one with that id is refused', async () => {
    const id = s.students[0]!.id;
    const requestId = randomUUID();
    const first = (await collect(id, { amount: 1000, requestId })).body as FeeReceipt;
    const view = await ledger(id);
    const retry = await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [first.lines[0]!.dueId],
        amountPaisa: 1000,
        expectedOutstandingPaisa: 0, // whatever the client thought: the answer is the saved one
        clientRequestId: requestId,
      })
      .expect(201);
    expect(retry.body).toMatchObject({ id: first.id, replayed: true });
    expect(view.payments).toHaveLength(1);
    const mismatch = await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [first.lines[0]!.dueId],
        amountPaisa: 2000,
        expectedOutstandingPaisa: 0,
        clientRequestId: requestId,
      })
      .expect(422);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('refuses stale or impossible payments', async () => {
    const id = s.students[1]!.id;
    const view = await ledger(id);
    const due = view.dues[0]!;
    const stale = await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [due.id],
        amountPaisa: 100,
        expectedOutstandingPaisa: due.balance.total + 1,
        clientRequestId: randomUUID(),
      })
      .expect(409);
    expect(stale.body).toMatchObject({ code: 'DUES_CHANGED', outstandingPaisa: due.balance.total });
    const tooMuch = await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [due.id],
        amountPaisa: due.balance.total + 1,
        expectedOutstandingPaisa: due.balance.total,
        clientRequestId: randomUUID(),
      })
      .expect(422);
    expect(tooMuch.body.code).toBe('AMOUNT_EXCEEDS_DUE');
    // Another student's due cannot be paid in this student's name.
    const other = (await ledger(s.students[3]!.id)).dues[1]!;
    await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [other.id],
        amountPaisa: 100,
        expectedOutstandingPaisa: other.balance.total,
        clientRequestId: randomUUID(),
      })
      .expect(404);
  });

  it('teachers and guardians cannot collect; another institute cannot see receipts', async () => {
    const id = s.students[1]!.id;
    await collect(id, { amount: 100, token: s.tokens.teacher, expect: 403 });
    await api(s.tokens.guardian).get(`/fees/students/${id}/ledger`).expect(403);
    const receipt = (await collect(id, { amount: 100 })).body as FeeReceipt;
    const other = await feesSchool(h);
    await api(other.tokens.admin).get(`/fees/payments/${receipt.id}`).expect(404);
    await api(s.tokens.teacher).get(`/fees/payments/${receipt.id}`).expect(403);
    const again = (await api(s.tokens.admin).get(`/fees/payments/${receipt.id}`).expect(200))
      .body as FeeReceipt;
    expect(again.receiptNumber).toBe(receipt.receiptNumber);
  });

  it('receipt numbers stay gap-free with payments at once and some rolled back', async () => {
    const students = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) {
        const st = await tx.student.create({
          data: {
            tenantId: s.tenantId,
            studentCode: `C-${randomUUID().slice(0, 8)}`,
            nameEn: `Many ${i}`,
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
        out.push(st.id);
      }
      return out;
    });
    const bodies = await Promise.all(
      students.map(async (id) => {
        const view = await ledger(id);
        const due = view.dues[0]!;
        return {
          studentId: id,
          dueIds: [due.id],
          amountPaisa: 100,
          expectedOutstandingPaisa: due.balance.total,
        };
      }),
    );
    const results = await Promise.all([
      ...bodies.map((b) =>
        api(s.tokens.accountant).post('/fees/payments', { ...b, clientRequestId: randomUUID() }),
      ),
      ...bodies
        .slice(0, 5)
        .map((b) =>
          api(s.tokens.accountant).post('/test/fees-collect-then-fail', {
            ...b,
            clientRequestId: randomUUID(),
          }),
        ),
    ]);
    expect(results.slice(0, 30).every((r) => r.status === 201)).toBe(true);
    expect(results.slice(30).every((r) => r.status === 400)).toBe(true);
    const numbers = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.findMany({
        where: { receiptYear: Number(s.today.slice(0, 4)) },
        select: { receiptNo: true },
      }),
    );
    const sorted = numbers.map((n) => n.receiptNo).sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1));
  });

  it('a payment that rolls back sends no SMS and leaves no row', async () => {
    const id = s.students[1]!.id;
    const before = (await smsLogs()).length;
    const paymentsBefore = (await ledger(id)).payments.length;
    const due = (await ledger(id)).dues[0]!;
    await api(s.tokens.accountant)
      .post('/test/fees-collect-then-fail', {
        studentId: id,
        dueIds: [due.id],
        amountPaisa: 100,
        expectedOutstandingPaisa: due.balance.total,
        clientRequestId: randomUUID(),
      })
      .expect(400);
    expect((await smsLogs()).length).toBe(before);
    expect((await ledger(id)).payments.length).toBe(paymentsBefore);
  });

  it('void (OWNER/ADMIN, with a reason): the due owes again, the fine runs again, the receipt says VOID', async () => {
    const student = s.students[2]!;
    const view = await ledger(student.id);
    const paidDue = view.dues[0]!; // paid in full in the first test
    const receiptId = view.payments.find(
      (p) => p.status === 'ACTIVE' && p.amountPaisa === 110000,
    )!.id;

    await api(s.tokens.accountant)
      .post(`/fees/payments/${receiptId}/void`, { reason: 'ভুল ছাত্র' })
      .expect(403);
    await api(s.tokens.admin).post(`/fees/payments/${receiptId}/void`, {}).expect(400);
    const voided = (
      await api(s.tokens.admin)
        .post(`/fees/payments/${receiptId}/void`, { reason: 'ভুল ছাত্রের নামে' })
        .expect(200)
    ).body as FeeReceipt;
    expect(voided).toMatchObject({ status: 'VOID', void: { reason: 'ভুল ছাত্রের নামে' } });
    expect(voided.void?.by.id).toBe(s.userIds.admin);
    await api(s.tokens.admin)
      .post(`/fees/payments/${receiptId}/void`, { reason: 'আবার' })
      .expect(409);

    const due = (await ledger(student.id)).dues.find((d) => d.id === paidDue.id)!;
    expect(due).toMatchObject({
      paidPrincipalPaisa: 0,
      paidFinePaisa: 0,
      principalClearedOn: null,
    });
    expect(due.balance).toEqual({ principal: 100000, fine: 10000, total: 110000 });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'fee_payment', entityId: receiptId } }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['CREATE', 'UPDATE']);
  });

  it('a held receipt SMS is cancelled when its payment is voided before it goes out', async () => {
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.attendanceSettings.update({ where: { tenantId: s.tenantId }, data: { dailySmsCap: 0 } }),
    );
    const student = s.students[2]!;
    const receipt = (await collect(student.id, { amount: 500 })).body as FeeReceipt;
    let log = (await smsLogs()).find((l) => l.relatedId === receipt.id)!;
    expect(log.status).toBe('HELD_OVER_LIMIT');
    await api(s.tokens.admin)
      .post(`/fees/payments/${receipt.id}/void`, { reason: 'ভুল টাকা লেখা হয়েছিল' })
      .expect(200);
    await api(s.tokens.admin).post('/attendance/sms/held/send').expect(200);
    log = (await smsLogs()).find((l) => l.relatedId === receipt.id)!;
    expect(log.status).toBe('CANCELLED');
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: s.tenantId },
        data: { dailySmsCap: null },
      }),
    );
  });

  it('daily closing: per collector and method, voids listed apart; accountants see their own', async () => {
    const mine = (await api(s.tokens.accountant).get('/fees/closing').expect(200))
      .body as FeeClosing;
    expect(mine.date).toBe(s.today);
    expect(mine.collectors).toHaveLength(1);
    const c = mine.collectors[0]!;
    expect(c.collector.id).toBe(s.userIds.accountant);
    const active = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.aggregate({
        where: { collectedById: s.userIds.accountant, status: 'ACTIVE' },
        _sum: { amountPaisa: true },
        _count: true,
      }),
    );
    expect(c.total).toEqual({ count: active._count, amountPaisa: active._sum.amountPaisa });
    expect(c.byMethod).toEqual([
      { method: 'CASH', count: active._count, amountPaisa: active._sum.amountPaisa },
    ]);
    expect(c.voided).toHaveLength(2);
    expect(c.receipts?.first).toBe(`${s.today.slice(0, 4)}-000001`);

    await api(s.tokens.accountant).get(`/fees/closing?collectorId=${s.userIds.admin}`).expect(403);
    const all = (await api(s.tokens.admin).get('/fees/closing').expect(200)).body as FeeClosing;
    expect(all.total).toEqual(mine.total);
  });
});
