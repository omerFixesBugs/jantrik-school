import type { ConfigService } from '@nestjs/config';
import { withTenant } from '@jantrik/db';
import type { Env } from '../src/config/env.js';
import {
  PaymentCredentialsError,
  PaymentCredentialsService,
} from '../src/payments/payment-credentials.service.js';
import { Db } from '../src/tenancy/db.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { addMember, createHarness, createTenant, type Harness } from './support/harness.js';

// An institute's SSLCommerz credentials at rest (sprint 1 P7a, docs/payments.md → Credentials):
// one AES-256-GCM ciphertext per account, bound to the institute and the account, read by
// PaymentCredentialsService alone.

const creds = { storeId: 'teststore0001', storePassword: 'Sentinel-Pw-91x@ssl' };

describe('PaymentCredentialsService', () => {
  let h: Harness;
  let service: PaymentCredentialsService;
  let jobs: TenantJobRunner;

  /** An institute with an (empty) SSLCommerz account and an owner. */
  const institute = async () => {
    const tenantId = (await createTenant(h, { modules: ['FEES'] })).id;
    const owner = await addMember(h, tenantId, { roles: ['OWNER'] });
    const account = await withTenant(h.prisma, tenantId, (tx) =>
      tx.paymentGatewayAccount.create({ data: { tenantId, provider: 'SSLCOMMERZ' } }),
    );
    return { tenantId, ownerId: owner.userId, accountId: account.id };
  };
  const stored = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.paymentGatewayAccount.findFirstOrThrow({
        omit: { credentialsCiphertext: false },
      }),
    );

  beforeAll(async () => {
    h = await createHarness();
    service = h.app.get(PaymentCredentialsService);
    jobs = h.app.get(TenantJobRunner);
  });

  afterAll(async () => {
    await h.close();
  });

  it('round-trips; the row holds a ciphertext and the hint, never the values', async () => {
    const a = await institute();
    const now = new Date('2026-11-27T06:00:00.000Z');
    await jobs.run(a.tenantId, () =>
      service.save(a.accountId, creds, { actorUserId: a.ownerId, now }),
    );
    expect(await jobs.run(a.tenantId, () => service.read(a.accountId))).toEqual(creds);
    const row = await stored(a.tenantId);
    expect(row.credentialsCiphertext).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(creds.storePassword);
    expect(JSON.stringify(row)).not.toContain(creds.storeId);
    expect(row).toMatchObject({
      credentialsHint: '0001',
      keyVersion: 1,
      credentialsVersion: 1,
      credentialsUpdatedAt: now,
      credentialsUpdatedById: a.ownerId,
      enabled: false,
    });
  });

  it('two saves of the same values give different ciphertexts', async () => {
    const a = await institute();
    const save = () =>
      jobs.run(a.tenantId, () =>
        service.save(a.accountId, creds, { actorUserId: a.ownerId, now: new Date() }),
      );
    await save();
    const first = (await stored(a.tenantId)).credentialsCiphertext;
    await save();
    const second = (await stored(a.tenantId)).credentialsCiphertext;
    expect(second).not.toBe(first);
    expect(await jobs.run(a.tenantId, () => service.read(a.accountId))).toEqual(creds);
  });

  it('saving switches the account off and clears the last test (P7a-M) in one update', async () => {
    const a = await institute();
    await jobs.run(a.tenantId, () =>
      service.save(a.accountId, creds, { actorUserId: a.ownerId, now: new Date() }),
    );
    await withTenant(h.prisma, a.tenantId, (tx) =>
      tx.paymentGatewayAccount.update({
        where: { id: a.accountId },
        data: {
          lastTestAt: new Date(),
          lastTestResult: 'OK',
          lastTestedById: a.ownerId,
          enabled: true,
        },
      }),
    );
    await jobs.run(a.tenantId, () =>
      service.save(
        a.accountId,
        { storeId: 'other_store-9', storePassword: 'x' },
        { actorUserId: null, now: new Date() },
      ),
    );
    expect(await stored(a.tenantId)).toMatchObject({
      enabled: false,
      lastTestAt: null,
      lastTestResult: null,
      lastTestedById: null,
      credentialsHint: 're-9',
      credentialsUpdatedById: null,
    });
  });

  it("A's ciphertext on B's account does not decrypt (bound to the institute and the account)", async () => {
    const a = await institute();
    const b = await institute();
    await jobs.run(a.tenantId, () =>
      service.save(a.accountId, creds, { actorUserId: a.ownerId, now: new Date() }),
    );
    await jobs.run(b.tenantId, () =>
      service.save(
        b.accountId,
        { storeId: 'bstore0002', storePassword: 'b-password' },
        { actorUserId: b.ownerId, now: new Date() },
      ),
    );
    const copied = (await stored(a.tenantId)).credentialsCiphertext!;
    await withTenant(h.prisma, b.tenantId, (tx) =>
      tx.paymentGatewayAccount.update({
        where: { id: b.accountId },
        data: { credentialsCiphertext: copied },
      }),
    );
    await expect(jobs.run(b.tenantId, () => service.read(b.accountId))).rejects.toMatchObject({
      code: 'CREDENTIALS_UNREADABLE',
    });
    // A's own row still reads.
    expect(await jobs.run(a.tenantId, () => service.read(a.accountId))).toEqual(creds);
    // B cannot read A's account at all: RLS hides it.
    await expect(jobs.run(b.tenantId, () => service.read(a.accountId))).rejects.toMatchObject({
      code: 'CREDENTIALS_MISSING',
    });
  });

  it('an older ciphertext of the same account put back never decrypts (P7a1-x20)', async () => {
    const a = await institute();
    const former = { storeId: 'formerstore7', storePassword: 'Former-Pw-7@ssl' };
    const save = (values: typeof creds) =>
      jobs.run(a.tenantId, () =>
        service.save(a.accountId, values, { actorUserId: a.ownerId, now: new Date() }),
      );
    await save(former);
    const first = await stored(a.tenantId);
    await save(creds);
    const second = await stored(a.tenantId);
    expect(await jobs.run(a.tenantId, () => service.read(a.accountId))).toEqual(creds);
    // An SQL injection inside the institute (jantrik_app, any role's request) copies the former
    // store's ciphertext back.
    const old = first.credentialsCiphertext;
    const changed = await withTenant(
      h.prisma,
      a.tenantId,
      (tx) => tx.$executeRaw`UPDATE payment_gateway_accounts SET credentials_ciphertext = ${old}`,
    );
    expect(changed).toBe(1);
    // Never the former store: unreadable, and the owner saves the store again.
    await expect(jobs.run(a.tenantId, () => service.read(a.accountId))).rejects.toMatchObject({
      code: 'CREDENTIALS_UNREADABLE',
    });
    const rolledBack = await stored(a.tenantId);
    await save(creds);
    expect(await jobs.run(a.tenantId, () => service.read(a.accountId))).toEqual(creds);
    // One up on every new ciphertext, the one put back included.
    expect(
      [first, second, rolledBack, await stored(a.tenantId)].map((r) => r.credentialsVersion),
    ).toEqual([1, 2, 3, 4]);
  });

  it('a changed key → CREDENTIALS_UNREADABLE, an error that names nothing', async () => {
    const a = await institute();
    await jobs.run(a.tenantId, () =>
      service.save(a.accountId, creds, { actorUserId: a.ownerId, now: new Date() }),
    );
    const config = {
      get: (key: keyof Env) =>
        ({ NODE_ENV: 'test', PAYMENT_CREDENTIALS_KEY: 'another-key-'.repeat(4), OTP_PEPPER: 'x' })[
          key as string
        ],
    } as unknown as ConfigService<Env, true>;
    const rotated = new PaymentCredentialsService(h.app.get(Db), config);
    let thrown: unknown;
    try {
      await jobs.run(a.tenantId, () => rotated.read(a.accountId));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaymentCredentialsError);
    expect((thrown as PaymentCredentialsError).code).toBe('CREDENTIALS_UNREADABLE');
    const text = `${String(thrown)} ${JSON.stringify(thrown)} ${(thrown as Error).stack}`;
    expect(text).not.toContain(creds.storePassword);
    expect(text).not.toContain('v1.');
  });

  it('no credentials yet → CREDENTIALS_MISSING', async () => {
    const a = await institute();
    await expect(jobs.run(a.tenantId, () => service.read(a.accountId))).rejects.toMatchObject({
      code: 'CREDENTIALS_MISSING',
    });
  });

  it('the hint is the store ID’s last 4 characters', () => {
    expect(service.hint('teststore0001')).toBe('0001');
    expect(service.hint('ab')).toBe('ab');
    expect(service.hint('shop_x-12')).toBe('x-12');
  });
});
