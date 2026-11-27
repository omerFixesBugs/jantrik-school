import { Logger } from '@nestjs/common';
import { withTenant } from '@jantrik/db';
import type { GatewayAccountView, GatewayTestQueued } from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../src/payments/payments.config.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { feesSchool, type FeesSchool } from './support/fees.js';
import {
  addMember,
  bearer,
  createHarness,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';

// The OWNER sets up the institute's SSLCommerz sandbox store (sprint 1 P7a, docs/payments.md →
// Gateway accounts): write-only credentials, a connection test as a job, on only after a passing
// test, audited by field name. The fake SSLCommerz stands in for the sandbox.

const GOOD = { storeId: 'jantrik0001', storePassword: 'Good-Pw-31@ssl' };
const SENTINEL = 'Sentinel-Pw-QX81zv@ssl';
const PUBLIC_URL = 'https://api.jantrik.example';
const ACCOUNT = '/fees/online-payments/account';

/** Every string a value holds (Redis keys and values, response bodies). */
async function redisDump(redis: Redis): Promise<string> {
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

describe('gateway account (OWNER)', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let config: PaymentsConfig;
  let s: FeesSchool;
  let slug: string;
  /** Every response body the tests saw (the sentinel test reads them). */
  const bodies: string[] = [];

  const as = (token: string) => ({
    get: (path = ACCOUNT) =>
      http(h)
        .get(path)
        .set(bearer(token))
        .then((r) => (bodies.push(r.text), r)),
    put: (body: unknown) =>
      http(h)
        .put(ACCOUNT)
        .set(bearer(token))
        .send(body as object)
        .then((r) => (bodies.push(r.text), r)),
    post: (action: 'test' | 'enable' | 'disable') =>
      http(h)
        .post(`${ACCOUNT}/${action}`)
        .set(bearer(token))
        .then((r) => (bodies.push(r.text), r)),
  });
  const owner = () => as(s.tokens.owner);

  /** Ask for a test and wait for its result on the view. */
  const tested = async (token = s.tokens.owner): Promise<GatewayAccountView> => {
    const asked = await as(token).post('test');
    expect(asked.status).toBe(202);
    const { requestedAt } = asked.body as GatewayTestQueued;
    return vi.waitFor(
      async () => {
        const view = (await as(token).get()).body as GatewayAccountView;
        if (!view.lastTest || view.lastTest.at < requestedAt) throw new Error('not tested yet');
        return view;
      },
      { timeout: 10_000, interval: 100 },
    );
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.addStore(GOOD.storeId, GOOD.storePassword);
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_URL },
    });
    config = h.app.get<PaymentsConfig>(PAYMENTS_CONFIG);
    s = await feesSchool(h);
    slug = (
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.tenant.findFirstOrThrow({ select: { slug: true } }),
      )
    ).slug;
  });

  afterEach(() => {
    config.sslcommerzBaseUrl = fake.url;
    config.apiPublicUrl = PUBLIC_URL;
  });

  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('before any setup: not configured, off, and the IPN address to paste', async () => {
    const res = await owner().get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'SSLCOMMERZ',
      mode: 'SANDBOX',
      configured: false,
      enabled: false,
      hint: null,
      credentialsUpdatedAt: null,
      lastTest: null,
      lastFailure: null,
      ipnUrl: `${PUBLIC_URL}/public/payments/sslcommerz/${slug}/ipn`,
    } satisfies GatewayAccountView);
    // No public address: nothing to paste.
    config.apiPublicUrl = null;
    expect((await owner().get()).body.ipnUrl).toBeNull();
  });

  it('only the OWNER, and only with FEES on', async () => {
    for (const token of [
      s.tokens.admin,
      s.tokens.accountant,
      s.tokens.teacher,
      s.tokens.guardian,
    ]) {
      expect((await as(token).get()).status).toBe(403);
      expect((await as(token).put(GOOD)).status).toBe(403);
      for (const action of ['test', 'enable', 'disable'] as const) {
        expect((await as(token).post(action)).status).toBe(403);
      }
    }
    const noFees = await feesSchool(h, { modules: ['ATTENDANCE'] });
    expect((await as(noFees.tokens.owner).get()).status).toBe(403);
    expect((await as(noFees.tokens.owner).put(GOOD)).status).toBe(403);
  });

  it('save: configured and off, the hint, never a value back', async () => {
    const res = await owner().put(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      enabled: false,
      hint: '0001',
      lastTest: null,
    });
    expect(res.text).not.toContain(GOOD.storePassword);
    expect(res.text).not.toContain(GOOD.storeId);
    expect(new Date(res.body.credentialsUpdatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Unknown fields and malformed values are refused; the messages repeat nothing.
    for (const body of [
      { ...GOOD, extra: 1 },
      { storeId: GOOD.storeId },
      { storeId: 'has space', storePassword: 'x' },
      { storeId: GOOD.storeId, storePassword: '' },
      { storeId: GOOD.storeId, storePassword: 'with space' },
    ]) {
      const bad = await owner().put(body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.text).not.toContain('has space');
      expect(bad.text).not.toContain('with space');
    }
  });

  it('test: OK with good credentials, BAD_CREDENTIALS, UNREACHABLE when SSLCommerz is down', async () => {
    await owner().put(GOOD);
    expect((await tested()).lastTest?.result).toBe('OK');
    await owner().put({ ...GOOD, storePassword: 'Wrong-Pw-00@ssl' });
    expect((await tested()).lastTest?.result).toBe('BAD_CREDENTIALS');
    await owner().put(GOOD);
    config.sslcommerzBaseUrl = 'http://127.0.0.1:9';
    expect((await tested()).lastTest?.result).toBe('UNREACHABLE');
    config.sslcommerzBaseUrl = fake.url;
    fake.override('query', { status: 500 });
    expect((await tested()).lastTest?.result).toBe('ERROR');
  });

  it('a test needs saved credentials, and at most 10 an hour per institute', async () => {
    const other = await feesSchool(h);
    const res = await as(other.tokens.owner).post('test');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDENTIALS_REQUIRED');
    await as(other.tokens.owner).put(GOOD);
    for (let i = 0; i < 10; i++)
      expect((await as(other.tokens.owner).post('test')).status).toBe(202);
    expect((await as(other.tokens.owner).post('test')).status).toBe(429);
    // Another institute's budget is its own.
    await owner().put(GOOD);
    expect((await owner().post('test')).status).toBe(202);
  });

  it('on only after a passing test and with a public address; new credentials switch it off', async () => {
    await owner().put(GOOD);
    let res = await owner().post('enable');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEST_REQUIRED');
    await owner().put({ ...GOOD, storePassword: 'Wrong-Pw-00@ssl' });
    expect((await tested()).lastTest?.result).toBe('BAD_CREDENTIALS');
    expect((await owner().post('enable')).body.code).toBe('TEST_REQUIRED');
    await owner().put(GOOD);
    expect((await tested()).lastTest?.result).toBe('OK');
    config.apiPublicUrl = null;
    res = await owner().post('enable');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('API_PUBLIC_URL_MISSING');
    config.apiPublicUrl = PUBLIC_URL;
    res = await owner().post('enable');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, configured: true });
    // New credentials: off again, the test cleared.
    res = await owner().put(GOOD);
    expect(res.body).toMatchObject({ enabled: false, lastTest: null });
    expect((await tested()).lastTest?.result).toBe('OK');
    expect((await owner().post('enable')).body.enabled).toBe(true);
    res = await owner().post('disable');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('a test of credentials replaced meanwhile writes nothing', async () => {
    await owner().put(GOOD);
    fake.override('query', { delayMs: 1500 });
    const asked = await owner().post('test');
    expect(asked.status).toBe(202);
    // Saved while the slow test runs.
    await new Promise((r) => setTimeout(r, 300));
    await owner().put({ ...GOOD, storePassword: 'Wrong-Pw-00@ssl' });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await owner().get()).body.lastTest).toBeNull();
  });

  it('audit: field names for credentials, each test result, on and off; never a value', async () => {
    const rows = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'payment_gateway_account' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const values = rows.map((r) => ({ action: r.action, actor: r.actorUserId, new: r.newValues }));
    expect(values).toContainEqual({
      action: 'CREATE',
      actor: s.userIds.owner,
      new: { changed: ['storeId', 'storePassword'], enabled: false },
    });
    expect(values).toContainEqual({
      action: 'UPDATE',
      actor: s.userIds.owner,
      new: { changed: ['storeId', 'storePassword'], enabled: false },
    });
    for (const result of ['OK', 'BAD_CREDENTIALS', 'UNREACHABLE', 'ERROR']) {
      expect(values).toContainEqual({
        action: 'UPDATE',
        actor: s.userIds.owner,
        new: { test: result },
      });
    }
    expect(values).toContainEqual({
      action: 'UPDATE',
      actor: s.userIds.owner,
      new: { enabled: true },
    });
    expect(values).toContainEqual({
      action: 'UPDATE',
      actor: s.userIds.owner,
      new: { enabled: false },
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(GOOD.storePassword);
    expect(text).not.toContain('Wrong-Pw-00@ssl');
    expect(text).not.toContain(GOOD.storeId);
    expect(text).not.toContain('v1.');
  });

  it('review focus 6: a sentinel password reaches SSLCommerz and nothing else', async () => {
    const logged: string[] = [];
    const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
    const spies = [
      ...levels.map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(
            args
              .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a)))
              .join(' '),
          );
        }),
      ),
      ...levels
        .filter((l): l is 'log' | 'error' | 'warn' | 'debug' => l in console)
        .map((level) =>
          vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(' '));
          }),
        ),
    ];
    try {
      const sentinel = await feesSchool(h);
      const o = as(sentinel.tokens.owner);
      // A save, a failed test (refused credentials), a 500 from SSLCommerz, a validation error.
      expect((await o.put({ storeId: 'sentinel0009', storePassword: SENTINEL })).status).toBe(200);
      expect((await tested(sentinel.tokens.owner)).lastTest?.result).toBe('BAD_CREDENTIALS');
      fake.override('query', { status: 500, raw: `upstream said ${SENTINEL}` });
      expect((await tested(sentinel.tokens.owner)).lastTest?.result).toBe('ERROR');
      fake.addStore('sentinel0009', SENTINEL);
      expect((await tested(sentinel.tokens.owner)).lastTest?.result).toBe('OK');
      const tooLong = `${SENTINEL}${'x'.repeat(200 - SENTINEL.length)}`;
      const refused = await o.put({ storeId: 'sentinel0009', storePassword: tooLong });
      expect(refused.status).toBe(400);
      bodies.push((await o.get()).text);

      // The positive control: SSLCommerz (the fake) was sent it.
      expect(fake.requests.some((r) => r.fields['store_passwd'] === SENTINEL)).toBe(true);
      // Nowhere else: responses, logs, the audit log, the account row, Redis (job data, failed
      // jobs' reasons and stack traces included).
      expect(bodies.join('\n')).not.toContain(SENTINEL);
      expect(logged.join('\n')).not.toContain(SENTINEL);
      const audit = await withTenant(h.prisma, sentinel.tenantId, (tx) => tx.auditLog.findMany());
      expect(JSON.stringify(audit)).not.toContain(SENTINEL);
      const row = await withTenant(h.prisma, sentinel.tenantId, (tx) =>
        tx.paymentGatewayAccount.findFirstOrThrow({ omit: { credentialsCiphertext: false } }),
      );
      expect(JSON.stringify(row)).not.toContain(SENTINEL);
      const redis = await redisDump(h.redis);
      expect(redis).not.toContain(SENTINEL);
      expect(redis).not.toContain('sentinel0009');
      // The test jobs were there (the dump is not empty of them).
      expect(redis).toContain('account-test');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('the job acts for the owner who asked, and stops if they are no longer the owner', async () => {
    const other = await feesSchool(h);
    await as(other.tokens.owner).put(GOOD);
    // A second owner asks, then loses the role before the job runs: nothing is written.
    const second = await addMember(h, other.tenantId, { roles: ['OWNER'] });
    const token = (await otpLogin(h, second.phone)).accessToken;
    fake.override('query', { delayMs: 1000 });
    expect((await as(token).post('test')).status).toBe(202);
    await h.access.setMemberRoles(other.tenantId, second.userId, ['ADMIN']);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await as(other.tokens.owner).get()).body.lastTest).toBeNull();
  });
});
