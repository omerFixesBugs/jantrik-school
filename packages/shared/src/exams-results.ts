/**
 * A class's results from its marks (step 10): every student's subjects and result, merit places in
 * the class and in each section, and per-subject stats. Pure: the API loads the rows, this decides.
 */
import {
  applicableSubjects,
  formatGpa,
  formatMarks,
  formatPercentH,
  studentResult,
  subjectResult,
  type ComponentSpec,
  type ExamResultMode,
  type GpaRules,
  type MarkEntry,
  type MeritFailedRanking,
  type MeritKey,
  type PassGroupSpec,
  type PassRule,
  type StudentResult,
  type SubjectChoiceRef,
  type SubjectResult,
} from './exams.js';
import { formatCount } from './format.js';
import type { GradeBand, RoundingMode } from './grading.js';

// ── Merit ──

export interface MeritRow {
  id: string;
  sectionId: string;
  roll: number | null;
  passed: boolean;
  gpaH: number | null;
  gpaWithoutOptionalH: number | null;
  totalH: number;
  percentH: number;
  failedSubjects: number;
  /** Marks per subject id (for SUBJECT:<id> tie-breakers). */
  subjectTotalsH: Record<string, number>;
}

/** Higher is better, as a number to compare (rows missing a value sort last). */
function keyValue(row: MeritRow, key: MeritKey): number {
  switch (key) {
    case 'GPA':
      return row.gpaH ?? -1;
    case 'GPA_WITHOUT_OPTIONAL':
      return row.gpaWithoutOptionalH ?? -1;
    case 'TOTAL_MARKS':
      return row.totalH;
    case 'PERCENT':
      return row.percentH;
    case 'FEWER_FAILED_SUBJECTS':
      return -row.failedSubjects;
    case 'ROLL':
      return row.roll === null ? Number.NEGATIVE_INFINITY : -row.roll;
    default:
      return row.subjectTotalsH[key.slice('SUBJECT:'.length)] ?? -1;
  }
}

/**
 * Merit places: passed students first; then each key in turn. Students equal on every key share
 * a place, and the next place skips (1, 2, 2, 4). In MARKS mode the GPA keys are ignored. With
 * UNRANKED, failed students get no place (null).
 */
export function meritPositions(
  rows: readonly MeritRow[],
  order: readonly MeritKey[],
  failedRanking: MeritFailedRanking,
  mode: ExamResultMode,
): Map<string, number | null> {
  const keys = order.filter((k) => mode === 'GPA' || (k !== 'GPA' && k !== 'GPA_WITHOUT_OPTIONAL'));
  const out = new Map<string, number | null>();
  const ranked = rows.filter((r) => r.passed || failedRanking === 'AFTER_PASSED');
  for (const r of rows) if (!ranked.includes(r)) out.set(r.id, null);
  const compare = (a: MeritRow, b: MeritRow): number => {
    if (a.passed !== b.passed) return a.passed ? -1 : 1;
    for (const key of keys) {
      const d = keyValue(b, key) - keyValue(a, key);
      if (d !== 0) return d;
    }
    return 0;
  };
  const sorted = [...ranked].sort(compare);
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    out.set(r.id, prev && compare(prev, r) === 0 ? out.get(prev.id)! : i + 1);
  });
  return out;
}

// ── A class's results ──

export interface ClassSubjectInput {
  examSubjectId: string;
  subjectId: string;
  studyGroupId: string | null;
  isElective: boolean;
  passRule: PassRule;
  components: ComponentSpec[];
  passGroups: PassGroupSpec[];
}

export interface ClassCandidateInput {
  studentId: string;
  sectionId: string;
  roll: number | null;
  studyGroupId: string | null;
  choices: SubjectChoiceRef[];
}

export interface ClassResultsInput {
  mode: ExamResultMode;
  bands: readonly GradeBand[];
  roundingMode: RoundingMode;
  rules: GpaRules;
  meritOrder: MeritKey[];
  failedRanking: MeritFailedRanking;
  subjects: ClassSubjectInput[];
  candidates: ClassCandidateInput[];
  /** `${examSubjectId}:${studentId}` → marks by component key. */
  marks: Map<string, Record<string, MarkEntry>>;
}

export interface StudentSubjectOutcome {
  examSubjectId: string;
  subjectId: string;
  optional: boolean;
  result: SubjectResult;
  /** The part marks as entered (key → marks), for the report card. */
  marks: Record<string, MarkEntry>;
}

export interface StudentOutcome {
  studentId: string;
  sectionId: string;
  roll: number | null;
  subjects: StudentSubjectOutcome[];
  result: StudentResult;
  classPosition: number | null;
  sectionPosition: number | null;
}

export interface ClassResults {
  students: StudentOutcome[];
  /** Per exam subject: how many sat it, the highest and the average marks (hundredths). */
  subjectStats: Record<string, { sat: number; highestH: number; averageH: number }>;
  /** Students with a part not entered (no result, no place). */
  incomplete: string[];
}

export function computeClassResults(input: ClassResultsInput): ClassResults {
  const refs = input.subjects.map((s) => ({
    subjectId: s.subjectId,
    studyGroupId: s.studyGroupId,
    isElective: s.isElective,
  }));
  const bySubjectId = new Map(input.subjects.map((s) => [s.subjectId, s]));
  const bands = input.mode === 'GPA' ? input.bands : null;

  const students: StudentOutcome[] = input.candidates.map((c) => {
    const taken = applicableSubjects(refs, { studyGroupId: c.studyGroupId }, c.choices);
    const subjects = taken.map(({ subjectId, optional }) => {
      const s = bySubjectId.get(subjectId)!;
      const marks = input.marks.get(`${s.examSubjectId}:${c.studentId}`) ?? {};
      return {
        examSubjectId: s.examSubjectId,
        subjectId,
        // Only GPA mode has a 4th subject; in MARKS mode every subject counts the same.
        optional: input.mode === 'GPA' && optional,
        result: subjectResult({
          passRule: s.passRule,
          components: s.components,
          passGroups: s.passGroups,
          marks,
          bands,
          roundingMode: input.roundingMode,
        }),
        marks,
      };
    });
    const result =
      input.mode === 'GPA'
        ? studentResult({ mode: 'GPA', subjects, bands: input.bands, rules: input.rules })
        : studentResult({ mode: 'MARKS', subjects });
    return {
      studentId: c.studentId,
      sectionId: c.sectionId,
      roll: c.roll,
      subjects,
      result,
      classPosition: null,
      sectionPosition: null,
    };
  });

  const complete = students.filter((s) => s.result.complete);
  const meritRows = complete.map((s): MeritRow => ({
    id: s.studentId,
    sectionId: s.sectionId,
    roll: s.roll,
    passed: s.result.passed,
    gpaH: s.result.gpaH,
    gpaWithoutOptionalH: s.result.gpaWithoutOptionalH,
    totalH: s.result.totalH,
    percentH: s.result.percentH,
    failedSubjects: s.result.failedSubjects,
    subjectTotalsH: Object.fromEntries(s.subjects.map((x) => [x.subjectId, x.result.obtainedH])),
  }));
  const classPlaces = meritPositions(meritRows, input.meritOrder, input.failedRanking, input.mode);
  const sectionPlaces = new Map<string, number | null>();
  for (const sectionId of new Set(meritRows.map((r) => r.sectionId))) {
    const places = meritPositions(
      meritRows.filter((r) => r.sectionId === sectionId),
      input.meritOrder,
      input.failedRanking,
      input.mode,
    );
    for (const [id, p] of places) sectionPlaces.set(id, p);
  }
  for (const s of students) {
    s.classPosition = classPlaces.get(s.studentId) ?? null;
    s.sectionPosition = sectionPlaces.get(s.studentId) ?? null;
  }

  const subjectStats: ClassResults['subjectStats'] = {};
  for (const subject of input.subjects) {
    const scores = students.flatMap((st) =>
      st.subjects
        .filter(
          (x) => x.examSubjectId === subject.examSubjectId && x.result.status !== 'INCOMPLETE',
        )
        .map((x) => x.result.obtainedH),
    );
    subjectStats[subject.examSubjectId] = {
      sat: scores.length,
      highestH: scores.length > 0 ? Math.max(...scores) : 0,
      averageH:
        scores.length > 0
          ? Math.floor(
              (2 * scores.reduce((a, b) => a + b, 0) + scores.length) / (2 * scores.length),
            )
          : 0,
    };
  }

  return {
    students,
    subjectStats,
    incomplete: students.filter((s) => !s.result.complete).map((s) => s.studentId),
  };
}

// ── Result SMS ──

/**
 * The result SMS to the primary guardian: fixed Bangla, quantities in Bangla digits. GPA mode
 * gives the GPA and letter, MARKS mode the marks and percent; the class place when ranked.
 */
export function resultSmsText(input: {
  institute: string;
  student: string;
  exam: string;
  mode: ExamResultMode;
  gpaH: number | null;
  gpaDecimals: number;
  letter: string | null;
  totalH: number;
  fullMarks: number;
  percentH: number;
  classPosition: number | null;
}): string {
  const outcome =
    input.mode === 'GPA'
      ? `জিপিএ ${formatGpa(input.gpaH ?? 0, input.gpaDecimals, 'bn')} (${input.letter ?? 'F'})`
      : `প্রাপ্ত নম্বর ${formatMarks(input.totalH, 'bn')}/${formatCount(input.fullMarks, 'bn')} (${formatPercentH(input.percentH, 'bn')}%)`;
  const place = input.classPosition ? `, মেধাক্রম ${formatCount(input.classPosition, 'bn')}` : '';
  return `${input.institute}: ${input.student}, ${input.exam} ফলাফল — ${outcome}${place}।`;
}
