import { z } from 'zod';
import {
  ADMISSION_APPLICATION_STATUSES,
  ADMISSION_CYCLE_STATUSES,
  ADMISSION_FIELD_SETTINGS,
  ADMISSION_FIELDS,
  ADMISSION_REASON_STATUSES,
  ADMISSION_SOURCES,
  ADMISSION_STAFF_STATUSES,
} from './admission.js';
import { toAsciiDigits } from './digits.js';
import { bdPhoneSchema } from './phone-schema.js';
import {
  birthRegistrationSchema,
  dateOfBirthSchema,
  rollSchema,
  studentCodeSchema,
} from './students.js';
import { BLOOD_GROUPS, GENDERS, GUARDIAN_RELATIONS, RELIGIONS } from './students-values.js';

// Online admission input (sprint 1 P3). Every limit matches a CHECK on the admission tables, so a
// value the schema accepts is never refused by the database.

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .nullish()
    .transform((v) => v ?? null);

/** An application's own fields (the public form, a staff entry). */
export const admissionApplicationFieldsObject = z.object({
  nameBn: text(120),
  nameEn: text(120),
  dateOfBirth: dateOfBirthSchema,
  gender: z.enum(GENDERS),
  religion: optionalEnum(RELIGIONS),
  bloodGroup: optionalEnum(BLOOD_GROUPS),
  birthRegistrationNo: z
    .union([birthRegistrationSchema, z.literal(''), z.null()])
    .optional()
    .transform((v) => v || null),
  previousInstitute: text(150),
  presentAddress: text(300),
  permanentAddress: text(300),
  fatherNameBn: text(120),
  fatherNameEn: text(120),
  motherNameBn: text(120),
  motherNameEn: text(120),
  guardianNameBn: text(120),
  guardianNameEn: text(120),
  guardianRelation: z.enum(GUARDIAN_RELATIONS),
  guardianOccupation: text(120),
});

type Names = { nameBn: string | null; nameEn: string | null };
type GuardianNames = { guardianNameBn: string | null; guardianNameEn: string | null };
const hasName = (a: Names) => Boolean(a.nameBn || a.nameEn);
const hasGuardianName = (a: GuardianNames) => Boolean(a.guardianNameBn || a.guardianNameEn);

/** The public form's payload (P3b): only these keys; anything else is refused. */
export const admissionApplicationFieldsSchema = admissionApplicationFieldsObject
  .strict()
  .refine(hasName, { message: 'A name in Bangla or English is required', path: ['nameBn'] })
  .refine(hasGuardianName, {
    message: "The guardian's name is required",
    path: ['guardianNameBn'],
  });
export type AdmissionApplicationFieldsInput = z.input<typeof admissionApplicationFieldsSchema>;

/** POST /admission/applications: a walk-in or paper application typed by staff (P3-J). */
export const staffAdmissionApplicationSchema = admissionApplicationFieldsObject
  .extend({
    cycleClassId: z.uuid(),
    phone: bdPhoneSchema,
    staffNote: text(2000),
  })
  .strict()
  .refine(hasName, { message: 'A name in Bangla or English is required', path: ['nameBn'] })
  .refine(hasGuardianName, {
    message: "The guardian's name is required",
    path: ['guardianNameBn'],
  });
export type StaffAdmissionApplicationInput = z.input<typeof staffAdmissionApplicationSchema>;

/**
 * PATCH /admission/applications/:id: any of the fields; "still has a name" is checked against
 * the stored values by the API. An omitted field stays as it is.
 */
export const updateAdmissionApplicationSchema = admissionApplicationFieldsObject
  .extend({
    cycleClassId: z.uuid(),
    phone: bdPhoneSchema,
    staffNote: text(2000),
  })
  .partial()
  .strict();
export type UpdateAdmissionApplicationInput = z.input<typeof updateAdmissionApplicationSchema>;

/** POST /admission/applications/:id/status. */
export const admissionStatusSchema = z
  .object({ status: z.enum(ADMISSION_STAFF_STATUSES), reason: text(500) })
  .refine((v) => !ADMISSION_REASON_STATUSES.includes(v.status) || v.reason !== null, {
    message: 'A reason is required',
    path: ['reason'],
  });
export type AdmissionStatusInput = z.input<typeof admissionStatusSchema>;

/** POST /admission/applications/:id/approve: where the child goes, and the guardian choice. */
export const approveAdmissionSchema = z
  .object({
    sectionId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    roll: rollSchema.optional().transform((v) => v ?? null),
    studentCode: z
      .union([studentCodeSchema, z.literal(''), z.null()])
      .optional()
      .transform((v) => v || null),
    guardianId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    createNew: z.boolean().default(false),
  })
  .refine((v) => !(v.guardianId && v.createNew), {
    message: 'Pick an existing guardian or a new one, not both',
    path: ['guardianId'],
  });
export type ApproveAdmissionInput = z.input<typeof approveAdmissionSchema>;

/** POST /admission/cycle-classes/:id/bulk-approve. */
export const bulkApproveAdmissionSchema = z.object({ sectionId: z.uuid() });

const fieldsSchema = z
  .partialRecord(z.enum(ADMISSION_FIELDS), z.enum(ADMISSION_FIELD_SETTINGS))
  .default({});

const cycleBase = {
  nameBn: z.string().trim().min(1).max(80),
  nameEn: text(80),
  opensAt: z.iso.datetime({ offset: true }),
  closesAt: z.iso.datetime({ offset: true }),
  publicNoteBn: text(1000),
  publicNoteEn: text(1000),
  requiresTest: z.boolean().default(false),
  collectPhoto: z.boolean().default(false),
  fields: fieldsSchema,
};

const windowOk = (v: { opensAt?: string; closesAt?: string }) =>
  !v.opensAt || !v.closesAt || Date.parse(v.closesAt) > Date.parse(v.opensAt);

/** POST /admission/cycles (a new cycle starts as DRAFT). */
export const admissionCycleSchema = z
  .object({ academicYearId: z.uuid(), ...cycleBase })
  .strict()
  .refine(windowOk, { message: 'The form must close after it opens', path: ['closesAt'] });
export type AdmissionCycleInput = z.input<typeof admissionCycleSchema>;

/** PATCH /admission/cycles/:id. */
export const updateAdmissionCycleSchema = z
  .object({
    academicYearId: z.uuid(),
    nameBn: cycleBase.nameBn,
    nameEn: cycleBase.nameEn,
    opensAt: cycleBase.opensAt,
    closesAt: cycleBase.closesAt,
    publicNoteBn: cycleBase.publicNoteBn,
    publicNoteEn: cycleBase.publicNoteEn,
    requiresTest: z.boolean(),
    collectPhoto: z.boolean(),
    fields: z.partialRecord(z.enum(ADMISSION_FIELDS), z.enum(ADMISSION_FIELD_SETTINGS)),
  })
  .partial()
  .strict();
export type UpdateAdmissionCycleInput = z.input<typeof updateAdmissionCycleSchema>;

export const admissionCycleStatusSchema = z.object({ status: z.enum(ADMISSION_CYCLE_STATUSES) });

/** PUT /admission/cycles/:id/classes: the whole list (each class and group once). */
export const admissionCycleClassesSchema = z.object({
  classes: z
    .array(
      z.object({
        classLevelId: z.uuid(),
        studyGroupId: z
          .uuid()
          .nullish()
          .transform((v) => v ?? null),
        seats: z.preprocess(
          (v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(toAsciiDigits(v))) : v),
          z.number().int().min(1).max(5000).nullish(),
        ),
        isOpen: z.boolean().default(true),
      }),
    )
    .max(80)
    .refine(
      (cs) =>
        new Set(cs.map((c) => `${c.classLevelId}:${c.studyGroupId ?? ''}`)).size === cs.length,
      { message: 'A class is listed twice' },
    ),
});
export type AdmissionCycleClassesInput = z.input<typeof admissionCycleClassesSchema>;

/** GET /admission/applications (and .csv). */
export const admissionApplicationsQuerySchema = z.object({
  cycleId: z.uuid().optional(),
  cycleClassId: z.uuid().optional(),
  status: z.enum(ADMISSION_APPLICATION_STATUSES).optional(),
  source: z.enum(ADMISSION_SOURCES).optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdmissionApplicationsQuery = z.output<typeof admissionApplicationsQuerySchema>;
