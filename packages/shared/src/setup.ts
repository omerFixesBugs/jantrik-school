import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';

// Institute setup (OWNER/ADMIN): academic years, class levels, sections, shifts, subjects, study
// groups and labels. Things in use are deactivated, never deleted (409 IN_USE).

const nameSchema = z.string().trim().min(1).max(80);
const sortOrderSchema = z.number().int().min(0).max(9999);
/** Machine code (CLASS_6, SCIENCE): letters, digits, _ and -, stored uppercase. */
const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((c) => toAsciiDigits(c).toUpperCase().replace(/\s+/g, '_'))
  .pipe(z.string().regex(/^[A-Z0-9_-]+$/, 'Letters, digits, _ and - only'));
/** Local wall-clock time "HH:MM" (Bangla digits accepted). */
export const timeOfDaySchema = z
  .string()
  .trim()
  .transform((t) => toAsciiDigits(t))
  .pipe(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'));

// ─────────────────────────── Academic years ───────────────────────────

const academicYearFields = z.object({
  name: z.string().trim().min(1).max(40),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
});
const yearRange = <T extends { startDate: IsoDate; endDate: IsoDate }>(y: T) =>
  y.endDate > y.startDate && y.endDate <= addYears(y.startDate, 2);

/** POST /setup/academic-years. `copySectionsFrom`: copy that year's sections (no students). */
export const createAcademicYearSchema = academicYearFields
  .extend({ copySectionsFrom: z.uuid().nullish() })
  .refine(yearRange, { message: 'End must be after start, within 2 years', path: ['endDate'] });
export const updateAcademicYearSchema = academicYearFields.refine(yearRange, {
  message: 'End must be after start, within 2 years',
  path: ['endDate'],
});
export type AcademicYearInput = z.input<typeof createAcademicYearSchema>;

function addYears(date: IsoDate, years: number): IsoDate {
  const y = Number(date.slice(0, 4)) + years;
  const rest = date.slice(4);
  // 29 Feb → 28 Feb in a non-leap year.
  if (rest === '-02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return `${y}-02-28`;
  return `${y}${rest}`;
}

/** The year after `year`: "2026" → "2027", "2025-2026" → "2026-2027", dates + 1 year. */
export function suggestNextYear(year: { name: string; startDate: IsoDate; endDate: IsoDate }): {
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
} {
  const name = toAsciiDigits(year.name.trim());
  const range = /^(\d{4})\s*([-–/])\s*(\d{2}|\d{4})$/.exec(name);
  let next: string;
  if (/^\d{4}$/.test(name)) next = String(Number(name) + 1);
  else if (range) {
    const [, a, sep, b] = range;
    const nb = String(Number(b) + 1).padStart(b!.length, '0');
    next = `${Number(a) + 1}${sep}${nb.slice(-b!.length)}`;
  } else next = `${year.name.trim()} (+1)`;
  return {
    name: next,
    startDate: addYears(year.startDate, 1),
    endDate: addYears(year.endDate, 1),
  };
}

// ─────────────────────────── Class levels, groups, shifts ───────────────────────────

// Update schemas are built from fields without defaults: under .partial() a default would still
// fill in, so a PATCH of only { isActive } would silently reset sortOrder to 0.
const codeNameFields = { code: codeSchema, nameBn: nameSchema, nameEn: nameSchema };
export const createClassLevelSchema = z.object({
  ...codeNameFields,
  sortOrder: sortOrderSchema.default(0),
});
export const updateClassLevelSchema = z
  .object({ ...codeNameFields, sortOrder: sortOrderSchema })
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const createStudyGroupSchema = createClassLevelSchema;
export const updateStudyGroupSchema = updateClassLevelSchema;

const shiftFields = z.object({
  nameBn: nameSchema,
  nameEn: nameSchema,
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  sortOrder: sortOrderSchema,
});
export const createShiftSchema = shiftFields
  .extend({ sortOrder: sortOrderSchema.default(0) })
  .refine((s) => s.endTime > s.startTime, {
    message: 'End must be after start',
    path: ['endTime'],
  });
export const updateShiftSchema = shiftFields
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((s) => !s.startTime || !s.endTime || s.endTime > s.startTime, {
    message: 'End must be after start',
    path: ['endTime'],
  });

// ─────────────────────────── Sections, subjects ───────────────────────────

const capacitySchema = z.number().int().min(1).max(1000).nullable();

export const createSectionSchema = z.object({
  academicYearId: z.uuid(),
  classLevelId: z.uuid(),
  name: z.string().trim().min(1).max(40),
  shiftId: z.uuid().nullable().default(null),
  capacity: capacitySchema.default(null),
  sortOrder: sortOrderSchema.default(0),
});
/** The year and class level of a section never change (students are enrolled into them). */
export const updateSectionSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  shiftId: z.uuid().nullable().optional(),
  capacity: capacitySchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  isActive: z.boolean().optional(),
});
export const sectionsQuerySchema = z.object({ academicYearId: z.uuid() });

export const createSubjectSchema = z.object({
  classLevelId: z.uuid(),
  studyGroupId: z.uuid().nullable().default(null),
  code: codeSchema,
  nameBn: nameSchema,
  nameEn: nameSchema,
  isOptional: z.boolean().default(false),
  sortOrder: sortOrderSchema.default(0),
});
export const updateSubjectSchema = z.object({
  studyGroupId: z.uuid().nullable().optional(),
  code: codeSchema.optional(),
  nameBn: nameSchema.optional(),
  nameEn: nameSchema.optional(),
  isOptional: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
  isActive: z.boolean().optional(),
});
export const subjectsQuerySchema = z.object({ classLevelId: z.uuid() });

// ─────────────────────────── Labels ───────────────────────────

/** The labels an institute can rename (CLAUDE.md: never institute-type checks in code). */
export const LABEL_KEYS = [
  'class_level',
  'section',
  'academic_year',
  'shift',
  'study_group',
  'student',
  'roll',
] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];

export const updateLabelsSchema = z.object({
  labels: z
    .array(
      z.object({
        key: z.enum(LABEL_KEYS),
        bn: z.string().trim().min(1).max(40),
        en: z.string().trim().min(1).max(40),
      }),
    )
    .min(1)
    .max(LABEL_KEYS.length)
    .refine((l) => new Set(l.map((x) => x.key)).size === l.length, 'Duplicate label'),
});
export type UpdateLabelsInput = z.input<typeof updateLabelsSchema>;

// ─────────────────────────── Responses ───────────────────────────

export interface SetupAcademicYear {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  isCurrent: boolean;
  sectionCount: number;
  enrolmentCount: number;
}

export interface SetupClassLevel {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
  /** Anything > 0 means it cannot be deleted, only deactivated. */
  usage: { sections: number; subjects: number; enrolments: number };
}

export interface SetupStudyGroup {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
  usage: { subjects: number; enrolments: number };
}

export interface SetupShift {
  id: string;
  nameBn: string;
  nameEn: string;
  /** "HH:MM", local wall-clock time. */
  startTime: string;
  endTime: string;
  sortOrder: number;
  isActive: boolean;
  usage: { sections: number };
}

export interface SetupSection {
  id: string;
  academicYearId: string;
  classLevelId: string;
  shiftId: string | null;
  name: string;
  capacity: number | null;
  sortOrder: number;
  isActive: boolean;
  usage: { enrolments: number; attendance: number; teachers: number };
}

export interface SetupSubject {
  id: string;
  classLevelId: string;
  studyGroupId: string | null;
  code: string;
  nameBn: string;
  nameEn: string;
  isOptional: boolean;
  sortOrder: number;
  isActive: boolean;
  usage: { attendance: number };
}

export interface SetupLabel {
  key: LabelKey;
  bn: string;
  en: string;
  /** The institute type's template value (what "reset" goes back to). */
  defaultBn: string;
  defaultEn: string;
}

/** 409 IN_USE body: why something cannot be deleted. */
export interface InUseError {
  code: 'IN_USE';
  usage: Record<string, number>;
}
