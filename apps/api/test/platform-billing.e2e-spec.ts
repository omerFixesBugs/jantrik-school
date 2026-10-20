import { withTenant } from '@jantrik/db';
import type {
  BillingNotice,
  PlatformGenerateResult,
  PlatformInstituteDetail,
  PlatformInstitutePage,
  PlatformInvoiceDetail,
  PlatformInvoicePage,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createStudent,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { ownerClient, platform, platformAdminCookie } from './support/platform.js';

// Step 8, part 3: plans, activation, a month's invoices, payments, void, and the owner's
// overdue notice. See docs/platform.md.

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** YYYY-MM, `delta` months from now. */
const month = (delta: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1))
    .toISOString()
    .slice(0, 7);
};
const plan = (over: Record<string, unknown> = {}) => ({
  planName: 'Standard',
  pricing: 'PER_STUDENT',
  corePaisa: 1000,
  attendancePaisa: 500,
  cycle: 'MONTHLY',
  dueDays: 10,
  trialEndsOn: null,
  billingStartsOn: `${month(-12)}-01`,
  ...over,
});

describe('platform: billing', () => {
  let h: Harness;
  let cookie: string;
  const p = () => platform(h, cookie);

  /** An ACTIVE institute with `students` active students, an OWNER and an ADMIN. */
  const institute = async (students = 2, status: 'ACTIVE' | 'TRIAL' = 'ACTIVE') => {
    const t = await createTenant(h, { status, modules: ['ATTENDANCE'] });
    for (let i = 0; i < students; i++) await createStudent(h, t.id, `S-${i}`);
    const owner = (await otpLogin(h, (await addMember(h, t.id, { roles: ['OWNER'] })).phone))
      .accessToken;
    const admin = (await otpLogin(h, (await addMember(h, t.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    return { id: t.id, owner, admin };
  };
  const invoices = async (tenantId: string) =>
    (
      (await p().get(`/platform/invoices?tenantId=${tenantId}`).expect(200))
        .body as PlatformInvoicePage
    ).items;
  const generate = async (m: string, issuedOn: string | null = null) =>
    (await p().post('/platform/invoices/generate').send({ month: m, issuedOn }).expect(200))
      .body as PlatformGenerateResult;

  beforeAll(async () => {
    h = await createHarness();
    cookie = await platformAdminCookie(h);
  });

  afterAll(async () => {
    await h.close();
  });

  it('platform session only: an institute token gets 401', async () => {
    const t = await institute(0);
    await platform(h).get('/platform/invoices').set(bearer(t.owner)).expect(401);
    await platform(h)
      .post('/platform/invoices/generate')
      .send({ month: month(0) })
      .expect(401);
  });

  it('plan editing and activation (TRIAL → ACTIVE, billing from next month), audited', async () => {
    const t = await institute(0, 'TRIAL');
    const set = (
      await p()
        .put(`/platform/institutes/${t.id}/plan`)
        .send(plan({ billingStartsOn: null }))
        .expect(200)
    ).body as PlatformInstituteDetail;
    expect(set.subscription).toMatchObject({
      planName: 'Standard',
      corePaisa: 1000,
      billingStartsOn: null,
    });
    await p()
      .put(`/platform/institutes/${t.id}/plan`)
      .send(plan({ billingStartsOn: '2026-10-15' }))
      .expect(400); // the first day of a month only
    const active = (
      await p()
        .post(`/platform/institutes/${t.id}/activate`)
        .send({ reason: 'trial over' })
        .expect(200)
    ).body as PlatformInstituteDetail;
    expect(active).toMatchObject({
      status: 'ACTIVE',
      subscription: { billingStartsOn: `${month(1)}-01` },
    });
    await p().post(`/platform/institutes/${t.id}/activate`).send({ reason: 'again' }).expect(409);
    const owner = ownerClient();
    try {
      const actions = (
        await owner.platformAuditLog.findMany({
          where: { targetTenantId: t.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((l) => l.action);
      expect(actions).toEqual(['INSTITUTE_PLAN', 'INSTITUTE_ACTIVATE']);
    } finally {
      await owner.$disconnect();
    }
  });

  it('a month’s invoices, a partial and then a full payment, void', async () => {
    const t = await institute(3);
    await p().put(`/platform/institutes/${t.id}/plan`).send(plan()).expect(200);
    const m = month(-2);
    await generate(m);
    expect((await generate(m)).skipped.exists).toBeGreaterThanOrEqual(1);
    const [listed] = await invoices(t.id);
    expect(listed).toMatchObject({
      periodStart: `${m}-01`,
      status: 'ISSUED',
      totalPaisa: 3 * 1500,
      paidPaisa: 0,
      overdue: false,
    });
    const detail = (await p().get(`/platform/invoices/${listed!.id}`).expect(200))
      .body as PlatformInvoiceDetail;
    expect(detail.lines.map((l) => [l.kind, l.activeStudents, l.amountPaisa])).toEqual([
      ['CORE', 3, 3000],
      ['ATTENDANCE', 3, 1500],
    ]);

    const pay = (body: Record<string, unknown>) =>
      p()
        .post(`/platform/invoices/${listed!.id}/payments`)
        .send({
          method: 'BKASH',
          paidOn: iso(new Date()),
          ...body,
        });
    expect((await pay({ amountPaisa: 4501 }).expect(422)).body).toMatchObject({
      code: 'BAD_AMOUNT',
    });
    await pay({ amountPaisa: 100, method: 'CHEQUE' }).expect(400);
    const future = iso(new Date(Date.now() + 3 * 86_400_000));
    expect((await pay({ amountPaisa: 100, paidOn: future }).expect(422)).body).toMatchObject({
      code: 'BAD_DATE',
    });
    const part = (await pay({ amountPaisa: 2000, reference: 'TRX-9' }).expect(200))
      .body as PlatformInvoiceDetail;
    expect(part).toMatchObject({ status: 'ISSUED', paidPaisa: 2000 });
    expect(part.payments).toEqual([
      expect.objectContaining({
        amountPaisa: 2000,
        method: 'BKASH',
        reference: 'TRX-9',
        recordedBy: 'Test Platform Admin',
      }),
    ]);
    await p().post(`/platform/invoices/${listed!.id}/void`).send({ reason: 'mistake' }).expect(409);
    const full = (await pay({ amountPaisa: 2500, method: 'CASH' }).expect(200))
      .body as PlatformInvoiceDetail;
    expect(full).toMatchObject({ status: 'PAID', paidPaisa: 4500 });

    // Another month, voided while unpaid; that month can then be invoiced again.
    await generate(month(-1));
    const unpaid = (await invoices(t.id)).find((i) => i.periodStart === `${month(-1)}-01`)!;
    const voided = (
      await p()
        .post(`/platform/invoices/${unpaid.id}/void`)
        .send({ reason: 'wrong price' })
        .expect(200)
    ).body as PlatformInvoiceDetail;
    expect(voided).toMatchObject({ status: 'VOID', voidReason: 'wrong price' });
    await generate(month(-1));
    expect(
      (await invoices(t.id))
        .filter((i) => i.periodStart === `${month(-1)}-01`)
        .map((i) => i.status)
        .sort(),
    ).toEqual(['ISSUED', 'VOID']);
    const own = await withTenant(h.prisma, t.id, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'platform_invoice' } }),
    );
    expect(own.length).toBeGreaterThanOrEqual(5); // 3 issued, 2 payments, 1 void
    expect(own.every((l) => l.actorUserId === null)).toBe(true);
  });

  it('overdue: the owner (only) gets the notice; the institute list filters on it', async () => {
    const t = await institute(1);
    const notice = () => http(h).get('/me/billing-notice').set(bearer(t.owner));
    expect((await notice().expect(200)).body).toEqual({ overdue: null });
    await p().put(`/platform/institutes/${t.id}/plan`).send(plan()).expect(200);
    await generate(month(-3), iso(new Date(Date.now() - 30 * 86_400_000)));
    const [inv] = await invoices(t.id);
    expect(inv).toMatchObject({ overdue: true });
    const body = (await notice().expect(200)).body as BillingNotice;
    expect(body).toEqual({ overdue: { count: 1, duePaisa: 1500, oldestDueOn: inv!.dueOn } });
    await http(h).get('/me/billing-notice').set(bearer(t.admin)).expect(403);

    const overdueList = (
      await p().get('/platform/institutes?overdue=true&pageSize=100').expect(200)
    ).body as PlatformInstitutePage;
    expect(overdueList.items.find((i) => i.id === t.id)).toMatchObject({
      overdueCount: 1,
      overduePaisa: 1500,
    });
    const d = (await p().get(`/platform/institutes/${t.id}`).expect(200))
      .body as PlatformInstituteDetail;
    expect(d.billing).toMatchObject({ overdueCount: 1, overduePaisa: 1500, openCount: 1 });

    // Paid: no more notice.
    await p()
      .post(`/platform/invoices/${inv!.id}/payments`)
      .send({ amountPaisa: 1500, method: 'BANK', paidOn: iso(new Date()) })
      .expect(200);
    expect((await notice().expect(200)).body).toEqual({ overdue: null });
  });

  it('skips trial and suspended institutes; never bills a module that is off', async () => {
    const trial = await institute(1, 'TRIAL');
    await p().put(`/platform/institutes/${trial.id}/plan`).send(plan()).expect(200);
    const off = await institute(2);
    await p()
      .put(`/platform/institutes/${off.id}/plan`)
      .send(plan({ feesPaisa: 900 }))
      .expect(200);
    await p()
      .put(`/platform/institutes/${off.id}/modules/ATTENDANCE`)
      .send({ enabled: false })
      .expect(200);
    const res = await generate(month(-4));
    expect(res.skipped.trial).toBeGreaterThanOrEqual(1);
    expect(await invoices(trial.id)).toEqual([]);
    const [inv] = await invoices(off.id);
    expect(inv!.totalPaisa).toBe(2 * 1000); // CORE only: ATTENDANCE switched off, FEES never on
  });
});
