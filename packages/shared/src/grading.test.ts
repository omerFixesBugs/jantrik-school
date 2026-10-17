import { describe, expect, it } from 'vitest';
import { applyRounding, calculateGrade, type GradeBand } from './grading.js';

// Bangladesh GPA 5.0
const GPA5: GradeBand[] = [
  { minPercent: 80, letter: 'A+', gradePoint: 5 },
  { minPercent: 70, letter: 'A', gradePoint: 4 },
  { minPercent: 60, letter: 'A-', gradePoint: 3.5 },
  { minPercent: 50, letter: 'B', gradePoint: 3 },
  { minPercent: 40, letter: 'C', gradePoint: 2 },
  { minPercent: 33, letter: 'D', gradePoint: 1 },
  { minPercent: 0, letter: 'F', gradePoint: 0 },
];

describe('calculateGrade (GPA 5.0, NONE)', () => {
  it.each([
    [100, 'A+', 5],
    [80, 'A+', 5],
    [79.5, 'A', 4],
    [79.99, 'A', 4],
    [70, 'A', 4],
    [69.9, 'A-', 3.5],
    [60, 'A-', 3.5],
    [50, 'B', 3],
    [40, 'C', 2],
    [39, 'D', 1],
    [33, 'D', 1],
    [32.9, 'F', 0],
    [32.999, 'F', 0],
    [0, 'F', 0],
  ])('%s%% → %s (%s)', (percent, letter, gradePoint) => {
    expect(calculateGrade(percent, GPA5)).toMatchObject({ letter, gradePoint });
  });

  it('does not depend on band order', () => {
    expect(calculateGrade(65, [...GPA5].reverse())).toMatchObject({ letter: 'A-' });
  });
});

describe('calculateGrade with rounding', () => {
  it('79.5 is A with NONE but A+ with ROUND_HALF_UP', () => {
    expect(calculateGrade(79.5, GPA5, 'NONE')).toMatchObject({ letter: 'A', gradePoint: 4 });
    expect(calculateGrade(79.5, GPA5, 'ROUND_HALF_UP')).toMatchObject({
      letter: 'A+',
      gradePoint: 5,
      percent: 80,
    });
  });

  it('ROUND_HALF_UP keeps 79.49 in A and 32.5 → 33 → D', () => {
    expect(calculateGrade(79.49, GPA5, 'ROUND_HALF_UP')).toMatchObject({ letter: 'A' });
    expect(calculateGrade(32.5, GPA5, 'ROUND_HALF_UP')).toMatchObject({ letter: 'D' });
  });

  it('CEIL lifts any fraction to the next whole mark', () => {
    expect(calculateGrade(32.1, GPA5, 'CEIL')).toMatchObject({ letter: 'D', percent: 33 });
    expect(calculateGrade(79, GPA5, 'CEIL')).toMatchObject({ letter: 'A', percent: 79 });
  });

  it('ignores floating-point noise from marks / total * 100', () => {
    const percent = (79 / 100) * 100 + 1e-12; // 79.000000000001
    expect(applyRounding(percent, 'CEIL')).toBe(79);
  });
});

describe('calculateGrade input validation', () => {
  it.each([-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (percent) => {
    expect(() => calculateGrade(percent, GPA5)).toThrow(RangeError);
  });

  it('throws when no band covers the percentage', () => {
    expect(() => calculateGrade(10, [{ minPercent: 33, letter: 'D', gradePoint: 1 }])).toThrow(
      RangeError,
    );
  });
});
