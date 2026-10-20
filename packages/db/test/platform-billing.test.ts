import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  withPlatformSession,
  withTenant,
  type ModuleKey,
  type PrismaClient,
  type TenantTx,
} from '../src/index.js';
import {
  appClient,
  createStudent,
  createTenant,
  newPlatformSession,
  ownerClient,
  platformClient,
} from './helpers.js';

// Step 8, part 3: plans, monthly invoices, payments. Invoices are tenant rows the institute may
// only read; every write goes through a platform function and is audited. See docs/platform.md.

const DENIED = /permission denied/i;
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The first day of the month `delta` months from now (UTC is fine for these dates). */
const month = (delta: number) => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)));
};

interface Plan {
  pricing?: 'PER_STUDENT' | 'FLAT';
  core?: number;
  attendance?: number;
  fees?: number;
  flat?: number;
  cycle?: 'MONTHLY' | 'YEARLY';
  discount?: number;
  dueDays?: number;
  billingStartsOn?: string | null;
  planName?: string | null;
}

describe('platform billing', () => {
  let app: PrismaClient;
  let platform: PrismaClient;
  let owner: PrismaClient;
  let session: { adminId: string; tokenHash: string };

  const asPlatform = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withPlatformSession(platform, session.tokenHash, fn);
  const setPlan = (tenantId: string, p: Plan = {}) =>
    asPlatform(
      (tx) => tx.$executeRaw`SELECT platform_set_plan(${tenantId}::uuid,
        ${p.planName === undefined ? 'Standard' : p.planName}, ${p.pricing ?? 'PER_STUDENT'},
        ${p.core ?? 1000}::int, ${p.attendance ?? 500}::int, ${p.fees ?? 700}::int, 0,
        ${p.flat ?? 0}::int, ${p.cycle ?? 'MONTHLY'}, ${p.discount ?? 0}::int,
        ${p.dueDays ?? 10}::int, NULL,
        ${p.billingStartsOn === undefined ? month(-12) : p.billingStartsOn}::date, '127.0.0.1')`,
    );
  const generate = (m: string, issuedOn: string | null = null) =>
    asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<
        { v: { created: number; skipped: Record<string, number> } }[]
      >`
        SELECT platform_generate_invoices(${m}::date, ${issuedOn}::date, '127.0.0.1') AS v`;
      return row!.v;
    });
  /** The institute's own view of its invoices (as jantrik_app, RLS). */
  const invoicesOf = (tenantId: string) =>
    withTenant(app, tenantId, (tx) =>
      tx.platformInvoice.findMany({
        include: { lines: { orderBy: { sortOrder: 'asc' } }, payments: true },
        orderBy: { periodStart: 'asc' },
      }),
    );
  const school = async (
    opts: {
      status?: 'ACTIVE' | 'TRIAL' | 'SUSPENDED';
      modules?: ModuleKey[];
      students?: number;
    } = {},
  ) => {
    const t = await createTenant(app, { status: opts.status ?? 'ACTIVE', modules: opts.modules });
    for (let i = 0; i < (opts.students ?? 0); i++) await createStudent(app, t.id, `S-${i}`);
    return t;
  };
  const pay = (invoiceId: string, amount: number, paidOn = iso(new Date())) =>
    asPlatform(
      (tx) => tx.$executeRaw`SELECT platform_record_payment(${invoiceId}::uuid, ${amount}::int,
        'BKASH', 'TRX-1', ${paidOn}::date, NULL)`,
    );

  beforeAll(async () => {
    app = appClient();
    platform = platformClient();
    owner = ownerClient();
    session = await newPlatformSession(owner);
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), platform.$disconnect(), owner.$disconnect()]);
  });

  it('every billing function refuses without a platform session', async () => {
    const id = randomUUID();
    for (const sql of [
      `SELECT platform_set_plan('${id}', 'x', 'FLAT', 0, 0, 0, 0, 0, 'MONTHLY', 0, 10, NULL, NULL, NULL)`,
      `SELECT platform_generate_invoices('2026-01-01', NULL, NULL)`,
      `SELECT platform_record_payment('${id}', 1, 'CASH', NULL, '2026-01-01', NULL)`,
      `SELECT platform_void_invoice('${id}', 'reason', NULL)`,
      `SELECT * FROM platform_list_invoices(NULL, NULL, NULL, NULL, 0, 10)`,
      `SELECT platform_get_invoice('${id}')`,
    ]) {
      await expect(platform.$queryRawUnsafe(sql)).rejects.toThrow(/platform session required/);
    }
  });

  it('per student × enabled modules (CORE always), one invoice per period, audited', async () => {
    const t = await school({ modules: ['ATTENDANCE'], students: 3 });
    await setPlan(t.id); // CORE 10, ATTENDANCE 5, FEES 7 (FEES off: not billed)
    const m = month(-2);
    await generate(m);
    const again = await generate(m); // idempotent
    expect(again.skipped['exists']).toBeGreaterThanOrEqual(1);
    const [inv] = await invoicesOf(t.id);
    expect(await invoicesOf(t.id)).toHaveLength(1);
    expect(inv).toMatchObject({
      status: 'ISSUED',
      cycle: 'MONTHLY',
      totalPaisa: 3 * 1000 + 3 * 500,
      paidPaisa: 0,
    });
    expect(iso(inv!.periodStart)).toBe(m);
    expect(
      inv!.lines.map((l) => [l.kind, l.activeStudents, l.unitPaisa, l.months, l.amountPaisa]),
    ).toEqual([
      ['CORE', 3, 1000, 1, 3000],
      ['ATTENDANCE', 3, 500, 1, 1500],
    ]);
    expect(iso(inv!.dueOn)).toBe(iso(new Date(inv!.issuedOn.getTime() + 10 * 86_400_000)));
    const logs = await owner.platformAuditLog.findMany({
      where: { targetTenantId: t.id, action: 'INVOICE_ISSUE' },
    });
    expect(logs).toHaveLength(1);
    const own = await withTenant(app, t.id, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'platform_invoice' } }),
    );
    expect(own).toEqual([expect.objectContaining({ action: 'CREATE', actorUserId: null })]);
  });

  it('flat price; yearly = 12 months minus the discount, then from the end of the last one', async () => {
    const flat = await school({ students: 2 });
    await setPlan(flat.id, { pricing: 'FLAT', flat: 250_000 });
    const yearly = await school({ students: 4 });
    await setPlan(yearly.id, { cycle: 'YEARLY', discount: 10, billingStartsOn: month(-14) });

    await generate(month(-14)); // the start: 12 months, month(-14) … month(-3)
    await generate(month(-13)); // yearly: covered
    await generate(month(-3)); // flat: due; yearly: covered
    await generate(month(-2)); // yearly: the next year
    const [f] = await invoicesOf(flat.id);
    expect(f!.lines.map((l) => [l.kind, l.amountPaisa])).toEqual([['FLAT', 250_000]]);
    const y = await invoicesOf(yearly.id);
    expect(y.map((i) => iso(i.periodStart))).toEqual([month(-14), month(-2)]);
    // 4 students × (CORE 10) × 12 months = 480; minus 10% = 432.
    expect(y[1]!.lines.map((l) => [l.kind, l.months, l.amountPaisa])).toEqual([
      ['CORE', 12, 4 * 1000 * 12],
      ['DISCOUNT', 12, -4800],
    ]);
    expect(y[1]!.totalPaisa).toBe(43_200);
    expect(iso(y[1]!.periodEnd)).toBe(iso(new Date(Date.parse(month(10)) - 86_400_000)));
  });

  it('a change of cycle neither bills a month twice nor leaves a gap', async () => {
    // Yearly from month(-12): covers month(-12) … month(-1). Switched to monthly: nothing
    // until that year is over.
    const a = await school({ students: 1 });
    await setPlan(a.id, { cycle: 'YEARLY', billingStartsOn: month(-12) });
    await generate(month(-12));
    await setPlan(a.id, { cycle: 'MONTHLY', billingStartsOn: month(-12) });
    const covered = await generate(month(-8));
    expect(covered.skipped['exists']).toBeGreaterThanOrEqual(1);
    expect((await invoicesOf(a.id)).map((i) => [iso(i.periodStart), i.cycle])).toEqual([
      [month(-12), 'YEARLY'],
    ]);
    // Monthly until month(-10), then yearly: the year starts right after (month(-9)).
    const b = await school({ students: 1 });
    await setPlan(b.id, { billingStartsOn: month(-11) });
    await generate(month(-11));
    await generate(month(-10));
    await setPlan(b.id, { cycle: 'YEARLY', billingStartsOn: month(-11) });
    await generate(month(-9));
    expect((await invoicesOf(b.id)).map((i) => [iso(i.periodStart), i.cycle])).toEqual([
      [month(-11), 'MONTHLY'],
      [month(-10), 'MONTHLY'],
      [month(-9), 'YEARLY'],
    ]);
  });

  it('a skipped month only moves the year; a backdated year never overlaps invoiced months', async () => {
    // No students in the first month: nothing to pay; the year starts with the next month.
    const fresh = await school();
    await setPlan(fresh.id, { cycle: 'YEARLY', billingStartsOn: month(-11) });
    expect((await generate(month(-11))).skipped['free']).toBeGreaterThanOrEqual(1);
    await createStudent(app, fresh.id, 'LATE-1');
    await generate(month(-10));
    expect((await invoicesOf(fresh.id)).map((i) => [iso(i.periodStart), iso(i.periodEnd)])).toEqual(
      [[month(-10), iso(new Date(Date.parse(month(2)) - 86_400_000))]],
    );
    // Monthly for months -8 … -6, then yearly from -9: a year from -9 would overlap them.
    const b = await school({ students: 1 });
    await setPlan(b.id, { billingStartsOn: month(-8) });
    for (const m of [-8, -7, -6]) await generate(month(m));
    await setPlan(b.id, { cycle: 'YEARLY', billingStartsOn: month(-9) });
    await generate(month(-9));
    await generate(month(-5));
    expect((await invoicesOf(b.id)).map((i) => [iso(i.periodStart), i.cycle])).toEqual([
      [month(-8), 'MONTHLY'],
      [month(-7), 'MONTHLY'],
      [month(-6), 'MONTHLY'],
      [month(-5), 'YEARLY'],
    ]);
  });

  it('refuses months after next; a mispriced institute is skipped, not the whole run', async () => {
    await expect(generate(month(2))).rejects.toThrow(/PLATFORM_BAD_MONTH/);
    // The highest price (৳10 lakh) × 2 students × 12 months is past what an invoice can hold.
    const big = await school({ students: 2 });
    await setPlan(big.id, { core: 100_000_000, cycle: 'YEARLY', billingStartsOn: month(-9) });
    const fine = await school({ students: 1 });
    await setPlan(fine.id);
    const res = await generate(month(-9));
    expect(res.skipped['tooLarge']).toBeGreaterThanOrEqual(1);
    expect(await invoicesOf(big.id)).toEqual([]);
    expect(await invoicesOf(fine.id)).toHaveLength(1);
  });

  it('skips institutes in trial, suspended, without a plan, not started yet, or free', async () => {
    const trial = await school({ status: 'TRIAL', students: 1 });
    const suspended = await school({ status: 'SUSPENDED', students: 1 });
    const noPlan = await school({ students: 1 });
    await setPlan(noPlan.id, { planName: null });
    const later = await school({ students: 1 });
    await setPlan(later.id, { billingStartsOn: month(1) });
    const free = await school({ students: 1 });
    await setPlan(free.id, { core: 0, attendance: 0 });
    for (const t of [trial, suspended]) await setPlan(t.id);
    const res = await generate(month(-1));
    for (const reason of ['trial', 'suspended', 'noPlan', 'notStarted', 'free']) {
      expect(res.skipped[reason], reason).toBeGreaterThanOrEqual(1);
    }
    for (const t of [trial, suspended, noPlan, later, free]) {
      expect(await invoicesOf(t.id)).toEqual([]);
    }
  });

  it('payments: partial, then the rest marks it PAID; never more than is left', async () => {
    const t = await school({ students: 2 });
    await setPlan(t.id); // 2 × 10 = 20 taka
    await generate(month(-4));
    const [inv] = await invoicesOf(t.id);
    await expect(pay(inv!.id, 2001)).rejects.toThrow(/PLATFORM_BAD_AMOUNT/);
    const tomorrow = iso(new Date(Date.now() + 2 * 86_400_000));
    await expect(pay(inv!.id, 500, tomorrow)).rejects.toThrow(/PLATFORM_BAD_DATE/);
    await pay(inv!.id, 500);
    expect((await invoicesOf(t.id))[0]).toMatchObject({ status: 'ISSUED', paidPaisa: 500 });
    await pay(inv!.id, 1500);
    const [paid] = await invoicesOf(t.id);
    expect(paid).toMatchObject({ status: 'PAID', paidPaisa: 2000 });
    expect(paid!.payments.map((p) => [p.amountPaisa, p.method, p.recordedById])).toEqual([
      [500, 'BKASH', session.adminId],
      [1500, 'BKASH', session.adminId],
    ]);
    await expect(pay(inv!.id, 1)).rejects.toThrow(/PLATFORM_INVOICE_CLOSED/);
  });

  it('void: only without payments; the period can then be invoiced again', async () => {
    const t = await school({ students: 1 });
    await setPlan(t.id);
    await generate(month(-5));
    const [inv] = await invoicesOf(t.id);
    const voidIt = (id: string, reason = 'wrong plan') =>
      asPlatform(
        (tx) => tx.$executeRaw`SELECT platform_void_invoice(${id}::uuid, ${reason}, NULL)`,
      );
    await expect(voidIt(inv!.id, 'no')).rejects.toThrow(/PLATFORM_REASON_REQUIRED/);
    await voidIt(inv!.id);
    await generate(month(-5));
    const both = await invoicesOf(t.id);
    expect(both.map((i) => i.status).sort()).toEqual(['ISSUED', 'VOID']);
    const fresh = both.find((i) => i.status === 'ISSUED')!;
    await pay(fresh.id, 100);
    await expect(voidIt(fresh.id)).rejects.toThrow(/PLATFORM_INVOICE_HAS_PAYMENTS/);
  });

  it('overdue: issued, past its due date; in the invoice list, the institute list and detail', async () => {
    const t = await school({ students: 1 });
    await setPlan(t.id); // due in 10 days
    const issued = iso(new Date(Date.now() - 30 * 86_400_000));
    await generate(month(-6), issued);
    const rows = await asPlatform(
      (tx) => tx.$queryRaw<{ tenant_id: string; overdue: boolean; total: bigint }[]>`
        SELECT * FROM platform_list_invoices(${t.id}::uuid, NULL, true, NULL, 0, 10)`,
    );
    expect(rows.map((r) => [r.tenant_id, r.overdue])).toEqual([[t.id, true]]);
    const listed = await asPlatform(
      (tx) => tx.$queryRaw<{ id: string; overdue_count: bigint; overdue_paisa: bigint }[]>`
        SELECT * FROM platform_list_institutes(NULL, NULL, NULL, NULL, NULL, true, 0, 100)`,
    );
    expect(listed.find((r) => r.id === t.id)).toMatchObject({
      overdue_count: 1n,
      overdue_paisa: 1000n,
    });
    const [d] = await asPlatform(
      (tx) => tx.$queryRaw<{ v: { billing: Record<string, number> } }[]>`
        SELECT platform_get_institute(${t.id}::uuid) AS v`,
    );
    expect(d!.v.billing).toMatchObject({ overdueCount: 1, overduePaisa: 1000, openCount: 1 });
    await expect(generate(month(-6), iso(new Date(Date.now() + 3 * 86_400_000)))).rejects.toThrow(
      /PLATFORM_BAD_DATE/,
    );
  });

  it('activate: TRIAL → ACTIVE, billing starts next month; plan changes audited', async () => {
    const t = await school({ status: 'TRIAL' });
    await setPlan(t.id, { billingStartsOn: null });
    await asPlatform(
      (tx) => tx.$queryRaw`SELECT platform_set_institute_status(${t.id}::uuid, 'ACTIVATE',
        'trial over, paid', NULL)::text`,
    );
    const sub = await withTenant(app, t.id, (tx) => tx.tenantSubscription.findFirstOrThrow());
    expect(iso(sub.billingStartsOn!)).toBe(month(1));
    expect((await withTenant(app, t.id, (tx) => tx.tenant.findFirstOrThrow())).status).toBe(
      'ACTIVE',
    );
    const actions = (
      await owner.platformAuditLog.findMany({
        where: { targetTenantId: t.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((l) => l.action);
    expect(actions).toEqual(['INSTITUTE_PLAN', 'INSTITUTE_ACTIVATE']);
  });

  it('an institute reads only its own invoices and can write none of the billing tables', async () => {
    const a = await school({ students: 1 });
    const b = await school({ students: 1 });
    await setPlan(a.id);
    await setPlan(b.id);
    await generate(month(-7));
    const [inv] = await invoicesOf(a.id);
    expect(await invoicesOf(b.id)).toHaveLength(1);
    const seenByA = await withTenant(app, a.id, (tx) => tx.platformInvoice.findMany());
    expect(seenByA.map((i) => i.tenantId)).toEqual([a.id]);
    await expect(
      withTenant(app, a.id, (tx) =>
        tx.platformInvoice.update({ where: { id: inv!.id }, data: { status: 'PAID' } }),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      withTenant(app, a.id, (tx) => tx.$executeRaw`DELETE FROM platform_invoices`),
    ).rejects.toThrow(DENIED);
    await expect(
      withTenant(app, a.id, (tx) =>
        tx.platformPayment.create({
          data: {
            tenantId: a.id,
            invoiceId: inv!.id,
            amountPaisa: 1000,
            method: 'CASH',
            paidOn: new Date(),
            recordedById: session.adminId,
          },
        }),
      ),
    ).rejects.toThrow(DENIED);
  });
});
