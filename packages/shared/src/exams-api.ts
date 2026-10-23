/**
 * Exams module API (docs/exams.md): request schemas and response shapes. Marks are integer
 * hundredths (`*H`); full and pass marks are whole numbers. The rules live in exams.ts.
 */
import { z } from 'zod';
import type { PersonRef } from './attendance.js';
import {
  COMPONENT_KINDS,
  GPA_ROUNDINGS,
  PASS_RULES,
  SUBJECT_CHOICE_KINDS,
  type ComponentKind,
  type GpaRounding,
  type PassRule,
  type SubjectChoiceKind,
} from './exams.js';
import { ROUNDING_MODES, type RoundingMode } from './grading.js';

const nameSchema = z.string().trim().min(1).max(60);

// ─────────────────────────── Subject marks (parts and pass marks) ───────────────────────────

export const examComponentSchema = z
  .object({
    /** e.g. CQ, MCQ, PRACTICAL, P1_CQ (1st paper CQ). */
    key: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Letters, digits and _ (up to 20), starting with a letter'),
    kind: z.enum(COMPONENT_KINDS),
    nameBn: nameSchema,
    nameEn: nameSchema,
    fullMarks: z.number().int().min(1).max(1000),
    /** Used under PER_COMPONENT; null: no pass mark of its own. */
    passMarks: z.number().int().min(0).max(1000).nullable(),
  })
  .refine((c) => c.passMarks === null || c.passMarks <= c.fullMarks, {
    message: 'The pass mark cannot be above the full marks',
    path: ['passMarks'],
  });

export const passGroupSchema = z.object({
  kind: z.enum(COMPONENT_KINDS),
  passMarks: z.number().int().min(0).max(5000),
});

/**
 * A subject's parts and how it is passed. COMBINED: every kind among the parts needs one combined
 * pass mark (at most the summed full marks of that kind); PER_COMPONENT has none.
 */
export const subjectMarksSchema = z
  .object({
    passRule: z.enum(PASS_RULES),
    components: z.array(examComponentSchema).min(1).max(12),
    passGroups: z.array(passGroupSchema).max(COMPONENT_KINDS.length),
  })
  .superRefine((v, ctx) => {
    const keys = v.components.map((c) => c.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each part needs its own key',
        path: ['components'],
      });
    }
    const groupKinds = v.passGroups.map((g) => g.kind);
    if (new Set(groupKinds).size !== groupKinds.length) {
      ctx.addIssue({ code: 'custom', message: 'One pass mark per kind', path: ['passGroups'] });
    }
    if (v.passRule === 'PER_COMPONENT') {
      if (v.passGroups.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Combined pass marks are only for the COMBINED pass rule',
          path: ['passGroups'],
        });
      }
      return;
    }
    const fullByKind = new Map<ComponentKind, number>();
    for (const c of v.components)
      fullByKind.set(c.kind, (fullByKind.get(c.kind) ?? 0) + c.fullMarks);
    for (const kind of fullByKind.keys()) {
      if (!groupKinds.includes(kind)) {
        ctx.addIssue({
          code: 'custom',
          message: `A combined pass mark is needed for ${kind}`,
          path: ['passGroups'],
        });
      }
    }
    v.passGroups.forEach((g, i) => {
      const full = fullByKind.get(g.kind);
      if (full === undefined) {
        ctx.addIssue({ code: 'custom', message: 'No part has this kind', path: ['passGroups', i] });
      } else if (g.passMarks > full) {
        ctx.addIssue({
          code: 'custom',
          message: 'The pass mark cannot be above the full marks of that kind',
          path: ['passGroups', i, 'passMarks'],
        });
      }
    });
  });
export type SubjectMarksInput = z.input<typeof subjectMarksSchema>;

export const examSetupSubjectsQuerySchema = z.object({ classLevelId: z.uuid() });

export interface ExamComponentView {
  key: string;
  kind: ComponentKind;
  nameBn: string;
  nameEn: string;
  fullMarks: number;
  passMarks: number | null;
}

export interface PassGroupView {
  kind: ComponentKind;
  passMarks: number;
}

export interface NamedRef {
  id: string;
  nameBn: string;
  nameEn: string;
}

export interface CodedRef extends NamedRef {
  code: string;
}

export interface SubjectMarksView extends CodedRef {
  /** In the elective pool (chosen per student). */
  isOptional: boolean;
  isActive: boolean;
  studyGroup: CodedRef | null;
  passRule: PassRule;
  components: ExamComponentView[];
  passGroups: PassGroupView[];
  /** Copied from an institute-type template (can reload its default parts). */
  fromTemplate: boolean;
}

export interface GradeBandView {
  minPercent: number;
  maxPercent: number;
  letter: string;
  gradePoint: number;
}

/** GET /exams/setup/subjects?classLevelId (OWNER/ADMIN). */
export interface ExamSetupSubjects {
  classLevel: CodedRef;
  /** The class's grading bands (for suggested pass marks). */
  bands: GradeBandView[];
  subjects: SubjectMarksView[];
}

/** POST /exams/setup/subjects/load-template */
export interface LoadTemplateMarksResult {
  /** Subjects that had no parts and got the template's. */
  filled: number;
}

// ─────────────────────────── Grading schemes ───────────────────────────

/** PUT /exams/grading/:id: the GPA rules and rounding (the bands are read-only for now). */
export const gradingRulesSchema = z
  .object({
    roundingMode: z.enum(ROUNDING_MODES),
    gpaMax: z.number().multipleOf(0.01).min(0.01).max(9.99),
    optionalBonusAbove: z.number().multipleOf(0.01).min(0).max(9.99).nullable(),
    gpaDecimals: z.number().int().min(0).max(2),
    gpaRounding: z.enum(GPA_ROUNDINGS),
    compulsoryFailZero: z.boolean(),
  })
  .refine((r) => r.optionalBonusAbove === null || r.optionalBonusAbove <= r.gpaMax, {
    message: 'The 4th-subject threshold cannot be above the GPA cap',
    path: ['optionalBonusAbove'],
  });
export type GradingRulesInput = z.input<typeof gradingRulesSchema>;

export interface GradingSchemeView {
  id: string;
  nameBn: string;
  nameEn: string;
  isDefault: boolean;
  roundingMode: RoundingMode;
  gpaMax: number;
  optionalBonusAbove: number | null;
  gpaDecimals: number;
  gpaRounding: GpaRounding;
  compulsoryFailZero: boolean;
  bands: GradeBandView[];
  /** Classes that use this scheme instead of the default. */
  classLevels: NamedRef[];
}

// ─────────────────────────── Subject teachers ───────────────────────────

export const sectionSubjectTeachersSchema = z
  .object({
    assignments: z
      .array(
        z.object({
          subjectId: z.uuid(),
          userIds: z
            .array(z.uuid())
            .max(5)
            .refine((ids) => new Set(ids).size === ids.length, 'Each teacher once'),
        }),
      )
      .max(60),
  })
  .refine((v) => new Set(v.assignments.map((a) => a.subjectId)).size === v.assignments.length, {
    message: 'Each subject once',
    path: ['assignments'],
  });
export type SectionSubjectTeachersInput = z.input<typeof sectionSubjectTeachersSchema>;

export interface ExamSectionRef {
  id: string;
  name: string;
  academicYearId: string;
  classLevel: CodedRef;
}

export interface SectionSubjectTeachersView {
  section: ExamSectionRef;
  /** The section's class teacher (attendance setup), for "assign to every subject". */
  classTeacher: PersonRef | null;
  subjects: {
    subject: CodedRef & { studyGroupId: string | null; isOptional: boolean };
    teachers: PersonRef[];
  }[];
}

export interface ExamStaffMember extends PersonRef {
  role: 'OWNER' | 'ADMIN' | 'TEACHER';
}

// ─────────────────────────── Subject choices (the elective pool) ───────────────────────────

export const subjectChoicesSchema = z
  .object({
    students: z
      .array(
        z.object({
          studentId: z.uuid(),
          choices: z
            .array(z.object({ subjectId: z.uuid(), kind: z.enum(SUBJECT_CHOICE_KINDS) }))
            .max(10)
            .refine(
              (cs) => new Set(cs.map((c) => c.subjectId)).size === cs.length,
              'Each subject once',
            )
            .refine(
              (cs) => cs.filter((c) => c.kind === 'OPTIONAL').length <= 1,
              'At most one 4th subject',
            ),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine((v) => new Set(v.students.map((s) => s.studentId)).size === v.students.length, {
    message: 'Each student once',
    path: ['students'],
  });
export type SubjectChoicesInput = z.input<typeof subjectChoicesSchema>;

export interface SubjectChoicesView {
  section: ExamSectionRef;
  /** The class's elective subjects (active). */
  pool: (CodedRef & { studyGroupId: string | null })[];
  students: {
    id: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
    roll: number | null;
    studyGroup: CodedRef | null;
    choices: { subjectId: string; kind: SubjectChoiceKind }[];
  }[];
}

// ─────────────────────────── Rooms ───────────────────────────

export const examRoomSchema = z
  .object({
    name: nameSchema,
    rows: z.number().int().min(1).max(100),
    cols: z.number().int().min(1).max(20),
    isActive: z.boolean().default(true),
  })
  .refine((r) => r.rows * r.cols <= 500, { message: 'At most 500 seats', path: ['rows'] });
export type ExamRoomInput = z.input<typeof examRoomSchema>;

export interface ExamRoomView {
  id: string;
  name: string;
  rows: number;
  cols: number;
  capacity: number;
  isActive: boolean;
}
