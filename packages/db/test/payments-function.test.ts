import { randomUUID } from 'node:crypto';
import { newTranId } from '@jantrik/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import {
  appClient,
  createTenant,
  ingestClient,
  loginClient,
  platformClient,
  randomPhone,
} from './helpers.js';

// Sprint 1 P7a2 (decision P7a-B): the payer's return and the IPN reach the database only through
// payment_signal_record, owned by the NOLOGIN role jantrik_payments and run by jantrik_app with
// no request context (as the API's public routes do). It names the institute from the slug and the
// intent from our own tran_id in that institute only, and stores whitelisted fields (review
// focus 5 and 7).

const NOW = new Date('2026-11-27T06:00:00Z');

interface School {
  tenantId: string;
  slug: string;
  studentId: string;
  intentId: string;
  tranId: string;
}

async function school(app: PrismaClient, opts: { status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const t = await createTenant(app, opts.status ? { status: opts.status } : {});
  return withTenant(app, t.id, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const payer = await findOrCreateUser(tx, randomPhone(), 'Guardian');
    const account = await tx.paymentGatewayAccount.create({
      data: { tenantId: t.id, provider: 'SSLCOMMERZ' },
    });
    const head = await tx.feeHead.create({
      data: {
        tenantId: t.id,
        nameBn: 'বেতন',
        nameEn: 'Tuition',
        kind: 'TUITION',
        frequency: 'MONTHLY',
        dueDay: 10,
      },
    });
    const student = await tx.student.create({
      data: { tenantId: t.id, studentCode: `PS-${randomUUID().slice(0, 6)}`, nameEn: 'S' },
    });
    const due = await tx.feeDue.create({
      data: {
        tenantId: t.id,
        studentId: student.id,
        feeHeadId: head.id,
        academicYearId: year.id,
        periodKey: '2026-11',
        periodStart: new Date('2026-11-01'),
        dueDate: new Date('2026-11-10'),
        amountPaisa: 120000,
        fineType: 'NONE',
        fineAmountPaisa: 0,
      },
    });
    const tranId = newTranId();
    const intent = await tx.paymentIntent.create({
      data: {
        tenantId: t.id,
        accountId: account.id,
        studentId: student.id,
        payerUserId: payer,
        amountPaisa: 120000,
        pricedOn: new Date('2026-11-27'),
        tranId,
        clientRequestId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await tx.paymentIntentDue.create({
      data: {
        tenantId: t.id,
        intentId: intent.id,
        studentId: student.id,
        dueId: due.id,
        plannedPrincipalPaisa: 120000,
        plannedFinePaisa: 0,
      },
    });
    return { tenantId: t.id, slug: t.slug, studentId: student.id, intentId: intent.id, tranId };
  }) as Promise<School>;
}

interface Recorded {
  result: string;
  tenant_id: string | null;
  event_id: string | null;
  intent_id: string | null;
  student_id: string | null;
}

describe('payment_signal_record', () => {
  let app: PrismaClient;
  let a: School;
  let b: School;

  // As the API's public routes: jantrik_app, no institute, no person.
  const record = (args: {
    slug: string;
    kind: string;
    tranId: string | null;
    outcome?: string | null;
    valId?: string | null;
    fields?: unknown;
    sourceListed?: boolean;
  }) =>
    withContext(app, {}, async (tx) => {
      const [row] = await tx.$queryRaw<Recorded[]>`
        SELECT * FROM public.payment_signal_record(
          ${args.slug}, ${args.kind}, ${args.tranId}, ${args.outcome ?? null}, ${args.valId ?? null},
          ${JSON.stringify(args.fields ?? {})}::jsonb, ${args.sourceListed ?? false},
          ${NOW}::timestamptz)`;
      return row!;
    });
  const eventsOf = (s: School) =>
    withTenant(app, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({ orderBy: { receivedAt: 'asc' } }),
    );

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("an IPN for A's intent: recorded with A, the intent and the child; whitelisted fields only", async () => {
    const r = await record({
      slug: a.slug,
      kind: 'IPN',
      tranId: a.tranId,
      valId: 'VAL2311271200A',
      fields: { status: 'VALID', amount: '1200.00', currency: 'BDT', bank_tran_id: 'BTX12345678' },
      sourceListed: true,
    });
    expect(r).toMatchObject({
      result: 'RECORDED',
      tenant_id: a.tenantId,
      intent_id: a.intentId,
      student_id: a.studentId,
    });
    const [event] = (await eventsOf(a)).filter((e) => e.id === r.event_id);
    expect(event).toMatchObject({
      kind: 'IPN',
      intentId: a.intentId,
      tranId: a.tranId,
      valId: 'VAL2311271200A',
      outcome: null,
      sourceListed: true,
      reviewReason: null,
      fields: { status: 'VALID', amount: '1200.00', currency: 'BDT', bank_tran_id: 'BTX12345678' },
    });
    expect(event!.receivedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('a return: recorded with its path word; one for a tran_id never made: NO_INTENT, nothing stored', async () => {
    const r = await record({ slug: a.slug, kind: 'RETURN', tranId: a.tranId, outcome: 'SUCCESS' });
    expect(r).toMatchObject({ result: 'RECORDED', intent_id: a.intentId, student_id: a.studentId });
    const before = (await eventsOf(a)).length;
    const unknown = await record({
      slug: a.slug,
      kind: 'RETURN',
      tranId: newTranId(),
      outcome: 'SUCCESS',
    });
    expect(unknown).toEqual({
      result: 'NO_INTENT',
      tenant_id: null,
      event_id: null,
      intent_id: null,
      student_id: null,
    });
    expect(await eventsOf(a)).toHaveLength(before);
  });

  it("an IPN naming no intent is stored with none; B's tran_id at A's slug stays at A", async () => {
    const before = (await eventsOf(b)).length;
    const r = await record({ slug: a.slug, kind: 'IPN', tranId: b.tranId, valId: 'VALFROMB01' });
    expect(r).toMatchObject({ result: 'RECORDED', tenant_id: a.tenantId, intent_id: null });
    expect(r.student_id).toBeNull();
    const stored = (await eventsOf(a)).find((e) => e.id === r.event_id);
    expect(stored).toMatchObject({ intentId: null, tranId: b.tranId });
    // Nothing at B.
    expect(await eventsOf(b)).toHaveLength(before);
    // Another merchant's tran_id format is stored too (for the unmatched check).
    expect((await record({ slug: a.slug, kind: 'IPN', tranId: 'SSL-other.123_4' })).result).toBe(
      'RECORDED',
    );
  });

  it('an unknown slug: UNKNOWN, nothing stored; a suspended institute: recorded (P7a-O)', async () => {
    expect(
      await record({ slug: `nope-${randomUUID().slice(0, 6)}`, kind: 'IPN', tranId: a.tranId }),
    ).toEqual({
      result: 'UNKNOWN',
      tenant_id: null,
      event_id: null,
      intent_id: null,
      student_id: null,
    });
    const suspended = await school(app, { status: 'SUSPENDED' });
    const r = await record({
      slug: suspended.slug,
      kind: 'RETURN',
      tranId: suspended.tranId,
      outcome: 'CANCEL',
    });
    expect(r).toMatchObject({ result: 'RECORDED', intent_id: suspended.intentId });
  });

  it('anything outside the rules is INVALID and stores nothing', async () => {
    const before = (await eventsOf(a)).length;
    for (const args of [
      { kind: 'IPN', tranId: a.tranId, fields: { card_no: '01711XXXXXX' } },
      { kind: 'IPN', tranId: a.tranId, fields: { verify_sign: 'abc' } },
      { kind: 'IPN', tranId: a.tranId, fields: { amount: 1200 } },
      { kind: 'IPN', tranId: a.tranId, fields: ['VALID'] },
      { kind: 'IPN', tranId: a.tranId, fields: { error: 'x'.repeat(101) } },
      { kind: 'VALIDATE', tranId: a.tranId },
      { kind: 'INIT', tranId: a.tranId },
      { kind: 'QUERY', tranId: a.tranId },
      { kind: 'RETURN', tranId: a.tranId, outcome: 'PAID' },
      { kind: 'RETURN', tranId: a.tranId, outcome: null },
      { kind: 'RETURN', tranId: 'SSL-other.123', outcome: 'SUCCESS' },
      { kind: 'IPN', tranId: a.tranId, outcome: 'VALID' },
      { kind: 'IPN', tranId: null },
      { kind: 'IPN', tranId: "JS' OR 1=1" },
      { kind: 'IPN', tranId: a.tranId, valId: 'v'.repeat(51) },
      { kind: 'IPN', tranId: a.tranId, valId: 'VAL 1' },
    ]) {
      const r = await record({ slug: a.slug, ...args });
      expect(r.result, JSON.stringify(args)).toBe('INVALID');
      expect(r.event_id).toBeNull();
    }
    expect(await eventsOf(a)).toHaveLength(before);
  });

  it('only jantrik_app may run it: not the platform, receiver or login logins', async () => {
    for (const client of [platformClient(), ingestClient(), loginClient()]) {
      try {
        await expect(
          client.$queryRaw`SELECT * FROM public.payment_signal_record(
            ${a.slug}, 'IPN', ${a.tranId}, NULL, NULL, '{}'::jsonb, false, now())`,
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.$disconnect();
      }
    }
  });

  it('review focus 7: jantrik_app is not a member of jantrik_payments and gains no view from it', async () => {
    const [row] = await app.$queryRaw<{ member: boolean; usage: boolean }[]>`
      SELECT pg_has_role('jantrik_app', 'jantrik_payments', 'MEMBER') AS member,
             pg_has_role('jantrik_app', 'jantrik_payments', 'USAGE') AS usage`;
    expect(row).toEqual({ member: false, usage: false });
    // The `TO jantrik_payments` policies never apply to jantrik_app: no context, no intents, no
    // institutes, no events.
    const counts = await withContext(app, {}, async (tx) => ({
      intents: await tx.paymentIntent.count(),
      events: await tx.paymentGatewayEvent.count(),
      tenants: await tx.tenant.count(),
    }));
    expect(counts).toEqual({ intents: 0, events: 0, tenants: 0 });
    // Nor may it insert a signal itself, past the function.
    await expect(
      withContext(app, {}, (tx) =>
        tx.paymentGatewayEvent.create({
          data: {
            tenantId: a.tenantId,
            intentId: a.intentId,
            kind: 'IPN',
            tranId: a.tranId,
            receivedAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
