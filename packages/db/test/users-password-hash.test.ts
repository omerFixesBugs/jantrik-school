import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, ownerClient, randomPhone } from './helpers.js';

// P1-J: the app login (jantrik_app) never reads a password hash, its own or anyone's. The
// login gets the hash's parameters and salt, and the database compares (docs/database.md → users).

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
/** The PHC string up to its last `$`: algorithm, version, parameters and salt, no digest. */
const paramsOf = (phc: string): string => phc.slice(0, phc.lastIndexOf('$'));
const NIL = '00000000-0000-0000-0000-000000000000';

describe('users.password_hash is out of the app login’s reach (P1-J)', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let tenantId: string;
  let staff: { id: string; phone: string; hash: string };
  let coMember: { id: string; phone: string };
  let noPassword: { id: string; phone: string };

  /** Sets the user's own hash as that user (the app login keeps UPDATE on the column). */
  const setOwnHash = (userId: string, passwordHash: string | null) =>
    withContext(app, { userId }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash }, select: { id: true } }),
    );

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    tenantId = (await createTenant(app)).id;
    const make = (role: 'ADMIN' | 'TEACHER') => {
      const phone = randomPhone();
      return withTenant(app, tenantId, async (tx) => {
        const id = await findOrCreateUser(tx, phone, `Person ${role}`);
        await tx.membership.create({ data: { tenantId, userId: id, role } });
        return { id, phone };
      });
    };
    const s = await make('ADMIN');
    staff = { ...s, hash: await hash('a long enough password') };
    await setOwnHash(staff.id, staff.hash);
    coMember = await make('TEACHER');
    await setOwnHash(coMember.id, await hash('another long password'));
    noPassword = await make('TEACHER');
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('cannot select password_hash: not its own, not a co-member’s, not with SELECT *', async () => {
    await expect(
      withContext(
        app,
        { userId: staff.id },
        (tx) => tx.$queryRaw`SELECT password_hash FROM users WHERE id = ${staff.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withContext(
        app,
        { tenantId, userId: coMember.id },
        (tx) => tx.$queryRaw`SELECT password_hash FROM users WHERE id = ${staff.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withContext(app, { userId: staff.id }, (tx) => tx.$queryRaw`SELECT * FROM users`),
    ).rejects.toThrow(/permission denied/i);
    // Not in a filter either (a WHERE on the column needs SELECT on it).
    await expect(
      withContext(
        app,
        { tenantId, userId: coMember.id },
        (tx) => tx.$queryRaw`SELECT id FROM users WHERE password_hash LIKE '$argon2id$%'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('every other column stays readable', async () => {
    const rows = await withContext(
      app,
      { tenantId, userId: coMember.id },
      (tx) => tx.$queryRaw<{ id: string }[]>`
        SELECT id::text, phone, email, name, name_bn, password_changed_at, locale, color_scheme,
               created_at, updated_at
        FROM users WHERE id = ${staff.id}::uuid`,
    );
    expect(rows.map((r) => r.id)).toEqual([staff.id]);
  });

  it('the login lookup returns the parameters and salt, never the digest', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM auth_find_user_for_login(${staff.phone}, NULL)`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'locale', 'name', 'password_params']);
    expect(rows[0]!['password_params']).toBe(paramsOf(staff.hash));
    expect(staff.hash.startsWith(`${paramsOf(staff.hash)}$`)).toBe(true);
  });

  it('no parameters for a user without a password or with a hash in another format', async () => {
    const paramsFor = async (phone: string) =>
      (
        await app.$queryRaw<{ password_params: string | null }[]>`
          SELECT password_params FROM auth_find_user_for_login(${phone}, NULL)`
      )[0]?.password_params;
    expect(await paramsFor(noPassword.phone)).toBeNull();

    const odd = randomPhone();
    const oddId = await withTenant(app, tenantId, async (tx) => {
      const id = await findOrCreateUser(tx, odd, 'Odd Hash');
      await tx.membership.create({ data: { tenantId, userId: id, role: 'STAFF' } });
      return id;
    });
    const good = await hash('a long enough password');
    for (const stored of [
      'not-a-real-hash',
      good.replace('$argon2id$', '$argon2i$'),
      good.replace('$v=19$', '$v=16$'),
      `${paramsOf(good)}$AAAA`, // a digest that is not 32 bytes
      `${good}$extra`,
    ]) {
      await setOwnHash(oddId, stored);
      expect(await paramsFor(odd), stored).toBeNull();
    }
  });

  it('auth_my_password_matches compares inside the database, for the current user only', async () => {
    const matches = (userId: string | null, digest: Buffer) =>
      withContext(
        app,
        userId ? { userId } : {},
        async (tx) =>
          (
            await tx.$queryRaw<{ ok: boolean }[]>`
              SELECT auth_my_password_matches(${digest}) AS ok`
          )[0]!.ok,
      );
    expect(await matches(staff.id, sha256(staff.hash))).toBe(true);
    expect(await matches(staff.id, sha256(`${staff.hash}x`))).toBe(false);
    expect(await matches(coMember.id, sha256(staff.hash))).toBe(false);
    expect(await matches(noPassword.id, sha256(staff.hash))).toBe(false);
    expect(await matches(NIL, sha256(staff.hash))).toBe(false);
    expect(await matches(null, sha256(staff.hash))).toBe(false);
  });

  it('auth_my_password_is_set says whether the current user has a password', async () => {
    const isSet = (userId: string | null) =>
      withContext(
        app,
        userId ? { userId } : {},
        async (tx) =>
          (await tx.$queryRaw<{ set: boolean }[]>`SELECT auth_my_password_is_set() AS set`)[0]!.set,
      );
    expect(await isSet(staff.id)).toBe(true);
    expect(await isSet(noPassword.id)).toBe(false);
    expect(await isSet(null)).toBe(false);
  });

  it('the app login still writes its own hash; the owner reads it as that user', async () => {
    const next = await hash('a third long password');
    await setOwnHash(coMember.id, next);
    const row = await withContext(owner, { userId: coMember.id }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: coMember.id }, select: { passwordHash: true } }),
    );
    expect(row.passwordHash).toBe(next);
  });
});
