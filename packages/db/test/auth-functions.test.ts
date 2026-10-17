import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

const FUNCTIONS = [
  'auth_find_user_for_login',
  'auth_list_my_memberships',
  'auth_resolve_tenant',
  'auth_find_refresh_token',
  'app_find_or_create_user',
];

describe('auth SECURITY DEFINER functions', () => {
  let app: PrismaClient;
  let tenant: { id: string; slug: string };
  let otherTenant: { id: string; slug: string };
  let userId: string;
  let phone: string;

  beforeAll(async () => {
    app = appClient();
    tenant = await createTenant(app);
    otherTenant = await createTenant(app, { instituteTypeKey: 'COACHING' });
    phone = randomPhone();
    userId = await withTenant(app, tenant.id, async (tx) => {
      const id = await findOrCreateUser(tx, phone, 'Login User');
      await tx.membership.create({ data: { tenantId: tenant.id, userId: id, role: 'ADMIN' } });
      return id;
    });
    await withTenant(app, otherTenant.id, async (tx) => {
      await findOrCreateUser(tx, phone, 'Login User');
      await tx.membership.create({ data: { tenantId: otherTenant.id, userId, role: 'TEACHER' } });
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('auth_find_user_for_login works without any context', async () => {
    const rows = await app.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM auth_find_user_for_login(${phone}, NULL)`;
    expect(rows).toEqual([{ id: userId }]);
    const none = await app.$queryRaw<unknown[]>`
      SELECT * FROM auth_find_user_for_login(${randomPhone()}, NULL)`;
    expect(none).toEqual([]);
  });

  it('auth_list_my_memberships lists the current user across tenants, and nothing without one', async () => {
    const rows = await withContext(
      app,
      { userId },
      (tx) =>
        tx.$queryRaw<{ tenant_slug: string; role: string }[]>`
        SELECT tenant_slug, role::text FROM auth_list_my_memberships()`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenant_slug: tenant.slug, role: 'ADMIN' },
        { tenant_slug: otherTenant.slug, role: 'TEACHER' },
      ]),
    );
    expect(await app.$queryRaw<unknown[]>`SELECT * FROM auth_list_my_memberships()`).toEqual([]);
  });

  it('auth_resolve_tenant resolves a slug without context', async () => {
    const rows = await app.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM auth_resolve_tenant(${tenant.slug})`;
    expect(rows).toEqual([{ id: tenant.id }]);
  });

  it('are SECURITY DEFINER, owned by jantrik_auth, pin search_path, and only jantrik_app may run them', async () => {
    const rows = await app.$queryRaw<
      {
        name: string;
        definer: boolean;
        owner: string;
        config: string[] | null;
        public_exec: boolean;
        app_exec: boolean;
      }[]
    >`
      SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
             p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
             has_function_privilege('jantrik_app', p.oid, 'EXECUTE') AS app_exec
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(${FUNCTIONS})`;

    expect(rows).toHaveLength(FUNCTIONS.length);
    for (const r of rows) {
      expect(r).toMatchObject({
        definer: true,
        owner: 'jantrik_auth',
        public_exec: false,
        app_exec: true,
      });
      expect(r.config).toContain('search_path=pg_catalog, public');
    }
  });

  it('the schema owner does not inherit jantrik_auth (would bypass FORCE RLS)', async () => {
    const rows = await app.$queryRaw<{ inherit: boolean }[]>`
      SELECT a.inherit_option AS inherit
      FROM pg_auth_members a
      WHERE a.roleid = 'jantrik_auth'::regrole AND a.member = 'jantrik_owner'::regrole`;
    expect(rows).toEqual([{ inherit: false }]);
  });

  it('sessions are visible only to their user', async () => {
    const sessionId = await withContext(app, { userId }, async (tx) => {
      const s = await tx.session.create({
        data: { userId, client: 'MOBILE', expiresAt: new Date(Date.now() + 60_000) },
      });
      return s.id;
    });
    expect(
      await withContext(app, { userId }, (tx) => tx.session.count({ where: { id: sessionId } })),
    ).toBe(1);
    expect(await withTenant(app, tenant.id, (tx) => tx.session.count())).toBe(0);
    expect(await app.session.count()).toBe(0);
  });
});
