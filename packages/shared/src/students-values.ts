import { toAsciiDigits } from './digits.js';

// What the browser uses from students (the choices, the field rules, the student code), apart
// from students.ts (its request schemas) so it never loads zod (see dates-schema.ts).

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const RELIGIONS = ['ISLAM', 'HINDUISM', 'CHRISTIANITY', 'BUDDHISM', 'OTHER'] as const;
export const BLOOD_GROUPS = [
  'A_POSITIVE',
  'A_NEGATIVE',
  'B_POSITIVE',
  'B_NEGATIVE',
  'AB_POSITIVE',
  'AB_NEGATIVE',
  'O_POSITIVE',
  'O_NEGATIVE',
] as const;
export const GUARDIAN_RELATIONS = [
  'FATHER',
  'MOTHER',
  'BROTHER',
  'SISTER',
  'GRANDFATHER',
  'GRANDMOTHER',
  'UNCLE',
  'AUNT',
  'OTHER',
] as const;
export type Gender = (typeof GENDERS)[number];
export type Religion = (typeof RELIGIONS)[number];
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

/** "A+" style labels (same in both languages). */
export const BLOOD_GROUP_LABEL: Record<BloodGroup, string> = {
  A_POSITIVE: 'A+',
  A_NEGATIVE: 'A−',
  B_POSITIVE: 'B+',
  B_NEGATIVE: 'B−',
  AB_POSITIVE: 'AB+',
  AB_NEGATIVE: 'AB−',
  O_POSITIVE: 'O+',
  O_NEGATIVE: 'O−',
};

/** Bangladesh birth registration number: exactly 17 digits (Bangla digits, spaces, dashes ok). */
export function normalizeBirthRegistration(input: string): string | null {
  const digits = toAsciiDigits(input).replace(/[\s-]/g, '');
  return /^\d{17}$/.test(digits) ? digits : null;
}

// ─────────────────────────── Student code ───────────────────────────

export const DEFAULT_CODE_PATTERN = '{PREFIX}-{YEAR}-{NNNN}';

/** Default prefix: initials of the slug's words ("shapla-school" → "SS"), else "STU". */
export function defaultCodePrefix(slug: string): string {
  const initials = slug
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return initials.length >= 2 ? initials : 'STU';
}

/** Problems with a pattern (empty = fine). */
export function validateCodePattern(pattern: string): string[] {
  const problems: string[] = [];
  const runs = pattern.match(/\{N+\}/g) ?? [];
  if (runs.length !== 1) problems.push('Use exactly one {NNNN} (the number)');
  else if (runs[0]!.length - 2 > 8) problems.push('At most 8 N');
  const rest = pattern.replace(/\{(PREFIX|YEAR|YY|N+)\}/g, '');
  if (/[{}]/.test(rest)) problems.push('Unknown {…}: use {PREFIX}, {YEAR}, {YY}, {NNNN}');
  if (!/^[A-Z0-9/_-]*$/.test(rest)) problems.push('Only letters A–Z, digits, - / _');
  if (pattern.length > 40) problems.push('Too long');
  return problems;
}

/** {PREFIX}-{YEAR}-{NNNN} with prefix SS, year 2026, 7 → SS-2026-0007. */
export function renderStudentCode(
  pattern: string,
  values: { prefix: string; year: number; seq: number },
): string {
  return pattern
    .replace('{PREFIX}', values.prefix)
    .replace('{YEAR}', String(values.year))
    .replace('{YY}', String(values.year % 100).padStart(2, '0'))
    .replace(/\{(N+)\}/, (_, n: string) => String(values.seq).padStart(n.length, '0'));
}
