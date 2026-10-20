import type { Role } from './auth.js';

/**
 * Two densities from one design system (docs/design.md → Density): COMPACT for people who work
 * in the app at a desk all day, COMFORTABLE for phones and for teachers and guardians.
 */
export const DENSITIES = ['compact', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];

export const isDensity = (value: unknown): value is Density =>
  value === 'compact' || value === 'comfortable';

/** Below this width the screen is a phone or a small tablet: always comfortable by default. */
export const COMPACT_MIN_WIDTH = 1024;

/** Roles whose work is mostly at a desk (office work, accounts, the platform). */
const DESK_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'STAFF'];

/**
 * The density someone gets before they choose one: compact on a wide screen for desk roles and
 * for the platform's own staff; comfortable for teachers, guardians and students, and on every
 * screen narrower than {@link COMPACT_MIN_WIDTH}. `role` is the person's most senior role.
 */
export function defaultDensity(input: {
  role: Role | null;
  viewportWidth: number;
  platform?: boolean;
}): Density {
  if (input.viewportWidth < COMPACT_MIN_WIDTH) return 'comfortable';
  if (input.platform) return 'compact';
  return input.role && DESK_ROLES.includes(input.role) ? 'compact' : 'comfortable';
}
