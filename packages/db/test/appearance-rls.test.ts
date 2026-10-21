import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

// appearance_settings: tenant RLS, no DELETE grant, the accent format CHECK; the institute types'
// default themes and users.color_scheme (SYSTEM for everyone until they choose).
describe('appearance settings', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let c: string;

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    c = (await createTenant(app)).id;
    await withTenant(app, a, (tx) =>
      tx.appearanceSettings.create({ data: { tenantId: a, preset: 'MADRASA', accent: '#166534' } }),
    );
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another tenant cannot read, change or write A's row", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.appearanceSettings.findMany()).toEqual([]);
      expect((await tx.appearanceSettings.updateMany({ data: { accent: null } })).count).toBe(0);
    });
    // Writing a row for another tenant (one with no row yet, so only the policy can refuse it).
    await expect(
      withTenant(app, b, (tx) =>
        tx.appearanceSettings.create({ data: { tenantId: c, preset: 'COACHING' } }),
      ),
    ).rejects.toThrow();
    expect(await withTenant(app, c, (tx) => tx.appearanceSettings.findMany())).toEqual([]);
    const row = await withTenant(app, a, (tx) => tx.appearanceSettings.findFirstOrThrow());
    expect(row).toMatchObject({ preset: 'MADRASA', accent: '#166534' });
  });

  it('never deleted by the app; the accent must be a lower-case #rrggbb', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM appearance_settings`),
    ).rejects.toThrow(/permission denied/);
    for (const accent of ['#ABCDEF', 'red', '#12345g']) {
      await expect(
        withTenant(app, b, (tx) => tx.appearanceSettings.create({ data: { tenantId: b, accent } })),
      ).rejects.toThrow();
    }
  });

  it('each institute type has its default theme; people start on SYSTEM', async () => {
    const types = await app.instituteType.findMany({ select: { key: true, defaultTheme: true } });
    const byKey = Object.fromEntries(types.map((t) => [t.key, t.defaultTheme]));
    expect(byKey).toMatchObject({
      NCTB_SCHOOL_BN: 'SCHOOL',
      NCTB_SCHOOL_EN: 'ENGLISH_MEDIUM',
      COACHING: 'COACHING',
    });
    const column = await app.$queryRaw<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'color_scheme'`;
    expect(column[0]?.column_default).toContain('SYSTEM');
  });
});
