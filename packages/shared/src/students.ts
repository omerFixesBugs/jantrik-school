import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';
import { bdPhoneSchema } from './phone.js';

// Students: admission, profile, guardians, enrolment, student_code settings.

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

// ─────────────────────────── Field rules ───────────────────────────

/** Bangladesh birth registration number: exactly 17 digits (Bangla digits, spaces, dashes ok). */
export function normalizeBirthRegistration(input: string): string | null {
  const digits = toAsciiDigits(input).replace(/[\s-]/g, '');
  return /^\d{17}$/.test(digits) ? digits : null;
}

export const birthRegistrationSchema = z.string().transform((v, ctx) => {
  const n = normalizeBirthRegistration(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Birth registration number must be 17 digits' });
    return z.NEVER;
  }
  return n;
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** A date of birth: a real past date, at most ~100 years ago. Bangla digits accepted. */
export const dateOfBirthSchema = z
  .string()
  .transform((v) => toAsciiDigits(v.trim()))
  .pipe(isoDateSchema)
  .refine((d) => d >= '1920-01-01' && d <= new Date().toISOString().slice(0, 10), {
    message: 'Not a plausible date of birth',
  });

/** Manually given student code: ASCII letters, digits, - / _ (stored uppercase). */
export const studentCodeSchema = z
  .string()
  .trim()
  .transform((c) => toAsciiDigits(c).toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/_-]{0,29}$/, 'Letters, digits, - / _ only'));

/** Roll: 1–9999 (Bangla digits accepted when sent as text). */
export const rollSchema = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(toAsciiDigits(v.trim()))) : v),
  z.number().int().min(1).max(9999).nullable(),
);

const studentFields = {
  nameBn: optionalText(120),
  nameEn: optionalText(120),
  dateOfBirth: dateOfBirthSchema.nullish().transform((v) => v ?? null),
  gender: z
    .enum(GENDERS)
    .nullish()
    .transform((v) => v ?? null),
  religion: z
    .enum(RELIGIONS)
    .nullish()
    .transform((v) => v ?? null),
  bloodGroup: z
    .enum(BLOOD_GROUPS)
    .nullish()
    .transform((v) => v ?? null),
  birthRegistrationNo: z
    .union([birthRegistrationSchema, z.literal(''), z.null()])
    .optional()
    .transform((v) => v || null),
  fatherNameBn: optionalText(120),
  fatherNameEn: optionalText(120),
  motherNameBn: optionalText(120),
  motherNameEn: optionalText(120),
  presentAddress: optionalText(300),
  permanentAddress: optionalText(300),
};
const hasName = (s: { nameBn: string | null; nameEn: string | null }) =>
  Boolean(s.nameBn || s.nameEn);

export const guardianInputSchema = z.object({
  phone: bdPhoneSchema,
  nameBn: optionalText(120),
  nameEn: optionalText(120),
  relation: z.enum(GUARDIAN_RELATIONS),
  isPrimary: z.boolean().default(false),
  occupation: optionalText(120),
});
export type GuardianInput = z.input<typeof guardianInputSchema>;

export const enrolmentInputSchema = z.object({
  academicYearId: z.uuid(),
  classLevelId: z.uuid(),
  sectionId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  studyGroupId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  roll: rollSchema.optional().transform((v) => v ?? null),
});

/** POST /students (OWNER/ADMIN): one admission. */
export const admissionSchema = z
  .object({
    ...studentFields,
    studentCode: z
      .union([studentCodeSchema, z.literal(''), z.null()])
      .optional()
      .transform((v) => v || null),
    guardians: z
      .array(guardianInputSchema)
      .min(1)
      .max(4)
      .refine((g) => new Set(g.map((x) => x.phone)).size === g.length, 'Same phone twice')
      .refine((g) => g.filter((x) => x.isPrimary).length === 1, 'Exactly one primary guardian'),
    enrolment: enrolmentInputSchema,
  })
  .refine(hasName, { message: 'A name in Bangla or English is required', path: ['nameBn'] });
export type AdmissionInput = z.input<typeof admissionSchema>;

/** PATCH /students/:id (OWNER/ADMIN): the student's own fields. "Still has a name" is checked
 * by the API against the stored values (a body may clear one of two names). */
export const updateStudentSchema = z
  .object({ ...studentFields, studentCode: studentCodeSchema })
  .partial();

/** POST /students/:id/guardians. */
export const addGuardianSchema = guardianInputSchema;
/** PATCH /students/:id/guardians/:linkId. */
// .optional() outside: an omitted field stays undefined (unchanged), not null.
export const updateGuardianLinkSchema = z.object({
  relation: z.enum(GUARDIAN_RELATIONS).optional(),
  isPrimary: z.literal(true).optional(),
  nameBn: optionalText(120).optional(),
  nameEn: optionalText(120).optional(),
  occupation: optionalText(120).optional(),
});

/** POST /students/:id/transfer: another section of the same year and class level. */
export const transferSchema = z.object({
  sectionId: z.uuid(),
  roll: rollSchema.optional().transform((v) => v ?? null),
});

/** POST /students/:id/enrolments: enrol in a year the student is not in yet. */
export const createEnrolmentSchema = enrolmentInputSchema;

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

export const studentSettingsSchema = z
  .object({
    codePrefix: z
      .string()
      .trim()
      .transform((p) => toAsciiDigits(p).toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, '1–10 letters or digits')),
    codePattern: z.string().trim().min(1).max(40),
  })
  .superRefine((s, ctx) => {
    for (const message of validateCodePattern(s.codePattern))
      ctx.addIssue({ code: 'custom', message, path: ['codePattern'] });
  });

// ─────────────────────────── Responses ───────────────────────────

export interface StudentSettings {
  codePrefix: string;
  codePattern: string;
  /** What the next admission in the current year would get. */
  example: string;
}

export interface StudentGuardianLink {
  /** student_guardians.id */
  linkId: string;
  guardianId: string;
  nameBn: string | null;
  nameEn: string | null;
  phone: string;
  occupation: string | null;
  relation: GuardianRelation;
  isPrimary: boolean;
  /** Has a login (user + GUARDIAN membership). */
  canLogIn: boolean;
}

export interface StudentEnrolment {
  id: string;
  academicYear: { id: string; name: string; isCurrent: boolean };
  classLevel: { id: string; nameBn: string; nameEn: string };
  section: { id: string; name: string } | null;
  studyGroup: { id: string; nameBn: string; nameEn: string } | null;
  roll: number | null;
}

export interface StudentProfile {
  id: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  dateOfBirth: IsoDate | null;
  gender: Gender | null;
  religion: Religion | null;
  bloodGroup: BloodGroup | null;
  birthRegistrationNo: string | null;
  fatherNameBn: string | null;
  fatherNameEn: string | null;
  motherNameBn: string | null;
  motherNameEn: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  photoUrl: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'GRADUATED' | 'TRANSFERRED' | 'DROPPED_OUT';
  /** Set when deactivated (soft delete). */
  deletedAt: string | null;
  /**
   * 'basic' for a teacher who does not teach the student's section: date of birth, birth
   * registration no., addresses, parents' names and guardians are left out (null / empty).
   */
  access: 'full' | 'basic';
  createdAt: string;
  guardians: StudentGuardianLink[];
  /** Newest year first. */
  enrolments: StudentEnrolment[];
}
