/** How a percentage is rounded before the grade band lookup (mirrors the DB enum `rounding_mode`). */
export const ROUNDING_MODES = ['NONE', 'ROUND_HALF_UP', 'CEIL'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export interface GradeBand {
  /** Inclusive lower bound, 0–100. */
  minPercent: number;
  letter: string;
  gradePoint: number;
}

export interface GradeResult {
  letter: string;
  gradePoint: number;
  /** The percentage actually used for the lookup (after rounding). */
  percent: number;
}

// Strips floating-point noise such as 79.00000000000001 (from marks / total * 100) without
// changing any meaningful value, so CEIL and band edges behave as a human would expect.
function normalise(percent: number): number {
  return Math.round(percent * 1e6) / 1e6;
}

export function applyRounding(percent: number, mode: RoundingMode): number {
  const p = normalise(percent);
  switch (mode) {
    case 'NONE':
      return p;
    case 'ROUND_HALF_UP':
      return Math.floor(p + 0.5);
    case 'CEIL':
      return Math.ceil(p);
  }
}

/**
 * Grade for a percentage: the band with the highest `minPercent` that is <= the (rounded)
 * percentage. With the Bangladesh GPA 5.0 scheme and `NONE`, 79.5 → A (4.0); with
 * `ROUND_HALF_UP`, 79.5 → 80 → A+ (5.0).
 */
export function calculateGrade(
  percent: number,
  bands: readonly GradeBand[],
  roundingMode: RoundingMode = 'NONE',
): GradeResult {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`Percentage must be between 0 and 100, got ${percent}`);
  }
  const rounded = applyRounding(percent, roundingMode);

  let match: GradeBand | undefined;
  for (const band of bands) {
    if (band.minPercent <= rounded && (!match || band.minPercent > match.minPercent)) {
      match = band;
    }
  }
  if (!match) {
    throw new RangeError(`No grade band covers ${rounded}%`);
  }
  return { letter: match.letter, gradePoint: match.gradePoint, percent: rounded };
}
