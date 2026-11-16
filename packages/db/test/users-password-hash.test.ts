import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, loginClient, ownerClient, randomPhone } from './helpers.js';

// P1-J: the app login (jantrik_app) never reads a password hash, its own or anyone's. Only the
// password login's own login (jantrik_login_app) may look one up, through one function
// (docs/database.md → users).

describe('users.password_hash is out of the app login’s reach (P1-J)', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let login: PrismaClient;
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
    login = loginClient();
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
    await Promise.all([app.$disconnect(), owner.$disconnect(), login.$disconnect()]);
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

  it('the app’s login lookup returns who the person is, no password data', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM auth_find_user_for_login(${staff.phone}, NULL)`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'locale', 'name']);
    expect(rows[0]!['id']).toBe(staff.id);
  });

  it('the app login may not run the password lookup', async () => {
    await expect(
      app.$queryRaw`SELECT * FROM auth_find_user_for_password_login(${staff.phone}, NULL)`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('the login login gets the hash for a phone or an email, and nothing for anyone else', async () => {
    const byPhone = await login.$queryRaw<{ id: string; password_hash: string | null }[]>`
      SELECT id::text, password_hash FROM auth_find_user_for_password_login(${staff.phone}, NULL)`;
    expect(byPhone).toEqual([{ id: staff.id, password_hash: staff.hash }]);
    const none = await login.$queryRaw<{ password_hash: string | null }[]>`
      SELECT password_hash FROM auth_find_user_for_password_login(${noPassword.phone}, NULL)`;
    expect(none).toEqual([{ password_hash: null }]);
    expect(
      await login.$queryRaw<unknown[]>`
        SELECT * FROM auth_find_user_for_password_login(${randomPhone()}, NULL)`,
    ).toEqual([]);
  });

  it('the login login reads no table and runs no other function', async () => {
    await expect(login.$queryRaw`SELECT id FROM users LIMIT 1`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      login.$queryRaw`SELECT * FROM auth_find_user_for_login(${staff.phone}, NULL)`,
    ).rejects.toThrow(/permission denied/i);
    await expect(login.$queryRaw`SELECT auth_my_password_is_set()`).rejects.toThrow(
      /permission denied/i,
    );
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

  it('every Prisma client leaves the hash out, so whole-row reads and updates work', async () => {
    const read = await withContext(app, { userId: staff.id }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: staff.id } }),
    );
    expect(read.id).toBe(staff.id);
    expect('passwordHash' in read).toBe(false);
    const updated = await withContext(app, { userId: staff.id }, (tx) =>
      tx.user.update({ where: { id: staff.id }, data: { locale: 'en' } }),
    );
    expect(updated.locale).toBe('en');
    expect('passwordHash' in updated).toBe(false);
    // The owner asks for it explicitly on one query.
    const withHash = await withContext(owner, { userId: staff.id }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: staff.id }, omit: { passwordHash: false } }),
    );
    expect(withHash.passwordHash).toBe(staff.hash);
  });
});
