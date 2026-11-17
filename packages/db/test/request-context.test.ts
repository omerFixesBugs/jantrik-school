import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findOrCreateUser,
  loadRequestContextKey,
  loadRequestContextKeyAsOwner,
  requestContextKey,
  requestContextKeyId,
  setRequestContextKeySource,
  signRequestContext,
  withContext,
  withTenant,
  type PrismaClient,
  type TenantTx,
} from '../src/index.js';
import {
  appClient,
  createStudent,
  createTenant,
  ingestClient,
  loginClient,
  ownerClient,
  platformClient,
  randomPhone,
  singleConnectionAppClient,
} from './helpers.js';

// P1-J8: app_current_tenant_id() / app_current_user_id() believe only app.context, signed with
// the database's key for the very transaction it is set in (docs/database.md → The request
// context). The attacks themselves: account-takeover.test.ts.

const INVALID = /invalid request context/;

/** Where `tx` runs: its backend and its transaction start, as the signature names them. */
async function here(tx: TenantTx): Promise<{ pid: string; startedMicros: string }> {
  const [row] = await tx.$queryRaw<{ pid: string; started: string }[]>`
    SELECT pg_backend_pid()::text AS pid,
           (extract(epoch FROM now()) * 1000000)::bigint::text AS started`;
  return { pid: row!.pid, startedMicros: row!.started };
}

const setContext = (tx: TenantTx, value: string) =>
  tx.$executeRaw`SELECT set_config('app.context', ${value}, true)`;

const whoAmI = (tx: TenantTx) =>
  tx.$queryRaw<{ tenant: string | null; person: string | null }[]>`
    SELECT app_current_tenant_id()::text AS tenant, app_current_user_id()::text AS person`.then(
    ([row]) => row,
  );

describe('the verified request context', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let key: Buffer;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    key = await requestContextKey();
    tenantA = (await createTenant(app)).id;
    tenantB = (await createTenant(app)).id;
    await createStudent(app, tenantA, 'A-1');
    await createStudent(app, tenantB, 'B-1');
    userA = await withTenant(app, tenantA, (tx) => findOrCreateUser(tx, randomPhone(), 'A'));
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  });

  it('withContext signs one setting and the functions return it', async () => {
    const seen = await withContext(app, { tenantId: tenantA, userId: userA }, async (tx) => {
      const [raw] = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('app.context') AS v`;
      return { raw: raw!.v, me: await whoAmI(tx), students: await tx.student.count() };
    });
    expect(seen.raw).toMatch(/^v1:[0-9a-f-]{36}:[0-9a-f-]{36}:\d+:\d+:[0-9a-f]{64}$/);
    expect(seen.me).toEqual({ tenant: tenantA, person: userA });
    expect(seen.students).toBe(1);
  });

  it('no context, or an empty one, means nothing visible (not an error)', async () => {
    expect(await app.$transaction((tx) => whoAmI(tx))).toEqual({ tenant: null, person: null });
    const empty = await app.$transaction(async (tx) => {
      await setContext(tx, '');
      return { me: await whoAmI(tx), students: await tx.student.count() };
    });
    expect(empty).toEqual({ me: { tenant: null, person: null }, students: 0 });
  });

  it('a value stored for the session (SET without LOCAL) is never used: signed or empty, per transaction', async () => {
    const single = singleConnectionAppClient();
    try {
      await single.$executeRawUnsafe("SET app.context = 'v1:garbage'");
      // A contextless transaction sets an empty value for itself instead of reading the stored one.
      expect(await withContext(single, {}, (tx) => whoAmI(tx))).toEqual({
        tenant: null,
        person: null,
      });
      // A signed one sets its own.
      expect(await withTenant(single, tenantA, (tx) => tx.student.count())).toBe(1);
    } finally {
      await single.$disconnect();
    }
  });

  it('the old settings app.tenant_id and app.user_id mean nothing', async () => {
    const seen = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userA}, true)`;
      return { me: await whoAmI(tx), students: await tx.student.count() };
    });
    expect(seen).toEqual({ me: { tenant: null, person: null }, students: 0 });
  });

  describe('a changed value is refused, loudly (42501), for every reason', () => {
    /** In A's signed transaction, replace the value with `change(valid)` and query. */
    const tamper = (change: (valid: string) => string) =>
      withContext(app, { tenantId: tenantA, userId: userA }, async (tx) => {
        const [raw] = await tx.$queryRaw<
          { v: string }[]
        >`SELECT current_setting('app.context') AS v`;
        await setContext(tx, change(raw!.v));
        return tx.student.count();
      });

    it.each([
      [
        'another tenant, same MAC',
        (v: string) =>
          v.replace(/^v1:[^:]+/, `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`),
      ],
      ['no tenant, same MAC', (v: string) => v.replace(/^v1:[^:]+/, 'v1:')],
      ['one MAC digit flipped', (v: string) => v.slice(0, -1) + (v.endsWith('0') ? '1' : '0')],
      ['upper-case', (v: string) => v.toUpperCase()],
      ['an extra part', (v: string) => `${v}:00`],
      ['truncated', (v: string) => v.slice(0, -2)],
      ['another version', (v: string) => v.replace(/^v1/, 'v2')],
      ['garbage', () => 'not a context'],
      [
        'a MAC from another key',
        (v: string) => {
          const parts = v.split(':');
          return signRequestContext(randomBytes(48), {
            tenantId: parts[1] || null,
            userId: parts[2] || null,
            pid: parts[3]!,
            startedMicros: parts[4]!,
          });
        },
      ],
    ])('%s', async (_name, change) => {
      await expect(tamper(change)).rejects.toThrow(INVALID);
    });
  });

  it('a correctly signed context names this backend and this transaction, or it is refused', async () => {
    await expect(
      app.$transaction(async (tx) => {
        const at = await here(tx);
        await setContext(
          tx,
          signRequestContext(key, {
            tenantId: tenantA,
            userId: null,
            pid: String(Number(at.pid) + 1),
            startedMicros: at.startedMicros,
          }),
        );
        return tx.student.count();
      }),
    ).rejects.toThrow(INVALID);
    await expect(
      app.$transaction(async (tx) => {
        const at = await here(tx);
        await setContext(
          tx,
          signRequestContext(key, {
            tenantId: tenantA,
            userId: null,
            pid: at.pid,
            startedMicros: String(BigInt(at.startedMicros) - 1n),
          }),
        );
        return tx.student.count();
      }),
    ).rejects.toThrow(INVALID);
    // The same parts, correct: accepted (so the two refusals above were about pid and start).
    const ok = await app.$transaction(async (tx) => {
      await setContext(
        tx,
        signRequestContext(key, { tenantId: tenantA, userId: null, ...(await here(tx)) }),
      );
      return tx.student.count();
    });
    expect(ok).toBe(1);
  });

  it('a value copied from one transaction is refused in the next one on the same connection, and on another', async () => {
    const single = singleConnectionAppClient();
    try {
      const copied = await withTenant(single, tenantA, async (tx) => {
        const [raw] = await tx.$queryRaw<
          { v: string }[]
        >`SELECT current_setting('app.context') AS v`;
        return raw!.v;
      });
      await expect(
        single.$transaction(async (tx) => {
          await setContext(tx, copied);
          return tx.student.count();
        }),
      ).rejects.toThrow(INVALID);
      await expect(
        app.$transaction(async (tx) => {
          await setContext(tx, copied);
          return tx.student.count();
        }),
      ).rejects.toThrow(INVALID);
    } finally {
      await single.$disconnect();
    }
  });

  it('a refused context never shows rows first: the statement fails before reading', async () => {
    // Policies check the context once per statement (an InitPlan), before any row.
    await expect(
      app.$transaction(async (tx) => {
        await setContext(tx, 'v1:::1:1:' + '0'.repeat(64));
        return tx.$queryRaw`SELECT id FROM students`;
      }),
    ).rejects.toThrow(INVALID);
  });
});

describe('a key the database no longer has', () => {
  it('withContext notices it (the fingerprint) and loads the key again, once', async () => {
    const app = appClient();
    const owner = ownerClient();
    const real = await loadRequestContextKeyAsOwner(owner);
    const loads: string[] = [];
    // First a key that is not the database's (as after a reset under a running API), then the
    // real one.
    setRequestContextKeySource(async () => {
      loads.push(loads.length === 0 ? 'stale' : 'real');
      return loads.length === 1 ? randomBytes(48) : real;
    });
    try {
      const tenantId = (await createTenant(app)).id;
      expect(await withTenant(app, tenantId, (tx) => tx.tenant.count())).toBe(1);
      expect(await withTenant(app, tenantId, (tx) => tx.tenant.count())).toBe(1);
      expect(loads).toEqual(['stale', 'real']);
    } finally {
      setRequestContextKeySource(() => Promise.resolve(real));
      await Promise.all([app.$disconnect(), owner.$disconnect()]);
    }
  });

  it('when the reloaded key does not match either, the transaction fails before running', async () => {
    const app = appClient();
    const owner = ownerClient();
    const real = await loadRequestContextKeyAsOwner(owner);
    const tenantId = (await createTenant(app)).id;
    setRequestContextKeySource(async () => randomBytes(48));
    let ran = false;
    try {
      await expect(
        withTenant(app, tenantId, async () => {
          ran = true;
        }),
      ).rejects.toThrow(/not the one this process can read/);
      expect(ran).toBe(false);
    } finally {
      setRequestContextKeySource(() => Promise.resolve(real));
      await Promise.all([app.$disconnect(), owner.$disconnect()]);
    }
  });
});

describe('who may read the key', () => {
  let owner: PrismaClient;
  let login: PrismaClient;
  let clients: [string, PrismaClient][];

  beforeAll(() => {
    owner = ownerClient();
    login = loginClient();
    clients = [
      ['jantrik_app', appClient()],
      ['jantrik_platform_app', platformClient()],
      ['jantrik_ingest_app', ingestClient()],
    ];
  });

  afterAll(async () => {
    await Promise.all([owner, login, ...clients.map(([, c]) => c)].map((c) => c.$disconnect()));
  });

  it('the runtime logins can neither read the table nor run auth_context_key()', async () => {
    for (const [name, client] of clients) {
      await expect(client.$queryRaw`SELECT key FROM app_context_key`, name).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.$queryRaw`SELECT auth_context_key()`, name).rejects.toThrow(
        /permission denied/,
      );
    }
    await expect(login.$queryRaw`SELECT key FROM app_context_key`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the password-login login reads it through auth_context_key(), the owner from the table: the same key', async () => {
    const viaLogin = await loadRequestContextKey(login);
    const viaOwner = await loadRequestContextKeyAsOwner(owner);
    expect(viaLogin.length).toBe(48);
    expect(viaLogin.equals(viaOwner)).toBe(true);
    expect(viaLogin.equals(await requestContextKey())).toBe(true);
  });

  it('the app login may read the key fingerprint, which matches requestContextKeyId()', async () => {
    const app = appClient();
    try {
      const [row] = await app.$queryRaw<{ id: string }[]>`SELECT app_context_key_id() AS id`;
      expect(row?.id).toBe(requestContextKeyId(await loadRequestContextKeyAsOwner(owner)));
      expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await app.$disconnect();
    }
  });

  it('rotation is one UPDATE of the key: the trigger derives both HMAC pads from it', async () => {
    class Rollback extends Error {}
    const next = randomBytes(48);
    let seen: { mac: string } | undefined;
    try {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE app_context_key SET key = ${next}, created_at = now() WHERE id = 1`;
        [seen] = await tx.$queryRaw<{ mac: string }[]>`
          SELECT encode(sha256(k.outer_pad || sha256(k.inner_pad || convert_to('probe', 'UTF8'))), 'hex') AS mac
          FROM app_context_key k WHERE k.id = 1`;
        throw new Rollback(); // never commit a new key in the shared test database
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(seen?.mac).toBe(createHmac('sha256', next).update('probe').digest('hex'));
    await expect(
      owner.$executeRaw`UPDATE app_context_key SET key = ${randomBytes(16)} WHERE id = 1`,
    ).rejects.toThrow(/48 bytes/);
  });

  it('the privileges, exactly', async () => {
    const rows = await owner.$queryRaw<{ login: string; tbl: boolean; fn: boolean }[]>`
      SELECT r.rolname AS login,
             has_table_privilege(r.rolname, 'public.app_context_key', 'SELECT') AS tbl,
             has_function_privilege(r.rolname, 'public.auth_context_key()', 'EXECUTE') AS fn
      FROM pg_roles r
      WHERE r.rolname IN ('jantrik_app', 'jantrik_platform_app', 'jantrik_ingest_app',
                          'jantrik_login_app', 'jantrik_auth')
      ORDER BY 1`;
    expect(rows).toEqual([
      { login: 'jantrik_app', tbl: false, fn: false },
      { login: 'jantrik_auth', tbl: true, fn: true }, // owns the two functions
      { login: 'jantrik_ingest_app', tbl: false, fn: false },
      { login: 'jantrik_login_app', tbl: false, fn: true },
      { login: 'jantrik_platform_app', tbl: false, fn: false },
    ]);
  });
});
