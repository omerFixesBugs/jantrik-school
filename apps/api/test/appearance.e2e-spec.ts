import { provisionTenant, withTenant } from '@jantrik/db';
import type { Appearance, MeContext } from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';

// The institute theme (docs/design.md → Themes): the type's default until the owner chooses;
// PUT /settings/appearance is the owner's alone and audited; every member reads it through
// /me/context. And each person's light/dark choice (SYSTEM until they choose).
describe('appearance', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(() => h.close());

  const typed = (instituteTypeKey: string) =>
    provisionTenant(h.prisma, {
      slug: `a-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Appearance',
      instituteTypeKey,
      status: 'ACTIVE',
    });
  const context = async (token: string) =>
    (await http(h).get('/me/context').set(bearer(token)).expect(200)).body as MeContext;
  const login = async (tenantId: string, role: 'OWNER' | 'ADMIN' | 'TEACHER' | 'GUARDIAN') =>
    (await otpLogin(h, (await addMember(h, tenantId, { roles: [role] })).phone)).accessToken;

  it.each([
    ['NCTB_SCHOOL_BN', 'SCHOOL'],
    ['NCTB_SCHOOL_EN', 'ENGLISH_MEDIUM'],
    ['COACHING', 'COACHING'],
  ])('a %s institute starts on the %s theme', async (type, preset) => {
    const t = await typed(type);
    const ctx = await context(await login(t.id, 'TEACHER'));
    expect(ctx.appearance).toEqual({ preset, accent: null, typeDefault: preset, chosen: false });
  });

  it('the owner picks a preset and an accent; everyone sees it; another institute does not', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const owner = await login(a.id, 'OWNER');
    const teacher = await login(a.id, 'TEACHER');
    const res = await http(h)
      .put('/settings/appearance')
      .set(bearer(owner))
      .send({ preset: 'MADRASA', accent: '#B45309' })
      .expect(200);
    const saved: Appearance = {
      preset: 'MADRASA',
      accent: '#b45309',
      typeDefault: 'SCHOOL',
      chosen: true,
    };
    expect(res.body).toEqual(saved);
    expect((await context(teacher)).appearance).toEqual(saved);
    expect((await context(await login(b.id, 'OWNER'))).appearance.preset).toBe('SCHOOL');

    // Back to the institute type's default and the preset's own accent.
    const reset = await http(h)
      .put('/settings/appearance')
      .set(bearer(owner))
      .send({ preset: null, accent: null })
      .expect(200);
    expect(reset.body).toEqual({
      preset: 'SCHOOL',
      accent: null,
      typeDefault: 'SCHOOL',
      chosen: false,
    });
    // Saving what is already there changes nothing and is not audited.
    await http(h)
      .put('/settings/appearance')
      .set(bearer(owner))
      .send({ preset: null, accent: null })
      .expect(200);

    const audit = await withTenant(h.prisma, a.id, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'appearance_settings' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((r) => [r.action, r.oldValues, r.newValues])).toEqual([
      ['CREATE', { preset: null, accent: null }, { preset: 'MADRASA', accent: '#b45309' }],
      ['UPDATE', { preset: 'MADRASA', accent: '#b45309' }, { preset: null, accent: null }],
    ]);
  });

  it('only the owner changes it; bad presets and colours are refused', async () => {
    const t = await createTenant(h);
    for (const role of ['ADMIN', 'TEACHER', 'GUARDIAN'] as const) {
      const token = await login(t.id, role);
      await http(h)
        .put('/settings/appearance')
        .set(bearer(token))
        .send({ preset: 'COACHING', accent: null })
        .expect(403);
    }
    const owner = await login(t.id, 'OWNER');
    for (const body of [
      { preset: 'PINK', accent: null },
      { preset: 'SCHOOL', accent: 'red' },
      { preset: 'SCHOOL', accent: '#12345' },
      { preset: 'SCHOOL' },
    ]) {
      await http(h).put('/settings/appearance').set(bearer(owner)).send(body).expect(400);
    }
  });

  it("a person's light/dark choice: SYSTEM by default, kept on the account", async () => {
    const t = await createTenant(h);
    const { phone } = await addMember(h, t.id, { roles: ['TEACHER'] });
    const first = await otpLogin(h, phone);
    expect(first.user.colorScheme).toBe('SYSTEM');
    await http(h)
      .patch('/me/preferences')
      .set(bearer(first.accessToken))
      .send({ colorScheme: 'DARK' })
      .expect(204);
    // Stored on the account (every new session and /auth/me carry it).
    const me = await http(h).get('/auth/me').set(bearer(first.accessToken)).expect(200);
    expect((me.body as { user: { colorScheme: string } }).user.colorScheme).toBe('DARK');
    await http(h)
      .patch('/me/preferences')
      .set(bearer(first.accessToken))
      .send({ colorScheme: 'DIM' })
      .expect(400);
    await http(h).patch('/me/preferences').set(bearer(first.accessToken)).send({}).expect(400);
  });
});
