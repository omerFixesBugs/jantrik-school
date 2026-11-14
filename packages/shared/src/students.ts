import { z } from 'zod';
import type { StudentStatus } from './api.js';
import type { IsoDate } from './dates.js';
import { isoDateSchema } from './dates-schema.js';
import { toAsciiDigits } from './digits.js';
import { bdPhoneSchema } from './phone-schema.js';
import {
  BLOOD_GROUPS,
  GENDERS,
  GUARDIAN_RELATIONS,
  normalizeBirthRegistration,
  RELIGIONS,
  validateCodePattern,
  type BloodGroup,
  type Gender,
  type GuardianRelation,
  type Religion,
} from './students-values.js';

// Students: admission, profile, guardians, enrolment, student_code settings.

// ─────────────────────────── Field rules ───────────────────────────

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

/**
 * A guardian at admission (or added later). When guardians of this institute already have the
 * phone, the admin picks one (`guardianId`) or adds a new guardian (`createNew`); without a choice
 * the API answers 409 GUARDIAN_CHOICE_REQUIRED (decision #6).
 */
export const guardianInputSchema = z
  .object({
    phone: bdPhoneSchema,
    nameBn: optionalText(120),
    nameEn: optionalText(120),
    relation: z.enum(GUARDIAN_RELATIONS),
    isPrimary: z.boolean().default(false),
    occupation: optionalText(120),
    /** Link this guardian of the institute (it must have this phone). */
    guardianId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    /** Add a new guardian although others here have this phone. */
    createNew: z.boolean().default(false),
  })
  .refine((g) => !(g.guardianId && g.createNew), {
    message: 'Pick an existing guardian or a new one, not both',
    path: ['guardianId'],
  });
export type GuardianInput = z.input<typeof guardianInputSchema>;

/** GET /guardians?phone= (OWNER/ADMIN): this institute's guardians with that phone. */
export const guardianLookupQuerySchema = z.object({ phone: bdPhoneSchema });

/** A guardian of this institute with the typed phone (its own names, never a login's). */
export interface GuardianMatch {
  id: string;
  nameBn: string | null;
  nameEn: string | null;
  /** Their students, with this year's class (to tell guardians on one phone apart). */
  children: {
    nameBn: string | null;
    nameEn: string | null;
    classLevel: { nameBn: string; nameEn: string } | null;
  }[];
}

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
  status: StudentStatus;
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
