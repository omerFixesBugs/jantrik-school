import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createStudent, createTenant, ownerClient, randomPhone } from './helpers.js';

// P1-J8: an SQL injection in an ordinary request (it runs as jantrik_app inside the request's
// transaction, with the attacker's own context) must not be able to become another person or
// enter another institute by changing the old settings app.user_id / app.tenant_id with
// set_config. Before the verified context these attacks worked (run on integration/sprint-1, every
// test below but the "own" ones failed).

async function addMember(app: PrismaClient, tenantId: string, name: string) {
  return withTenant(app, tenantId, async (tx) => {
    const userId = await findOrCreateUser(tx, randomPhone(), name);
    await tx.membership.create({ data: { tenantId, userId, role: 'TEACHER' } });
    return userId;
  });
}

describe('P1-J8: an injection cannot take over another account or institute', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  let attacker: string; // teacher in A
  let victim: string; // teacher in B
  let victimSession: string;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    tenantA = (await createTenant(app)).id;
    tenantB = (await createTenant(app)).id;
    attacker = await addMember(app, tenantA, 'Attacker');
    victim = await addMember(app, tenantB, 'Victim');
    await createStudent(app, tenantB, 'VICTIM-1');
    victimSession = await withContext(app, { userId: victim }, async (tx) => {
      const session = await tx.session.create({
        data: { userId: victim, client: 'WEB', expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await tx.refreshToken.create({
        data: {
          userId: victim,
          sessionId: session.id,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return session.id;
    });
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  });

  /** Run `inject` as the attacker's request would: their own context, then the injected SQL. */
  const asAttacker = <T>(
    inject: (tx: Parameters<Parameters<typeof withContext>[2]>[0]) => Promise<T>,
  ) =>
    withContext(app, { tenantId: tenantA, userId: attacker }, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${victim}, true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return inject(tx);
    });

  it("cannot set the victim's password hash", async () => {
    const updated = await asAttacker(
      (tx) =>
        tx.$executeRaw`UPDATE users SET password_hash = '$argon2id$v=19$m=19456,t=2,p=1$attacker'
                       WHERE id = ${victim}::uuid`,
    );
    expect(updated).toBe(0);
    const row = await withContext(owner, { userId: victim }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: victim }, omit: { passwordHash: false } }),
    );
    expect(row.passwordHash).toBeNull();
  });

  it('cannot insert a session or a refresh token for the victim', async () => {
    await expect(
      asAttacker(
        (tx) =>
          tx.$executeRaw`INSERT INTO sessions (id, user_id, client, expires_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${victim}::uuid, 'WEB', now() + interval '1 day', now())`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asAttacker(
        (tx) =>
          tx.$executeRaw`INSERT INTO refresh_tokens (id, user_id, session_id, token_hash, expires_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${victim}::uuid, ${victimSession}::uuid,
                                 ${randomBytes(32).toString('hex')}, now() + interval '1 day', now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot extend, re-point or read the victim's sessions and refresh tokens", async () => {
    const extended = await asAttacker(
      (tx) =>
        tx.$executeRaw`UPDATE sessions SET expires_at = now() + interval '1 year'
                       WHERE id = ${victimSession}::uuid`,
    );
    expect(extended).toBe(0);
    const repointed = await asAttacker(
      (tx) =>
        tx.$executeRaw`UPDATE refresh_tokens SET token_hash = ${randomBytes(32).toString('hex')}
                       WHERE user_id = ${victim}::uuid`,
    );
    expect(repointed).toBe(0);
    const hashes = await asAttacker(
      (tx) =>
        tx.$queryRaw<{ token_hash: string }[]>`SELECT token_hash FROM refresh_tokens
                                                WHERE user_id = ${victim}::uuid`,
    );
    expect(hashes).toEqual([]);
  });

  it("cannot read or write the other institute's rows", async () => {
    const students = await asAttacker(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT id FROM students WHERE tenant_id = ${tenantB}::uuid`,
    );
    expect(students).toEqual([]);
    const renamed = await asAttacker(
      (tx) =>
        tx.$executeRaw`UPDATE students SET name_en = 'taken' WHERE tenant_id = ${tenantB}::uuid`,
    );
    expect(renamed).toBe(0);
  });

  it('cannot make itself OWNER of the other institute', async () => {
    await expect(
      asAttacker(
        (tx) =>
          tx.$executeRaw`INSERT INTO memberships (id, tenant_id, user_id, role, status, updated_at)
                         VALUES (${randomUUID()}::uuid, ${tenantB}::uuid, ${attacker}::uuid,
                                 'OWNER', 'ACTIVE', now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot learn whether the victim has a password (P1-J2)', async () => {
    // The function answers for the verified person, the attacker, whatever app.user_id says. A
    // person of its own (no earlier attack in this file touched them), without a password.
    const quiet = await addMember(app, tenantB, 'No password');
    await withContext(app, { userId: attacker }, (tx) =>
      tx.user.update({ where: { id: attacker }, data: { passwordHash: 'not-a-real-hash' } }),
    );
    const [row] = await withContext(app, { tenantId: tenantA, userId: attacker }, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${quiet}, true)`;
      return tx.$queryRaw<{ set: boolean }[]>`SELECT auth_my_password_is_set() AS set`;
    });
    expect(row?.set).toBe(true);
  });

  it('cannot plant a temporary view for the next request on the same connection (no TEMP)', async () => {
    // A temp view named like a table would be found before public.tenants (pg_temp is searched
    // first for relations) by a later request on this pooled connection, someone else's, inside
    // their signed context (P1-J8 review). The runtime login may not create temporary objects.
    await expect(
      asAttacker((tx) =>
        tx.$executeRawUnsafe('CREATE TEMP VIEW tenants AS SELECT t.* FROM public.tenants t'),
      ),
    ).rejects.toThrow(/permission denied to create temporary tables/);
    await expect(
      asAttacker((tx) =>
        tx.$executeRawUnsafe(
          'CREATE FUNCTION pg_temp.plant() RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$',
        ),
      ),
    ).rejects.toThrow(/permission denied to create temporary tables/);
  });

  it('cannot make the import worker act as a colleague (student_imports.created_by_id)', async () => {
    // The import job signs its context as the import's creator, read from the row.
    const colleague = await addMember(app, tenantA, 'Colleague');
    await expect(
      asAttacker(
        (tx) =>
          tx.$executeRaw`INSERT INTO student_imports (id, tenant_id, created_by_id, file_name, headers,
                                                         row_count, updated_at)
                         VALUES (${randomUUID()}::uuid, ${tenantA}::uuid, ${colleague}::uuid, 'x.xlsx',
                                 '[]'::jsonb, 0, now())`,
      ),
    ).rejects.toThrow(/created by the signed-in person only/);
    // Its own import, then re-pointed at the colleague: the column is not updatable.
    const own = randomUUID();
    await withContext(app, { tenantId: tenantA, userId: attacker }, (tx) =>
      tx.studentImport.create({
        data: {
          id: own,
          tenantId: tenantA,
          createdById: attacker,
          fileName: 'x.xlsx',
          headers: [],
          rowCount: 0,
        },
      }),
    );
    await expect(
      asAttacker(
        (tx) =>
          tx.$executeRaw`UPDATE student_imports SET created_by_id = ${colleague}::uuid WHERE id = ${own}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('the attacker still has its own context (the attacks were refused, not the request)', async () => {
    const own = await asAttacker(
      (tx) => tx.$queryRaw<{ me: string | null; at: string | null }[]>`
        SELECT app_current_user_id()::text AS me, app_current_tenant_id()::text AS at`,
    );
    expect(own).toEqual([{ me: attacker, at: tenantA }]);
  });
});
