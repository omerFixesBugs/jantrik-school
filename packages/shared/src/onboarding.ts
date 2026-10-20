import { z } from 'zod';

// The new owner's setup wizard (step 8, part 5): six steps, each done or skipped, saved per step.

export const ONBOARDING_STEPS = [
  'year',
  'classes',
  'shifts',
  'teachers',
  'students',
  'attendance',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const onboardingStepSchema = z.enum(ONBOARDING_STEPS);

export const ONBOARDING_STEP_STATES = ['done', 'skipped'] as const;
export type OnboardingStepState = (typeof ONBOARDING_STEP_STATES)[number];
export type OnboardingStates = Partial<Record<OnboardingStep, OnboardingStepState>>;

/** PUT /onboarding/steps/:step (OWNER/ADMIN). */
export const onboardingStepUpdateSchema = z.object({ state: z.enum(ONBOARDING_STEP_STATES) });

/** The steps that apply to an institute: attendance only while that module is on. */
export function onboardingStepsFor(modules: readonly string[]): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((s) => s !== 'attendance' || modules.includes('ATTENDANCE'));
}

/** The first step that applies and is not answered yet; null once every one is. */
export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  states: OnboardingStates,
): OnboardingStep | null {
  return steps.find((s) => !states[s]) ?? null;
}

/** GET /onboarding. */
export interface Onboarding {
  /** False: this institute has no wizard (made before it, or a demo institute). */
  wizard: boolean;
  /** The steps that apply, in order. */
  steps: OnboardingStep[];
  states: OnboardingStates;
  nextStep: OnboardingStep | null;
  /** Set once the wizard is finished. */
  completedAt: string | null;
}
