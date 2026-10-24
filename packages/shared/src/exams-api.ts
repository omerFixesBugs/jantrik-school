/**
 * Exams module API (docs/exams.md): request schemas and response shapes. Marks are integer
 * hundredths (`*H`); full and pass marks are whole numbers. The rules live in exams.ts.
 */
import { z } from 'zod';
import type { PersonRef } from './attendance.js';
import { isoDateSchema, type IsoDate } from './dates.js';
import {
  COMPONENT_KINDS,
  EXAM_KINDS,
  EXAM_RESULT_MODES,
  GPA_ROUNDINGS,
  MERIT_FAILED_RANKINGS,
  MERIT_KEYS,
  PASS_RULES,
  SUBJECT_CHOICE_KINDS,
  type ComponentKind,
  type ExamKind,
  type ExamResultMode,
  type ExamStatus,
  type GpaRounding,
  type MeritFailedRanking,
  type MeritKey,
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

// ─────────────────────────── Exams ───────────────────────────

const examNameSchema = z.string().trim().min(1).max(120);

export const meritKeySchema = z.union([
  z.enum(MERIT_KEYS),
  z.string().regex(/^SUBJECT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
]) as z.ZodType<MeritKey, MeritKey>;

const meritOrderSchema = z
  .array(meritKeySchema)
  .min(1)
  .max(8)
  .refine((keys) => new Set(keys).size === keys.length, 'Each tie-breaker once');

/** The days whose attendance the report card shows; null: no attendance on the report card. */
const attendanceWindowSchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((w) => w.from <= w.to, { message: 'The window ends before it starts', path: ['to'] });

/**
 * POST /exams. Left out: the merit order and failed ranking come from the institute's last exam
 * with the same result mode, and the attendance window from the day after the previous GPA exam
 * (or the year's start) to this exam's last day.
 */
export const createExamSchema = z
  .object({
    academicYearId: z.uuid(),
    kind: z.enum(EXAM_KINDS),
    nameBn: examNameSchema,
    nameEn: examNameSchema,
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    resultMode: z.enum(EXAM_RESULT_MODES),
    meritOrder: meritOrderSchema.optional(),
    failedRanking: z.enum(MERIT_FAILED_RANKINGS).optional(),
    attendance: attendanceWindowSchema.nullable().optional(),
  })
  .refine((e) => e.startsOn <= e.endsOn, { message: 'Ends before it starts', path: ['endsOn'] });
export type CreateExamInput = z.input<typeof createExamSchema>;

/** PATCH /exams/:id: the result mode changes only while the exam is in setup. */
export const updateExamSchema = z
  .object({
    kind: z.enum(EXAM_KINDS),
    nameBn: examNameSchema,
    nameEn: examNameSchema,
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    resultMode: z.enum(EXAM_RESULT_MODES),
    meritOrder: meritOrderSchema,
    failedRanking: z.enum(MERIT_FAILED_RANKINGS),
    attendance: attendanceWindowSchema.nullable(),
  })
  .partial()
  .refine((e) => !e.startsOn || !e.endsOn || e.startsOn <= e.endsOn, {
    message: 'Ends before it starts',
    path: ['endsOn'],
  });
export type UpdateExamInput = z.input<typeof updateExamSchema>;

export const examsQuerySchema = z.object({ academicYearId: z.uuid().optional() });

/** PUT /exams/:id/classes: the classes the exam covers (new ones get every active subject). */
export const examClassesSchema = z.object({
  classLevelIds: z
    .array(z.uuid())
    .max(30)
    .refine((ids) => new Set(ids).size === ids.length, 'Each class once'),
});

/** PUT /exams/:id/classes/:examClassId/subjects: which subjects (kept ones keep their setup). */
export const examClassSubjectsSchema = z.object({
  subjectIds: z
    .array(z.uuid())
    .min(1)
    .max(40)
    .refine((ids) => new Set(ids).size === ids.length, 'Each subject once'),
});

const timeSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'HH:MM');

/** PUT /exams/:id/subjects/:examSubjectId: one subject's routine, parts and pass rule. */
export const examSubjectSetupSchema = z.intersection(
  z.object({ examDate: isoDateSchema.nullable(), startTime: timeSchema.nullable() }),
  subjectMarksSchema,
);
export type ExamSubjectSetupInput = z.input<typeof examSubjectSetupSchema>;

export const examCandidatesQuerySchema = z.object({ sectionId: z.uuid().optional() });

export const syncCandidatesSchema = z.object({ dryRun: z.boolean() });

export const allocateSeatsSchema = z.object({
  roomIds: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Each room once'),
});

export const admitCardsQuerySchema = z
  .object({ sectionId: z.uuid().optional(), classLevelId: z.uuid().optional() })
  .refine((q) => q.sectionId || q.classLevelId, 'A section or a class');

export interface ExamClassSummary {
  id: string;
  classLevel: CodedRef;
  isPublished: boolean;
  publishedVersion: number;
  publishedAt: string | null;
}

export interface ExamListItem {
  id: string;
  academicYearId: string;
  kind: ExamKind;
  nameBn: string;
  nameEn: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  resultMode: ExamResultMode;
  status: ExamStatus;
  classes: ExamClassSummary[];
  candidates: number;
}

export interface ExamSubjectView {
  id: string;
  subject: CodedRef;
  studyGroupId: string | null;
  isElective: boolean;
  passRule: PassRule;
  examDate: IsoDate | null;
  startTime: string | null;
  fullMarks: number;
  components: ExamComponentView[];
  passGroups: PassGroupView[];
}

export interface ExamDetail extends Omit<ExamListItem, 'classes'> {
  meritOrder: MeritKey[];
  failedRanking: MeritFailedRanking;
  attendance: { from: IsoDate; to: IsoDate } | null;
  classes: (ExamClassSummary & { subjects: ExamSubjectView[] })[];
}

export interface ExamCandidateView {
  id: string;
  student: { id: string; studentCode: string; nameBn: string | null; nameEn: string | null };
  classLevelId: string;
  section: { id: string; name: string };
  studyGroupId: string | null;
  roll: number | null;
  status: 'ENROLLED' | 'WITHDRAWN';
  seat: { roomId: string; roomName: string; seatNo: number } | null;
}

/** POST /exams/:id/candidates/sync: what changed (or would, with dryRun) since the exam opened. */
export interface CandidateSyncResult {
  dryRun: boolean;
  added: { studentId: string; name: string; sectionName: string }[];
  withdrawn: { studentId: string; name: string }[];
  moved: { studentId: string; name: string; from: string; to: string }[];
}

export interface SeatPlanRoom {
  room: ExamRoomView;
  /** Seat number → who sits there (row by row: seat 1 is the front row's first seat). */
  seats: {
    seatNo: number;
    candidateId: string;
    roll: number | null;
    studentCode: string;
    name: string;
    classLevel: CodedRef;
    sectionName: string;
  }[];
}

export interface SeatPlan {
  rooms: SeatPlanRoom[];
  unseated: number;
}

/** GET /exams/:id/admit-cards: one card per enrolled candidate (no guardian details). */
export interface AdmitCards {
  institute: { name: string };
  exam: { id: string; nameBn: string; nameEn: string; startsOn: IsoDate; endsOn: IsoDate };
  cards: {
    candidateId: string;
    student: {
      studentCode: string;
      nameBn: string | null;
      nameEn: string | null;
      photoUrl: string | null;
    };
    classLevel: CodedRef;
    section: { id: string; name: string };
    studyGroup: CodedRef | null;
    roll: number | null;
    seat: { roomName: string; seatNo: number } | null;
    routine: { subject: CodedRef; examDate: IsoDate | null; startTime: string | null }[];
  }[];
}

// ─────────────────────────── Mark sheets ───────────────────────────

export const MARK_SHEET_STATUSES = ['DRAFT', 'SUBMITTED', 'LOCKED'] as const;
export type MarkSheetStatus = (typeof MARK_SHEET_STATUSES)[number];

/**
 * One cell as typed: marks (Bangla or ASCII digits, up to 2 decimals), `a`/`অ` for absent, or ''
 * for not entered. The server parses it with `parseMarks`, as the screen does.
 */
const markEntrySchema = z.object({
  studentId: z.uuid(),
  key: z.string().trim().min(1).max(20),
  value: z.string().max(12),
});

const entriesSchema = z
  .array(markEntrySchema)
  .max(6000)
  .refine(
    (es) => new Set(es.map((e) => `${e.studentId}:${e.key}`)).size === es.length,
    'Each cell once',
  );

export const markSheetQuerySchema = z.object({
  examSubjectId: z.uuid(),
  sectionId: z.uuid(),
});

/**
 * PUT /exams/sheets: the whole sheet as the teacher has it (every student, every part). SAVE keeps
 * it a draft; SUBMIT needs every cell filled (marks or absent). `submissionId` is new for every
 * change: a retry of the same one is answered with the saved state; `baseVersion` is the version
 * the client started from (0: no sheet yet).
 */
export const saveMarkSheetSchema = z.object({
  examSubjectId: z.uuid(),
  sectionId: z.uuid(),
  submissionId: z.uuid(),
  baseVersion: z.number().int().min(0),
  action: z.enum(['SAVE', 'SUBMIT']),
  entries: entriesSchema,
});
export type SaveMarkSheetInput = z.input<typeof saveMarkSheetSchema>;

const reasonSchema = z.string().trim().min(3).max(500);

/** POST /exams/sheets/:id/return: back to the teacher, with a note they see. */
export const returnMarkSheetSchema = z.object({ note: reasonSchema });

/** POST /exams/sheets/:id/unlock: before results are published only. */
export const unlockMarkSheetSchema = z.object({ reason: reasonSchema });

/** PUT /exams/sheets/:id/corrections (OWNER/ADMIN, locked sheets): only the changed cells. */
export const correctMarksSchema = z.object({
  baseVersion: z.number().int().min(0),
  reason: reasonSchema,
  entries: entriesSchema.refine((es) => es.length > 0, 'At least one change'),
});
export type CorrectMarksInput = z.input<typeof correctMarksSchema>;

export interface MarkCell {
  scoreH: number | null;
  absent: boolean;
}

export interface MarkSheetMeta {
  id: string | null;
  status: MarkSheetStatus;
  version: number;
  returnNote: string | null;
  updatedAt: string | null;
  updatedBy: PersonRef | null;
  submittedAt: string | null;
  submittedBy: PersonRef | null;
  lockedAt: string | null;
  lockedBy: PersonRef | null;
}

export interface MarkSheetView {
  exam: {
    id: string;
    nameBn: string;
    nameEn: string;
    status: ExamStatus;
    resultMode: ExamResultMode;
  };
  examSubject: ExamSubjectView;
  section: ExamSectionRef;
  sheet: MarkSheetMeta;
  /** The class's grading (for the live grade preview); null in MARKS mode. */
  grading: { bands: GradeBandView[]; roundingMode: RoundingMode } | null;
  /**
   * TEACHER: may save and submit. ADMIN: the same, any sheet. CORRECTION: locked, admins correct
   * with a reason. READ_ONLY: locked (teachers) or the exam is archived.
   */
  mode: 'TEACHER' | 'ADMIN' | 'CORRECTION' | 'READ_ONLY';
  /** Students who sit this subject in this section, by roll (no guardian details). */
  students: {
    studentId: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
    roll: number | null;
    /** By component key; a missing key is not entered. */
    marks: Record<string, MarkCell>;
  }[];
}

export interface SaveMarkSheetResult extends MarkSheetView {
  /** This exact submissionId was already saved: nothing changed. */
  replayed: boolean;
}

/** GET /exams/my-sheets: the sheets assigned to the caller in open exams. */
export interface MySheet {
  exam: { id: string; nameBn: string; nameEn: string; kind: ExamKind; endsOn: IsoDate };
  examSubjectId: string;
  subject: CodedRef;
  section: ExamSectionRef;
  status: MarkSheetStatus;
  /** Students with every part entered, of `total`. */
  entered: number;
  total: number;
  returnNote: string | null;
}

/** GET /exams/:id/sheets (OWNER/ADMIN): every sheet of the exam, class by class. */
export interface ExamSheetsGrid {
  classes: {
    examClassId: string;
    classLevel: CodedRef;
    isPublished: boolean;
    sections: { id: string; name: string }[];
    subjects: { examSubjectId: string; subject: CodedRef }[];
    cells: {
      examSubjectId: string;
      sectionId: string;
      sheetId: string | null;
      status: MarkSheetStatus;
      entered: number;
      total: number;
      teachers: PersonRef[];
    }[];
  }[];
}

export interface LockAllResult {
  locked: number;
  /** Sheets still being entered (not submitted), left as they are. */
  notSubmitted: number;
}

export interface MarkSheetHistoryEntry {
  at: string;
  by: PersonRef | null;
  action: 'SAVE' | 'SUBMIT' | 'RETURN' | 'LOCK' | 'UNLOCK' | 'CORRECTION';
  reason: string | null;
  changes: { studentId: string; key: string; from: MarkCell | null; to: MarkCell }[];
}

// ─────────────────────────── Results ───────────────────────────

/** POST /exams/:id/classes/:examClassId/publish: `baseVersion` is the version the admin saw. */
export const publishResultsSchema = z.object({ baseVersion: z.number().int().min(0) });

export const unpublishResultsSchema = z.object({ reason: reasonSchema });

export const tabulationQuerySchema = z.object({
  sectionId: z.uuid().optional(),
  locale: z.enum(['bn', 'en']).default('bn'),
});

export const reportCardsQuerySchema = z
  .object({ sectionId: z.uuid().optional(), studentId: z.uuid().optional() })
  .refine((q) => q.sectionId || q.studentId, 'A section or a student');

export const remarksQuerySchema = z.object({ sectionId: z.uuid() });

/** PUT /exams/:id/remarks: the class teacher's (or an admin's) remark per student; '' clears. */
export const saveRemarksSchema = z.object({
  sectionId: z.uuid(),
  remarks: z
    .array(z.object({ studentId: z.uuid(), text: z.string().trim().max(300) }))
    .min(1)
    .max(500),
});
export type SaveRemarksInput = z.input<typeof saveRemarksSchema>;

export interface PublishCheck {
  examClassId: string;
  isPublished: boolean;
  publishedVersion: number;
  publishedAt: string | null;
  /** Marks or remarks changed after the last publish: republish to show them. */
  stale: boolean;
  /** Publish is refused while any of these remain. */
  blockers: {
    /** Sheets with students that are not locked yet. */
    unlockedSheets: {
      examSubjectId: string;
      subject: CodedRef;
      section: { id: string; name: string };
      status: MarkSheetStatus;
    }[];
    /** Students with a part not entered. */
    incompleteStudents: number;
  };
  warnings: {
    /** Enrolments that differ from the roster (sync the roster first if they matter). */
    rosterChanges: number;
    /** Students in a group with elective subjects but no choice recorded. */
    missingChoices: number;
  };
  students: number;
}

export interface ResultSubjectCell {
  examSubjectId: string;
  optional: boolean;
  status: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';
  obtainedH: number;
  fullMarks: number;
  letter: string | null;
  gradePoint: number | null;
  passed: boolean;
  marks: Record<string, MarkCell>;
}

export interface ResultRow {
  studentId: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  roll: number | null;
  section: { id: string; name: string };
  subjects: ResultSubjectCell[];
  totalH: number;
  fullMarks: number;
  percentH: number;
  gpaH: number | null;
  gpaWithoutOptionalH: number | null;
  letter: string | null;
  passed: boolean;
  failedSubjects: number;
  classPosition: number | null;
  sectionPosition: number | null;
  complete: boolean;
}

/** GET …/tabulation: live (PREVIEW) before publish, the published snapshot after. */
export interface Tabulation {
  exam: { id: string; nameBn: string; nameEn: string; resultMode: ExamResultMode };
  classLevel: CodedRef;
  section: { id: string; name: string } | null;
  source: 'PREVIEW' | 'PUBLISHED';
  publishedVersion: number;
  stale: boolean;
  gpaDecimals: number;
  subjects: {
    examSubjectId: string;
    subject: CodedRef;
    fullMarks: number;
    components: ExamComponentView[];
  }[];
  rows: ResultRow[];
}

export interface ReportCardSubject {
  subject: CodedRef;
  optional: boolean;
  status: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';
  components: {
    key: string;
    nameBn: string;
    nameEn: string;
    fullMarks: number;
    mark: MarkCell | null;
  }[];
  obtainedH: number;
  fullMarks: number;
  letter: string | null;
  gradePoint: number | null;
  passed: boolean;
  /** The class's highest marks in this subject. */
  highestH: number | null;
}

export interface ReportCard {
  student: {
    id: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
    photoUrl: string | null;
    /** Only for OWNER/ADMIN, the student's current section teachers and the guardian (#19). */
    fatherNameBn: string | null;
    fatherNameEn: string | null;
    motherNameBn: string | null;
    motherNameEn: string | null;
  };
  section: { id: string; name: string };
  studyGroup: CodedRef | null;
  roll: number | null;
  subjects: ReportCardSubject[];
  totalH: number;
  fullMarks: number;
  percentH: number;
  gpaH: number | null;
  gpaWithoutOptionalH: number | null;
  letter: string | null;
  passed: boolean;
  failedSubjects: number;
  classPosition: number | null;
  sectionPosition: number | null;
  classSize: number;
  attendance: { present: number; total: number; percentH: number | null } | null;
  remarks: string | null;
}

/** GET /exams/:id/report-cards and the guardian's own child's card. */
export interface ReportCards {
  institute: { name: string };
  exam: {
    id: string;
    nameBn: string;
    nameEn: string;
    kind: ExamKind;
    resultMode: ExamResultMode;
    startsOn: IsoDate;
    endsOn: IsoDate;
    attendance: { from: IsoDate; to: IsoDate } | null;
  };
  classLevel: CodedRef;
  publishedVersion: number;
  publishedAt: string;
  grading: {
    bands: GradeBandView[];
    gpaDecimals: number;
    gpaMax: number;
    optionalBonusAbove: number | null;
  } | null;
  cards: ReportCard[];
}

export interface RemarksView {
  section: { id: string; name: string };
  isPublished: boolean;
  students: {
    studentId: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
    roll: number | null;
    remarks: string | null;
  }[];
}

// ─────────────────────────── Guardians, result SMS, dashboard ───────────────────────────

/** GET /me/children/:id/results: the child's published results, newest exam first. */
export interface ChildResultItem {
  examClassId: string;
  exam: {
    id: string;
    nameBn: string;
    nameEn: string;
    kind: ExamKind;
    resultMode: ExamResultMode;
    startsOn: IsoDate;
    endsOn: IsoDate;
  };
  publishedAt: string;
  gpaH: number | null;
  gpaDecimals: number;
  letter: string | null;
  totalH: number;
  fullMarks: number;
  percentH: number;
  passed: boolean;
  classPosition: number | null;
  classSize: number;
}

/** POST …/sms: the count the admin confirmed in the preview. */
export const sendResultSmsSchema = z.object({ expectedRecipients: z.number().int().min(0) });

export interface ResultSmsPreview {
  publishedVersion: number;
  students: number;
  withoutPhone: number;
  /** Already got an SMS for this published version (each student once per version). */
  alreadySent: number;
  toSend: number;
  segments: number;
  costPaisa: number;
  capLeftToday: number;
  /** Over today's cap: not sent now (and not held); they can be sent another day. */
  wouldBeSkipped: number;
  sampleText: string | null;
}

export interface ResultSmsRun {
  runId: string;
  queued: number;
}

export interface ResultSmsStatus {
  runId: string;
  toSend: number;
  counts: { QUEUED: number; SENT: number; FAILED: number; CANCELLED: number };
  /** Not queued: over the daily cap when the job ran. */
  skipped: number;
}

/** GET /exams/summary: the dashboard's exam card (staff). */
export interface ExamsSummary {
  /** The exam whose marks are being entered (the open one ending soonest), with sheet counts. */
  current: {
    id: string;
    nameBn: string;
    nameEn: string;
    endsOn: IsoDate;
    sheets: { total: number; draft: number; submitted: number; locked: number };
    publishedClasses: number;
    classes: number;
  } | null;
  /** This year's exams that have not ended yet (for the term timeline). */
  upcoming: {
    id: string;
    kind: ExamKind;
    nameBn: string;
    nameEn: string;
    startsOn: IsoDate;
    endsOn: IsoDate;
  }[];
  /** The caller's own sheets in open exams that are not submitted yet (teachers). */
  myPendingSheets: number;
}
