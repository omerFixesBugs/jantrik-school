import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

// Online payments (sprint 1 P7a, docs/payments.md): an institute's gateway account. One per
// provider per institute, SANDBOX only, the credentials one ciphertext, on only after a passing
// test, never deleted.

const CIPHERTEXT = `v1.${'A'.repeat(60)}`;

async function institute(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  const ownerId = await withTenant(app, tenantId, async (tx) => {
    const id = await findOrCreateUser(tx, randomPhone(), 'Owner');
    await tx.membership.create({ data: { tenantId, userId: id, role: 'OWNER' } });
    return id;
  });
  return { tenantId, ownerId };
}

describe('payment_gateway_accounts', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof institute>>;
  let b: Awaited<ReturnType<typeof institute>>;
  let c: Awaited<ReturnType<typeof institute>>;
  let accountA: string;

  /** An insert into C (which has no account): a refused one leaves C without an account. */
  const insertC = (data: Record<string, unknown>) =>
    withTenant(app, c.tenantId, (tx) =>
      tx.paymentGatewayAccount.create({
        data: { tenantId: c.tenantId, provider: 'SSLCOMMERZ', ...data },
      }),
    );
  const sqlA = (sql: string) => withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(sql));

  beforeAll(async () => {
    app = appClient();
    [a, b, c] = [await institute(app), await institute(app), await institute(app)];
    const row = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayAccount.create({
        data: {
          tenantId: a.tenantId,
          provider: 'SSLCOMMERZ',
          credentialsCiphertext: CIPHERTEXT,
          credentialsHint: '0001',
          credentialsUpdatedAt: new Date(),
          credentialsUpdatedById: a.ownerId,
        },
      }),
    );
    accountA = row.id;
    await withTenant(app, b.tenantId, (tx) =>
      tx.paymentGatewayAccount.create({ data: { tenantId: b.tenantId, provider: 'SSLCOMMERZ' } }),
    );
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('each institute sees only its own account; no context sees none', async () => {
    const rows = await withTenant(app, b.tenantId, (tx) =>
      tx.paymentGatewayAccount.findMany({ select: { id: true, tenantId: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(b.tenantId);
    expect(rows.some((r) => r.id === accountA)).toBe(false);
    expect(await app.paymentGatewayAccount.count()).toBe(0);
    // B cannot change A's row either (it sees nothing to change).
    const changed = await withTenant(app, b.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE payment_gateway_accounts SET enabled = false WHERE id = '${accountA}'`,
      ),
    );
    expect(changed).toBe(0);
    // Nor write a row for A.
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.paymentGatewayAccount.create({ data: { tenantId: a.tenantId, provider: 'SSLCOMMERZ' } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a new account: sandbox, off, key version 1, no credentials (version 0)', async () => {
    const row = await withTenant(app, b.tenantId, (tx) =>
      tx.paymentGatewayAccount.findFirstOrThrow(),
    );
    expect(row).toMatchObject({
      mode: 'SANDBOX',
      enabled: false,
      keyVersion: 1,
      credentialsVersion: 0,
      credentialsHint: null,
      lastTestResult: null,
    });
  });

  it('every client leaves the ciphertext out of its reads unless a query asks for it', async () => {
    const row = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayAccount.findFirstOrThrow(),
    );
    expect(row.credentialsHint).toBe('0001');
    expect('credentialsCiphertext' in row).toBe(false);
    const updated = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayAccount.update({ where: { id: accountA }, data: { enabled: false } }),
    );
    expect('credentialsCiphertext' in updated).toBe(false);
    const asked = await withTenant(app, a.tenantId, (tx) =>
      tx.paymentGatewayAccount.findFirstOrThrow({ select: { credentialsCiphertext: true } }),
    );
    expect(asked.credentialsCiphertext).toBe(CIPHERTEXT);
  });

  it('one account per provider per institute', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.paymentGatewayAccount.create({ data: { tenantId: a.tenantId, provider: 'SSLCOMMERZ' } }),
      ),
    ).rejects.toThrow(/unique/i);
  });

  it('sandbox only', async () => {
    await expect(insertC({ mode: 'LIVE' })).rejects.toThrow(/payment_gateway_accounts_mode/);
  });

  it('on only with credentials and a passing test', async () => {
    await expect(insertC({ enabled: true })).rejects.toThrow(/payment_gateway_accounts_enabled/);
    // Credentials but never tested, or a failed test.
    await expect(sqlA(`UPDATE payment_gateway_accounts SET enabled = true`)).rejects.toThrow(
      /payment_gateway_accounts_enabled/,
    );
    await sqlA(
      `UPDATE payment_gateway_accounts SET last_test_at = now(), last_test_result = 'BAD_CREDENTIALS', last_tested_by_id = '${a.ownerId}'`,
    );
    await expect(sqlA(`UPDATE payment_gateway_accounts SET enabled = true`)).rejects.toThrow(
      /payment_gateway_accounts_enabled/,
    );
    await sqlA(`UPDATE payment_gateway_accounts SET last_test_result = 'OK'`);
    await sqlA(`UPDATE payment_gateway_accounts SET enabled = true`);
    // Clearing the credentials or the test while on is refused: switch it off in the same update.
    await expect(
      sqlA(`UPDATE payment_gateway_accounts SET last_test_at = NULL, last_test_result = NULL,
        last_tested_by_id = NULL`),
    ).rejects.toThrow(/payment_gateway_accounts_enabled/);
    await sqlA(`UPDATE payment_gateway_accounts SET enabled = false, last_test_at = NULL,
      last_test_result = NULL, last_tested_by_id = NULL`);
  });

  it('the stored formats: ciphertext, hint, test result, failure code, key version', async () => {
    const credentials = {
      credentialsHint: '0001',
      credentialsUpdatedAt: new Date(),
      credentialsUpdatedById: c.ownerId,
    };
    for (const [data, constraint] of [
      [{ ...credentials, credentialsCiphertext: 'plain:teststore' }, 'ciphertext'],
      [{ ...credentials, credentialsCiphertext: 'v1.short' }, 'ciphertext'],
      [{ ...credentials, credentialsCiphertext: `v1.${'A'.repeat(2001)}` }, 'ciphertext'],
      [{ ...credentials, credentialsCiphertext: CIPHERTEXT, credentialsHint: '00001' }, 'hint'],
      [{ ...credentials, credentialsCiphertext: CIPHERTEXT, credentialsHint: '0 1' }, 'hint'],
      // A hint without credentials, credentials without a hint or without a time.
      [{ credentialsHint: '0001' }, 'credentials'],
      [{ ...credentials, credentialsHint: null, credentialsCiphertext: CIPHERTEXT }, 'credentials'],
      [{ credentialsCiphertext: CIPHERTEXT, credentialsHint: '0001' }, 'credentials'],
      [{ credentialsUpdatedById: c.ownerId }, 'credentials'],
      [{ lastTestAt: new Date(), lastTestResult: 'MAYBE' }, 'test'],
      [{ lastTestResult: 'OK' }, 'test'],
      [{ lastTestedById: c.ownerId }, 'test'],
      [{ lastFailureCode: 'TIMEOUT' }, 'failure'],
      [{ lastFailureCode: 'not a code', lastFailureAt: new Date() }, 'failure'],
      [{ keyVersion: 0 }, 'key_version'],
      [{ keyVersion: 101 }, 'key_version'],
    ] as const) {
      await expect(insertC(data), JSON.stringify(data)).rejects.toThrow(
        new RegExp(`payment_gateway_accounts_${constraint}`),
      );
    }
    // Saved credentials loaded by a command name no person (load-sandbox: no actor).
    await insertC({
      credentialsCiphertext: CIPHERTEXT,
      credentialsHint: 'ab_-',
      credentialsUpdatedAt: new Date(),
    });
  });

  it('never deleted; the institute, the provider and the mode never change', async () => {
    for (const sql of [
      `DELETE FROM payment_gateway_accounts`,
      `UPDATE payment_gateway_accounts SET provider = 'SSLCOMMERZ'`,
      `UPDATE payment_gateway_accounts SET mode = 'SANDBOX'`,
      `UPDATE payment_gateway_accounts SET tenant_id = '${a.tenantId}'`,
      `UPDATE payment_gateway_accounts SET created_at = now()`,
      `UPDATE payment_gateway_accounts SET id = id`,
    ]) {
      await expect(sqlA(sql), sql).rejects.toThrow(/permission denied/i);
    }
  });

  // P7a1-x20: the ciphertext's additional data names this version, so an older ciphertext of the
  // same row, copied back by an SQL injection inside the institute, never decrypts again.
  it('credentials_version: set by the trigger alone, one up whenever the ciphertext changes', async () => {
    const d = await institute(app);
    const sqlD = (sql: string) => withTenant(app, d.tenantId, (tx) => tx.$executeRawUnsafe(sql));
    const version = async () =>
      (
        await withTenant(app, d.tenantId, (tx) =>
          tx.$queryRawUnsafe<{ v: number }[]>(
            `SELECT credentials_version AS v FROM payment_gateway_accounts`,
          ),
        )
      )[0]!.v;
    const OTHER = `v1.${'B'.repeat(60)}`;
    // An insert that names a version gets the trigger's: 0 without a ciphertext.
    await sqlD(`INSERT INTO payment_gateway_accounts (id, tenant_id, provider, credentials_version)
      VALUES (gen_random_uuid(), '${d.tenantId}', 'SSLCOMMERZ', 7)`);
    expect(await version()).toBe(0);
    // The app may not write it.
    for (const v of [0, 1, 99]) {
      await expect(
        sqlD(`UPDATE payment_gateway_accounts SET credentials_version = ${v}`),
      ).rejects.toThrow(/permission denied/i);
    }
    // Every new ciphertext: one up.
    await sqlD(`UPDATE payment_gateway_accounts SET credentials_ciphertext = '${CIPHERTEXT}',
      credentials_hint = '0001', credentials_updated_at = now()`);
    expect(await version()).toBe(1);
    await sqlD(`UPDATE payment_gateway_accounts SET credentials_ciphertext = '${OTHER}'`);
    expect(await version()).toBe(2);
    // Anything else, or the same ciphertext written again: unchanged.
    await sqlD(`UPDATE payment_gateway_accounts SET updated_at = now(), enabled = false,
      credentials_hint = '0002', key_version = 1, last_failure_code = 'TIMEOUT',
      last_failure_at = now()`);
    await sqlD(`UPDATE payment_gateway_accounts SET credentials_ciphertext = '${OTHER}'`);
    expect(await version()).toBe(2);
    // An older ciphertext put back is a change like any other.
    await sqlD(`UPDATE payment_gateway_accounts SET credentials_ciphertext = '${CIPHERTEXT}'`);
    expect(await version()).toBe(3);
    // An insert with a ciphertext starts at 1, whatever it names.
    const e = await institute(app);
    await withTenant(app, e.tenantId, (tx) =>
      tx.$executeRawUnsafe(`INSERT INTO payment_gateway_accounts (id, tenant_id, provider,
        credentials_ciphertext, credentials_hint, credentials_updated_at, credentials_version)
        VALUES (gen_random_uuid(), '${e.tenantId}', 'SSLCOMMERZ', '${CIPHERTEXT}', '0001', now(), 0)`),
    );
    const [inserted] = await withTenant(app, e.tenantId, (tx) =>
      tx.$queryRawUnsafe<{ v: number }[]>(
        `SELECT credentials_version AS v FROM payment_gateway_accounts`,
      ),
    );
    expect(inserted!.v).toBe(1);
  });
});
