import { describe, expect, it } from 'vitest';
import {
  nextOnboardingStep,
  onboardingStepsFor,
  onboardingStepUpdateSchema,
} from './onboarding.js';

describe('onboarding steps', () => {
  it('include attendance only while that module is on', () => {
    expect(onboardingStepsFor(['CORE'])).toEqual([
      'year',
      'classes',
      'shifts',
      'teachers',
      'students',
    ]);
    expect(onboardingStepsFor(['CORE', 'ATTENDANCE'])).toEqual([
      'year',
      'classes',
      'shifts',
      'teachers',
      'students',
      'attendance',
    ]);
  });

  it('the next step is the first one not done or skipped', () => {
    const steps = onboardingStepsFor(['CORE', 'ATTENDANCE']);
    expect(nextOnboardingStep(steps, {})).toBe('year');
    expect(nextOnboardingStep(steps, { year: 'done', classes: 'skipped' })).toBe('shifts');
    // A later step answered first does not hide an earlier open one.
    expect(nextOnboardingStep(steps, { year: 'done', students: 'done' })).toBe('classes');
    expect(
      nextOnboardingStep(onboardingStepsFor(['CORE']), {
        year: 'done',
        classes: 'done',
        shifts: 'skipped',
        teachers: 'done',
        students: 'skipped',
      }),
    ).toBeNull();
  });

  it('a step is either done or skipped', () => {
    expect(onboardingStepUpdateSchema.safeParse({ state: 'done' }).success).toBe(true);
    expect(onboardingStepUpdateSchema.safeParse({ state: 'skipped' }).success).toBe(true);
    expect(onboardingStepUpdateSchema.safeParse({ state: 'open' }).success).toBe(false);
    expect(onboardingStepUpdateSchema.safeParse({}).success).toBe(false);
  });
});
