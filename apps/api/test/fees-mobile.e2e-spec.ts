import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  FeeGuardianView,
  FeeHeadView,
  FeeMobileAccountView,
  FeeReceipt,
  FeeSubmissionView,
} from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';

/** Manual bKash/Nagad (step 9, phase D): the institute's numbers, TrxID submissions, review. */
describe('manual bKash/Nagad payments', () => {
  let h: Harness;
  let s: FeesSchool;
  let bkash: FeeMobileAccountView;
  let nagad: FeeMobileAccountView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
    patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
  });
  const childView = async (studentId: string, token = s.tokens.guardian) =>
    (await api(token).get(`/me/children/${studentId}/fees`).expect(200)).body as FeeGuardianView;
  /** A guardian's submission for a child's first open due (or `amount` of it). */
  const submit = async (
    studentId: string,
    opts: {
      trxId?: string;
      method?: 'BKASH' | 'NAGAD';
      amount?: number;
      token?: string;
      expect?: number;
    } = {},
  ) => {
    const view = await childView(studentId, opts.token ?? s.tokens.guardian);
    const due = view.ledger.dues.find((d) => d.status === 'OPEN' && d.balance.total > 0)!;
    return api(opts.token ?? s.tokens.guardian)
      .post(`/me/children/${studentId}/fees/submissions`, {
        method: opts.method ?? 'BKASH',
        accountId: (opts.method ?? 'BKASH') === 'BKASH' ? bkash.id : nagad.id,
        amountPaisa: opts.amount ?? due.balance.total,
        trxId: opts.trxId ?? `T${randomUUID().slice(0, 9).replace('-', '').toUpperCase()}`,
        senderPhone: '০১৮১১২২২৩৩৩',
        dueIds: [due.id],
        clientRequestId: randomUUID(),
      })
      .expect(opts.expect ?? 201);
  };
  const pending = async (token = s.tokens.accountant) =>
    (await api(token).get('/fees/submissions?status=PENDING').expect(200))
      .body as FeeSubmissionView[];

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    const admin = api(s.tokens.admin);
    const tuition = (
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
        amounts: [{ feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 100000 }],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${s.months.previous}-01`,
        receiptSmsEnabled: true,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
  });

  afterAll(() => h.close());

  it("the institute's numbers: OWNER adds and (de)activates; others read", async () => {
    await api(s.tokens.admin)
      .post('/fees/mobile-accounts', { method: 'BKASH', phone: '01711000901', kind: 'PERSONAL' })
      .expect(403);
    bkash = (
      await api(s.tokens.owner)
        .post('/fees/mobile-accounts', {
          method: 'BKASH',
          phone: '০১৭১১০০০৯০১',
          kind: 'PERSONAL',
          label: 'অফিস',
        })
        .expect(201)
    ).body as FeeMobileAccountView;
    expect(bkash).toMatchObject({ phone: '+8801711000901', isActive: true });
    nagad = (
      await api(s.tokens.owner)
        .post('/fees/mobile-accounts', { method: 'NAGAD', phone: '01711000902', kind: 'MERCHANT' })
        .expect(201)
    ).body as FeeMobileAccountView;
    const old = (
      await api(s.tokens.owner)
        .post('/fees/mobile-accounts', { method: 'BKASH', phone: '01711000903', kind: 'AGENT' })
        .expect(201)
    ).body as FeeMobileAccountView;
    await api(s.tokens.admin)
      .patch(`/fees/mobile-accounts/${old.id}`, { isActive: false })
      .expect(403);
    await api(s.tokens.owner)
      .patch(`/fees/mobile-accounts/${old.id}`, { isActive: false })
      .expect(200);
    // A change that does not name the label keeps it.
    const reordered = (
      await api(s.tokens.owner).patch(`/fees/mobile-accounts/${bkash.id}`, { sortOrder: 1 }).expect(200)
    ).body as FeeMobileAccountView;
    expect(reordered).toMatchObject({ label: 'অফিস', sortOrder: 1 });
    const list = (await api(s.tokens.accountant).get('/fees/mobile-accounts').expect(200))
      .body as FeeMobileAccountView[];
    expect(list).toHaveLength(3);
    const audits = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.count({ where: { entity: 'fee_mobile_account' } }),
    );
    expect(audits).toBe(5); // 3 added, 1 deactivated, 1 reordered
    // Guardians see only active numbers.
    const view = await childView(s.students[0]!.id);
    expect(view.accounts.map((a) => a.id).sort()).toEqual([bkash.id, nagad.id].sort());
  });

  it("a guardian sees their own child's fees only; staff use the counter instead", async () => {
    const view = await childView(s.students[0]!.id);
    expect(view.ledger.dues.map((d) => d.periodKey)).toEqual([s.months.previous, s.months.current]);
    await api(s.tokens.guardian).get(`/me/children/${s.students[2]!.id}/fees`).expect(404);
    await api(s.tokens.otherGuardian).get(`/me/children/${s.students[0]!.id}/fees`).expect(404);
    await api(s.tokens.accountant).get(`/me/children/${s.students[0]!.id}/fees`).expect(403);
    await api(s.tokens.guardian).get('/fees/submissions').expect(403);
    await api(s.tokens.teacher).get('/fees/submissions').expect(403);
  });

  it('submit a TrxID (typed loosely); a duplicate per method is refused', async () => {
    const res = await submit(s.students[0]!.id, { trxId: ' bfh7 kj2l-9q ' });
    const sub = res.body as FeeSubmissionView;
    expect(sub).toMatchObject({
      status: 'PENDING',
      trxId: 'BFH7KJ2L9Q',
      submitter: 'GUARDIAN',
      sentOn: s.today,
    });
    const dup = await submit(s.students[1]!.id, { trxId: 'BFH7KJ2L9Q', expect: 409 });
    expect(dup.body.code).toBe('TRX_ID_USED');
    await submit(s.students[1]!.id, { trxId: 'BFH7KJ2L9Q', method: 'NAGAD', amount: 100 });
    // Not this guardian's child (its due, as its own guardian sees it).
    const theirs = (await childView(s.students[2]!.id, s.tokens.otherGuardian)).ledger.dues[0]!;
    await api(s.tokens.guardian)
      .post(`/me/children/${s.students[2]!.id}/fees/submissions`, {
        method: 'BKASH',
        accountId: bkash.id,
        amountPaisa: 100,
        trxId: 'OTHERCHILD1',
        senderPhone: '01811222333',
        dueIds: [theirs.id],
        clientRequestId: randomUUID(),
      })
      .expect(404);
  });

  it('the accountant verifies: a payment and receipt dated when it was sent; the guardian sees it', async () => {
    const sub = (await pending()).find((p) => p.trxId === 'BFH7KJ2L9Q' && p.method === 'BKASH')!;
    expect(sub.senderPhone).toMatch(/^01\d•+\d{3}$/); // masked for the accountant
    const asAdmin = (await pending(s.tokens.admin)).find((p) => p.id === sub.id)!;
    expect(asAdmin.senderPhone).toBe('+8801811222333');

    const receipt = (
      await api(s.tokens.accountant)
        .post(`/fees/submissions/${sub.id}/verify`, { clientRequestId: randomUUID() })
        .expect(200)
    ).body as FeeReceipt;
    expect(receipt).toMatchObject({
      method: 'BKASH',
      channel: 'MOBILE_MANUAL',
      trxId: 'BFH7KJ2L9Q',
      paidOn: sub.sentOn,
      amountPaisa: sub.amountPaisa,
    });
    const view = await childView(s.students[0]!.id);
    const mine = view.submissions.find((x) => x.id === sub.id)!;
    expect(mine).toMatchObject({ status: 'VERIFIED', receipt: { id: receipt.id } });
    expect(view.ledger.dues[0]!.balance.total).toBe(0);
    const forGuardian = (
      await api(s.tokens.guardian)
        .get(`/me/children/${s.students[0]!.id}/fees/payments/${receipt.id}`)
        .expect(200)
    ).body as FeeReceipt;
    expect(forGuardian.receiptNumber).toBe(receipt.receiptNumber);
    await api(s.tokens.otherGuardian)
      .get(`/me/children/${s.students[0]!.id}/fees/payments/${receipt.id}`)
      .expect(404);
    await api(s.tokens.guardian)
      .get(`/me/children/${s.students[1]!.id}/fees/payments/${receipt.id}`)
      .expect(404); // another child's receipt through this child

    // A verified TrxID cannot be submitted again.
    expect((await submit(s.students[1]!.id, { trxId: 'BFH7KJ2L9Q', expect: 409 })).body.code).toBe(
      'TRX_ID_USED',
    );
    await vi.waitFor(
      () => expect(h.sms.sentTo(s.students[0]!.phone).join(' ')).toContain(receipt.receiptNumber),
      {
        timeout: 5000,
      },
    );
  });

  it('two people verifying at once make one payment', async () => {
    const sub = (await submit(s.students[1]!.id)).body as FeeSubmissionView;
    const results = await Promise.all([
      api(s.tokens.accountant).post(`/fees/submissions/${sub.id}/verify`, {
        clientRequestId: randomUUID(),
      }),
      api(s.tokens.admin).post(`/fees/submissions/${sub.id}/verify`, {
        clientRequestId: randomUUID(),
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const payments = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feePayment.count({ where: { trxId: sub.trxId, method: 'BKASH' } }),
    );
    expect(payments).toBe(1);
  });

  it('reject with a reason; the TrxID may be sent again', async () => {
    const sub = (
      await submit(s.students[2]!.id, {
        trxId: 'WRONGAMT01',
        token: s.tokens.otherGuardian,
        amount: 100,
      })
    ).body as FeeSubmissionView;
    await api(s.tokens.accountant).post(`/fees/submissions/${sub.id}/reject`, {}).expect(400);
    await api(s.tokens.accountant)
      .post(`/fees/submissions/${sub.id}/reject`, { reason: 'এই TrxID-তে টাকা আসেনি' })
      .expect(200);
    await api(s.tokens.accountant)
      .post(`/fees/submissions/${sub.id}/verify`, { clientRequestId: randomUUID() })
      .expect(409);
    const view = await childView(s.students[2]!.id, s.tokens.otherGuardian);
    expect(view.submissions.find((x) => x.id === sub.id)).toMatchObject({
      status: 'REJECTED',
      rejectReason: 'এই TrxID-তে টাকা আসেনি',
    });
    await submit(s.students[2]!.id, {
      trxId: 'WRONGAMT01',
      token: s.tokens.otherGuardian,
      amount: 100,
    });
  });

  it('voiding a verified payment frees its TrxID', async () => {
    const sub = (await submit(s.students[0]!.id, { trxId: 'VOIDME0001', amount: 100 }))
      .body as FeeSubmissionView;
    const receipt = (
      await api(s.tokens.accountant)
        .post(`/fees/submissions/${sub.id}/verify`, { clientRequestId: randomUUID() })
        .expect(200)
    ).body as FeeReceipt;
    await api(s.tokens.admin)
      .post(`/fees/payments/${receipt.id}/void`, { reason: 'ভুল ছাত্রের নামে' })
      .expect(200);
    const view = await childView(s.students[0]!.id);
    expect(view.submissions.find((x) => x.id === sub.id)?.status).toBe('VOIDED');
    await submit(s.students[0]!.id, { trxId: 'VOIDME0001', amount: 100 });
  });

  it('staff record a transfer for a student; a child has at most 5 waiting', async () => {
    const view = await childView(s.students[1]!.id);
    const due = view.ledger.dues.find((d) => d.balance.total > 0)!;
    const staff = (
      await api(s.tokens.accountant)
        .post('/fees/submissions', {
          studentId: s.students[1]!.id,
          method: 'NAGAD',
          accountId: nagad.id,
          amountPaisa: 100,
          trxId: 'STAFF00001',
          senderPhone: randomPhone(),
          dueIds: [due.id],
          clientRequestId: randomUUID(),
        })
        .expect(201)
    ).body as FeeSubmissionView;
    expect(staff.submitter).toBe('STAFF');
    // students[1] now has 2 pending (one NAGAD from the guardian earlier, this one): 3 more fit.
    for (let i = 0; i < 3; i++) await submit(s.students[1]!.id, { amount: 100 });
    const tooMany = await submit(s.students[1]!.id, { amount: 100, expect: 422 });
    expect(tooMany.body.code).toBe('TOO_MANY_PENDING');
  });
});
