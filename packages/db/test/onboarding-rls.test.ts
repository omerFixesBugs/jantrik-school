import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

// onboarding_progress (step 8, part 5): tenant RLS, one row per institute, no DELETE, CHECKs.
describe('onboarding_progress', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let rowId: string;

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    rowId = await withTenant(app, a, async (tx) => {
      const row = await tx.onboardingProgress.create({ data: { tenantId: a } });
      return row.id;
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('starts with no step answered and not finished', async () => {
    const row = await withTenant(app, a, (tx) =>
      tx.onboardingProgress.findUniqueOrThrow({ where: { id: rowId } }),
    );
    expect(row.steps).toEqual({});
    expect(row.completedAt).toBeNull();
  });

  it("another institute cannot see, change or claim A's row", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.onboardingProgress.findMany()).toEqual([]);
      expect(
        (
          await tx.onboardingProgress.updateMany({
            where: { id: rowId },
            data: { completedAt: new Date() },
          })
        ).count,
      ).toBe(0);
      expect(await tx.$executeRaw`UPDATE onboarding_progress SET steps = '{}'`).toBe(0);
    });
    await expect(
      withTenant(app, b, (tx) => tx.onboardingProgress.create({ data: { tenantId: a } })),
    ).rejects.toThrow(/row-level security/i);
    const row = await withTenant(app, a, (tx) =>
      tx.onboardingProgress.findUniqueOrThrow({ where: { id: rowId } }),
    );
    expect(row.completedAt).toBeNull();
  });

  it('one row per institute, and the app cannot delete it', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.onboardingProgress.create({ data: { tenantId: a } })),
    ).rejects.toThrow(/Unique constraint/i);
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM onboarding_progress`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('steps hold only the six steps, each done or skipped', async () => {
    const set = (steps: unknown) =>
      withTenant(
        app,
        a,
        (tx) =>
          tx.$executeRaw`UPDATE onboarding_progress SET steps = ${JSON.stringify(steps)}::jsonb`,
      );
    expect(await set({ year: 'done', classes: 'skipped', attendance: 'done' })).toBe(1);
    await expect(set({ year: 'maybe' })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ fees: 'done' })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ year: true })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ year: null })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ year: ['done'] })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ year: [] })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set({ year: { done: 'done' } })).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set(['year'])).rejects.toThrow(/onboarding_progress_steps/);
    await expect(set('done')).rejects.toThrow(/onboarding_progress_steps/);
  });
});
