import { calculateGrade, type GradeBand, type RoundingMode } from '@jantrik/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantClient, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

/** Load a tenant's default grading scheme as plain numbers for calculateGrade. */
async function loadDefaultScheme(
  app: PrismaClient,
  tenantId: string,
): Promise<{ bands: GradeBand[]; roundingMode: RoundingMode }> {
  const scheme = await tenantClient(app, tenantId).gradingScheme.findFirstOrThrow({
    where: { isDefault: true },
    include: { bands: true },
  });
  return {
    roundingMode: scheme.roundingMode,
    bands: scheme.bands.map((b) => ({
      minPercent: b.minPercent.toNumber(),
      letter: b.letter,
      gradePoint: b.gradePoint.toNumber(),
    })),
  };
}

describe("grading with a tenant's copied GPA 5.0 scheme", () => {
  let app: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    app = appClient();
    tenantId = (await createTenant(app)).id;
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it.each([
    [100, 'A+', 5],
    [80, 'A+', 5],
    [79.5, 'A', 4],
    [70, 'A', 4],
    [60, 'A-', 3.5],
    [50, 'B', 3],
    [40, 'C', 2],
    [33, 'D', 1],
    [32.9, 'F', 0],
    [0, 'F', 0],
  ])('%s%% → %s (%s) with rounding NONE', async (percent, letter, gradePoint) => {
    const { bands, roundingMode } = await loadDefaultScheme(app, tenantId);
    expect(roundingMode).toBe('NONE');
    expect(calculateGrade(percent, bands, roundingMode)).toMatchObject({ letter, gradePoint });
  });

  it('79.5 becomes A+ once the tenant switches to ROUND_HALF_UP', async () => {
    const other = (await createTenant(app)).id;
    await withTenant(app, other, (tx) =>
      tx.gradingScheme.updateMany({
        where: { isDefault: true },
        data: { roundingMode: 'ROUND_HALF_UP' },
      }),
    );

    const rounded = await loadDefaultScheme(app, other);
    expect(calculateGrade(79.5, rounded.bands, rounded.roundingMode)).toMatchObject({
      letter: 'A+',
      gradePoint: 5,
    });

    // The first tenant still uses NONE.
    const original = await loadDefaultScheme(app, tenantId);
    expect(calculateGrade(79.5, original.bands, original.roundingMode)).toMatchObject({
      letter: 'A',
    });
  });
});
