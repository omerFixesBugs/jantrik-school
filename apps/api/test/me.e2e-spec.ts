import { withContext } from '@jantrik/db';
import type { MeContext } from '@jantrik/shared';
import { provisionTenant } from '@jantrik/db';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';

describe('/me and tenant-switch safety', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('GET /me/context for a school: labels, modules, roles, current year', async () => {
    const t = await createTenant(h, { modules: ['ATTENDANCE'] });
    const login = await otpLogin(h, (await addMember(h, t.id, { roles: ['ADMIN'] })).phone);
    const res = await http(h).get('/me/context').set(bearer(login.accessToken)).expect(200);
    const ctx = res.body as MeContext;
    expect(ctx.tenant).toMatchObject({
      id: t.id,
      slug: t.slug,
      instituteType: { key: 'NCTB_SCHOOL_BN' },
    });
    expect(ctx.labels['section']).toEqual({ bn: 'শাখা', en: 'Section' });
    expect(ctx.modules.sort()).toEqual(['ATTENDANCE', 'CORE']);
    expect(ctx.roles).toEqual(['ADMIN']);
    expect(ctx.academicYear).toMatchObject({
      name: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('GET /me/context for a coaching centre says "Batch"', async () => {
    const t = await provisionTenant(h.prisma, {
      slug: `c-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Coaching',
      instituteTypeKey: 'COACHING',
      status: 'ACTIVE',
    });
    const login = await otpLogin(h, (await addMember(h, t.id, { roles: ['OWNER'] })).phone);
    const ctx = (await http(h).get('/me/context').set(bearer(login.accessToken)).expect(200))
      .body as MeContext;
    expect(ctx.labels['section']).toEqual({ bn: 'ব্যাচ', en: 'Batch' });
    expect(ctx.academicYear).toBeNull();
  });

  it('GET /me/context without a selected tenant → 403', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const phone = randomPhone();
    await addMember(h, a.id, { phone });
    await addMember(h, b.id, { phone });
    const login = await otpLogin(h, phone);
    await http(h).get('/me/context').set(bearer(login.accessToken)).expect(403);
  });

  it('PATCH /me/preferences stores the locale on the user', async () => {
    const t = await createTenant(h);
    const { phone, userId } = await addMember(h, t.id);
    const login = await otpLogin(h, phone);
    await http(h)
      .patch('/me/preferences')
      .set(bearer(login.accessToken))
      .send({ locale: 'en' })
      .expect(204);
    const user = await withContext(h.prisma, { userId }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.locale).toBe('en');
    await http(h)
      .patch('/me/preferences')
      .set(bearer(login.accessToken))
      .send({ locale: 'fr' })
      .expect(400);
  });

  describe('X-Jantrik-Tenant', () => {
    it('matching header passes; a different tenant → 409 TENANT_MISMATCH', async () => {
      const a = await createTenant(h);
      const b = await createTenant(h);
      const phone = randomPhone();
      await addMember(h, a.id, { phone, roles: ['ADMIN'] });
      await addMember(h, b.id, { phone, roles: ['ADMIN'] });
      const login = await otpLogin(h, phone);
      const tokenA = (
        await http(h)
          .post('/auth/switch-tenant')
          .set(bearer(login.accessToken))
          .send({ tenantId: a.id })
          .expect(200)
      ).body.accessToken as string;

      await http(h).get('/students').set(bearer(tokenA)).set('X-Jantrik-Tenant', a.id).expect(200);

      // The page was loaded for B, but the session was switched to A in another tab.
      const res = await http(h)
        .get('/students')
        .set(bearer(tokenA))
        .set('X-Jantrik-Tenant', b.id)
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, code: 'TENANT_MISMATCH' });
      await http(h)
        .get('/me/context')
        .set(bearer(tokenA))
        .set('X-Jantrik-Tenant', b.id)
        .expect(409);
    });

    it('a token without a tenant does not match any header', async () => {
      const a = await createTenant(h);
      const b = await createTenant(h);
      const phone = randomPhone();
      await addMember(h, a.id, { phone });
      await addMember(h, b.id, { phone });
      const login = await otpLogin(h, phone); // no tenant selected
      await http(h)
        .get('/students')
        .set(bearer(login.accessToken))
        .set('X-Jantrik-Tenant', a.id)
        .expect(409);
    });

    it('account routes (/auth/*) are not checked, so logout always works', async () => {
      const a = await createTenant(h);
      const login = await otpLogin(h, (await addMember(h, a.id)).phone);
      const other = crypto.randomUUID();
      await http(h)
        .get('/auth/me')
        .set(bearer(login.accessToken))
        .set('X-Jantrik-Tenant', other)
        .expect(200);
      await http(h)
        .post('/auth/logout')
        .set(bearer(login.accessToken))
        .set('X-Jantrik-Tenant', other)
        .expect(204);
    });

    it('requests without the header (mobile clients) are not checked', async () => {
      const a = await createTenant(h);
      const login = await otpLogin(h, (await addMember(h, a.id, { roles: ['TEACHER'] })).phone);
      await http(h).get('/students').set(bearer(login.accessToken)).expect(200);
    });
  });
});
