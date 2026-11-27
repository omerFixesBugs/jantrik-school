import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  FeeGuardianView,
  FeeHeadView,
  GatewayAccountView,
  GatewayTestQueued,
  OnlinePaymentView,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import type { FakeSslcommerz, FakeTransaction } from './fake-sslcommerz.js';
import { feesSchool, type FeesSchool } from './fees.js';
import { bearer, http, type Harness } from './harness.js';

// Online payments, part 2 (sprint 1 P7a2): an institute with fees, a tuition head with a per-day
// fine, and its SSLCommerz sandbox account (the fake) saved, tested and on.

export const PUBLIC_API = 'https://api.jantrik.example';
export const PUBLIC_WEB = 'https://app.jantrik.example';
/** SSLCommerz's documented sandbox address (a "listed" sender, P7a-C). */
export const SSLCOMMERZ_IP = '103.26.139.87';

export interface OnlineSchool extends FeesSchool {
  slug: string;
  store: { storeId: string; storePassword: string };
  tuition: FeeHeadView;
}

export const api = (h: Harness, token: string) => ({
  get: (path: string) => http(h).get(path).set(bearer(token)),
  post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
  put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
});

/** Every string Redis holds, keys and values (the sentinel tests). */
export async function redisDump(redis: Redis): Promise<string> {
  const parts: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      parts.push(key);
      const type = await redis.type(key);
      if (type === 'string') parts.push((await redis.get(key)) ?? '');
      else if (type === 'hash') parts.push(JSON.stringify(await redis.hgetall(key)));
      else if (type === 'list') parts.push(JSON.stringify(await redis.lrange(key, 0, -1)));
      else if (type === 'set') parts.push(JSON.stringify(await redis.smembers(key)));
      else if (type === 'zset') parts.push(JSON.stringify(await redis.zrange(key, 0, -1)));
      else if (type === 'stream') parts.push(JSON.stringify(await redis.xrange(key, '-', '+')));
    }
  } while (cursor !== '0');
  return parts.join('\n');
}

/** The account saved, tested against the fake and switched on, as the owner does it. */
export async function enableAccount(
  h: Harness,
  fake: FakeSslcommerz,
  ownerToken: string,
  store = { storeId: `st${randomUUID().slice(0, 8)}`, storePassword: `Pw-${randomUUID()}` },
) {
  fake.addStore(store.storeId, store.storePassword);
  const owner = api(h, ownerToken);
  await owner.put('/fees/online-payments/account', store).expect(200);
  const { requestedAt } = (await owner.post('/fees/online-payments/account/test').expect(202))
    .body as GatewayTestQueued;
  await vi.waitFor(
    async () => {
      const view = (await owner.get('/fees/online-payments/account')).body as GatewayAccountView;
      if (!view.lastTest || view.lastTest.at < requestedAt) throw new Error('not tested yet');
      expect(view.lastTest.result).toBe('OK');
    },
    { timeout: 10_000, interval: 100 },
  );
  await owner.post('/fees/online-payments/account/enable').expect(200);
  return store;
}

export async function onlineSchool(h: Harness, fake: FakeSslcommerz): Promise<OnlineSchool> {
  const s = await feesSchool(h);
  const admin = api(h, s.tokens.admin);
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
      receiptNote: null,
    })
    .expect(200);
  const store = await enableAccount(h, fake, s.tokens.owner);
  const { slug } = await withTenant(h.prisma, s.tenantId, (tx) =>
    tx.tenant.findFirstOrThrow({ select: { slug: true } }),
  );
  return { ...s, slug, store, tuition };
}

/** The guardian's view of a child's fees. */
export async function childFees(h: Harness, token: string, studentId: string) {
  return (await api(h, token).get(`/me/children/${studentId}/fees`).expect(200))
    .body as FeeGuardianView;
}

/** The owed dues (all, or those matching `pick`) and what they owe today, as the sheet shows. */
export async function owed(
  h: Harness,
  token: string,
  studentId: string,
  pick?: (d: FeeGuardianView['ledger']['dues'][number]) => boolean,
) {
  const view = await childFees(h, token, studentId);
  const dues = view.ledger.dues.filter(
    (d) => d.status === 'OPEN' && d.balance.total > 0 && (!pick || pick(d)),
  );
  return { dueIds: dues.map((d) => d.id), total: dues.reduce((s, d) => s + d.balance.total, 0) };
}

/** Start a checkout and wait for the session (READY), or the failure. */
export async function startPayment(
  h: Harness,
  token: string,
  studentId: string,
  opts: { dueIds?: string[]; expected?: number; wait?: 'READY' | 'NOT_PAID' | false } = {},
) {
  const all = await owed(h, token, studentId);
  const dueIds = opts.dueIds ?? all.dueIds;
  const expected =
    opts.expected ??
    (opts.dueIds
      ? (await owed(h, token, studentId, (d) => dueIds.includes(d.id))).total
      : all.total);
  const res = await api(h, token)
    .post(`/me/children/${studentId}/fees/online-payments`, {
      dueIds,
      expectedAmountPaisa: expected,
      clientRequestId: randomUUID(),
    })
    .expect(201);
  const view = res.body as OnlinePaymentView;
  if (opts.wait === false) return view;
  const want = opts.wait ?? 'READY';
  return vi.waitFor(
    async () => {
      const now = (
        await api(h, token).get(`/me/children/${studentId}/fees/online-payments/${view.id}`)
      ).body as OnlinePaymentView;
      if (now.state !== want) throw new Error(`still ${now.state}`);
      return now;
    },
    { timeout: 10_000, interval: 100 },
  );
}

/** The intent row as the institute sees it. */
export function intentRow(h: Harness, tenantId: string, intentId: string) {
  return withTenant(h.prisma, tenantId, (tx) =>
    tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } }),
  );
}

/** The gateway's payment for an intent (the fake's transaction, VALID unless told otherwise). */
export async function payAtGateway(
  h: Harness,
  fake: FakeSslcommerz,
  tenantId: string,
  intentId: string,
  opts: { status?: string; fields?: Record<string, string | undefined> } = {},
): Promise<FakeTransaction> {
  const intent = await intentRow(h, tenantId, intentId);
  return fake.pay(intent.sessionRef!, opts);
}

/** What SSLCommerz posts as the IPN for a transaction (the fake's fields). */
export function ipnFields(t: FakeTransaction, extra: Record<string, string> = {}) {
  const fields: Record<string, string> = { tran_id: t.tranId, val_id: t.valId, status: t.status };
  for (const [k, v] of Object.entries(t.fields)) if (v !== undefined) fields[k] = v;
  return { ...fields, ...extra };
}

export function postIpn(
  h: Harness,
  slug: string,
  fields: Record<string, string>,
  ip = SSLCOMMERZ_IP,
) {
  return http(h)
    .post(`/public/payments/sslcommerz/${slug}/ipn`)
    .set('X-Forwarded-For', ip)
    .type('form')
    .send(fields);
}

export function postReturn(
  h: Harness,
  slug: string,
  tranId: string,
  outcome: 'success' | 'fail' | 'cancel',
  fields: Record<string, string>,
  ip = '10.9.8.7',
) {
  return http(h)
    .post(`/public/payments/sslcommerz/${slug}/return/${tranId}/${outcome}`)
    .set('X-Forwarded-For', ip)
    .type('form')
    .send(fields);
}

/** Wait until the intent reaches a status (the worker settles signals in the background). */
export function waitStatus(h: Harness, tenantId: string, intentId: string, status: string) {
  return vi.waitFor(
    async () => {
      const row = await intentRow(h, tenantId, intentId);
      if (row.status !== status) throw new Error(`still ${row.status}`);
      return row;
    },
    { timeout: 15_000, interval: 100 },
  );
}

/** Forget the guardians' checkout budgets (10 an hour each) between cases of one test file. */
export async function resetStartBudgets(h: Harness): Promise<void> {
  const keys = await h.redis.keys('rl:pay-start:*');
  if (keys.length > 0) await h.redis.del(...keys);
}

/**
 * A due of its own for one student (a yearly head of its own with no amounts, so nothing else is
 * generated from it): `amountPaisa`, due on `dueDate`, an optional per-day fine (a high cap).
 */
export async function extraDue(
  h: Harness,
  s: OnlineSchool,
  studentId: string,
  opts: { amountPaisa: number; dueDate: string; finePerDayPaisa?: number },
) {
  const head = (
    await api(h, s.tokens.admin)
      .post('/fees/heads', {
        nameBn: `বিশেষ ${randomUUID().slice(0, 6)}`,
        nameEn: `Special ${randomUUID().slice(0, 6)}`,
        kind: 'OTHER',
        frequency: 'YEARLY',
      })
      .expect(201)
  ).body as FeeHeadView;
  return withTenant(h.prisma, s.tenantId, (tx) =>
    tx.feeDue.create({
      data: {
        tenantId: s.tenantId,
        studentId,
        feeHeadId: head.id,
        academicYearId: s.yearId,
        periodKey: 'Y',
        periodStart: new Date(`${s.yearStart}T00:00:00Z`),
        dueDate: new Date(`${opts.dueDate}T00:00:00Z`),
        amountPaisa: opts.amountPaisa,
        ...(opts.finePerDayPaisa
          ? {
              fineType: 'PER_DAY' as const,
              fineAmountPaisa: opts.finePerDayPaisa,
              fineCapPaisa: 100_000_000,
            }
          : { fineType: 'NONE' as const, fineAmountPaisa: 0 }),
      },
    }),
  );
}
