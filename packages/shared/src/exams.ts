/**
 * Exam rules (step 10). Every Bangladesh-specific rule is data: the grading scheme's bands,
 * rounding mode and GPA rules, the subject's pass rule, parts and pass marks. Nothing here
 * branches on an institute type.
 *
 * Marks are integer hundredths (`*H`, like paisa), so 22.5 is 2250 and every comparison is exact.
 */
import { toAsciiDigits, toBanglaDigits } from './digits.js';
import type { UiLocale } from './format.js';
import type { GradeBand, GradeResult, RoundingMode } from './grading.js';

// ── Data the database stores (mirrors the DB enums) ──

export const COMPONENT_KINDS = ['CQ', 'MCQ', 'PRACTICAL', 'WRITTEN', 'ORAL', 'OTHER'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** PER_COMPONENT: every part meets its own pass mark. COMBINED: same-kind parts are summed. */
export const PASS_RULES = ['PER_COMPONENT', 'COMBINED'] as const;
export type PassRule = (typeof PASS_RULES)[number];

export const GPA_ROUNDINGS = ['TRUNCATE', 'ROUND_HALF_UP'] as const;
export type GpaRounding = (typeof GPA_ROUNDINGS)[number];

export const SUBJECT_CHOICE_KINDS = ['COMPULSORY', 'OPTIONAL'] as const;
export type SubjectChoiceKind = (typeof SUBJECT_CHOICE_KINDS)[number];

export const EXAM_KINDS = [
  'HALF_YEARLY',
  'ANNUAL',
  'PRE_TEST',
  'TEST',
  'CLASS_TEST',
  'MODEL_TEST',
  'OTHER',
] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];

export const EXAM_RESULT_MODES = ['GPA', 'MARKS'] as const;

export const EXAM_STATUSES = ['SETUP', 'OPEN', 'ARCHIVED'] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const MERIT_FAILED_RANKINGS = ['AFTER_PASSED', 'UNRANKED'] as const;
export type MeritFailedRanking = (typeof MERIT_FAILED_RANKINGS)[number];

/** Merit tie-breakers; `SUBJECT:<subjectId>` ranks by the marks in one subject. */
export const MERIT_KEYS = [
  'GPA',
  'GPA_WITHOUT_OPTIONAL',
  'TOTAL_MARKS',
  'PERCENT',
  'FEWER_FAILED_SUBJECTS',
  'ROLL',
] as const;
export type MeritKey = (typeof MERIT_KEYS)[number] | `SUBJECT:${string}`;

/** A new exam's merit order until the institute picks its own (prefilled from its last exam). */
export const DEFAULT_MERIT_ORDER: Record<ExamResultMode, MeritKey[]> = {
  GPA: ['GPA', 'TOTAL_MARKS', 'ROLL'],
  MARKS: ['TOTAL_MARKS', 'ROLL'],
};

/** What an exam kind usually is (a form default only; the exam stores its own mode). */
export const USUAL_RESULT_MODE: Record<ExamKind, ExamResultMode> = {
  HALF_YEARLY: 'GPA',
  ANNUAL: 'GPA',
  PRE_TEST: 'GPA',
  TEST: 'GPA',
  CLASS_TEST: 'MARKS',
  MODEL_TEST: 'MARKS',
  OTHER: 'GPA',
};

/** A grading scheme's GPA rules (grading_schemes columns). */
export interface GpaRules {
  gpaMax: number;
  /** The 4th subject adds only its points above this; null: no bonus. */
  optionalBonusAbove: number | null;
  gpaDecimals: number;
  gpaRounding: GpaRounding;
  /** One failed compulsory subject makes the GPA 0. */
  compulsoryFailZero: boolean;
}

export interface ComponentSpec {
  key: string;
  kind: ComponentKind;
  fullMarks: number;
  /** Used under PER_COMPONENT; null: this part has no pass mark of its own. */
  passMarks: number | null;
}

export interface PassGroupSpec {
  kind: ComponentKind;
  passMarks: number;
}

/** One part's entry; a part with no entry (or neither marks nor absent) is blank. */
export interface MarkEntry {
  scoreH: number | null;
  absent: boolean;
}

// ── Typing marks ──

export type ParsedMarks =
  | { kind: 'blank' }
  | { kind: 'absent' }
  | { kind: 'marks'; hundredths: number }
  | { kind: 'invalid'; reason: 'NOT_A_NUMBER' | 'TOO_PRECISE' | 'OVER_FULL' };

const ABSENT_WORDS = new Set(['a', 'ab', 'অ']);
const MARKS_RE = /^(\d*)(?:\.(\d*))?$/;

/**
 * What a teacher typed into a marks field: Bangla or ASCII digits, at most 2 decimals, at most the
 * full marks. `a`, `ab` or `অ` marks the student absent; an empty field is not entered yet.
 */
export function parseMarks(text: string, fullMarks: number): ParsedMarks {
  const t = toAsciiDigits(text.trim());
  if (t === '') return { kind: 'blank' };
  if (ABSENT_WORDS.has(t.toLowerCase())) return { kind: 'absent' };
  const match = MARKS_RE.exec(t);
  if (!match || (match[1] === '' && !match[2])) return { kind: 'invalid', reason: 'NOT_A_NUMBER' };
  const fraction = match[2] ?? '';
  if (fraction.length > 2) return { kind: 'invalid', reason: 'TOO_PRECISE' };
  const hundredths = Number(match[1] || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (hundredths > fullMarks * 100) return { kind: 'invalid', reason: 'OVER_FULL' };
  return { kind: 'marks', hundredths };
}

/** Marks for display: "56.5" / "৫৬.৫", no trailing zeros. */
export function formatMarks(hundredths: number, locale: UiLocale): string {
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  const text =
    cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
  return locale === 'bn' ? toBanglaDigits(text) : text;
}

/** A GPA with its scheme's decimals: "4.50" / "৪.৫০". */
export function formatGpa(gpaH: number, decimals: number, locale: UiLocale): string {
  const text = (gpaH / 100).toFixed(decimals);
  return locale === 'bn' ? toBanglaDigits(text) : text;
}

/** A percentage stored in hundredths: "66.67" / "৬৬.৬৭". */
export function formatPercentH(percentH: number, locale: UiLocale): string {
  return formatMarks(percentH, locale);
}

// ── Grades ──

const toH = (n: number) => Math.round(n * 100);

/**
 * The band for marks out of `fullMarks`, compared exactly. The scheme's rounding applies to the
 * percentage first (to a whole percent for ROUND_HALF_UP and CEIL), as in `calculateGrade`.
 */
export function gradeForMarks(
  obtainedH: number,
  fullMarks: number,
  bands: readonly GradeBand[],
  roundingMode: RoundingMode,
): GradeResult {
  // percent = obtainedH / fullMarks (obtainedH is marks × 100).
  let atLeast: (minPercent: number) => boolean;
  let percent: number;
  switch (roundingMode) {
    case 'NONE':
      atLeast = (min) => toH(min) * fullMarks <= obtainedH * 100;
      percent = obtainedH / fullMarks;
      break;
    case 'ROUND_HALF_UP': {
      const whole = Math.floor((2 * obtainedH + fullMarks) / (2 * fullMarks));
      atLeast = (min) => min <= whole;
      percent = whole;
      break;
    }
    case 'CEIL': {
      const whole = Math.floor((obtainedH + fullMarks - 1) / fullMarks);
      atLeast = (min) => min <= whole;
      percent = whole;
      break;
    }
  }
  let match: GradeBand | undefined;
  for (const band of bands) {
    if (atLeast(band.minPercent) && (!match || band.minPercent > match.minPercent)) match = band;
  }
  if (!match) throw new RangeError(`No grade band covers ${obtainedH / 100} of ${fullMarks}`);
  return { letter: match.letter, gradePoint: match.gradePoint, percent };
}

/** The fail band: grade point 0 (the lowest band if a scheme has none at 0). */
export function failBand(bands: readonly GradeBand[]): GradeBand {
  const zero = bands.filter((b) => b.gradePoint === 0);
  const pool = zero.length > 0 ? zero : bands;
  return pool.reduce((low, b) =>
    b.gradePoint < low.gradePoint || b.minPercent < low.minPercent ? b : low,
  );
}

/**
 * Pass marks to suggest for a part: the lowest passing band's percentage (33% in Bangladesh) of
 * the full marks, rounded half up. 70 → 23, 30 → 10, 25 → 8, 140 → 46.
 */
export function suggestedPassMarks(fullMarks: number, bands: readonly GradeBand[]): number {
  const passing = bands.filter((b) => b.gradePoint > 0).map((b) => toH(b.minPercent));
  const passPercentH = passing.length > 0 ? Math.min(...passing) : 0;
  return Math.floor((2 * fullMarks * passPercentH + 10_000) / 20_000);
}

/** The letter for a GPA: the band with the highest grade point at or below it. */
export function gpaLetter(gpaH: number, bands: readonly GradeBand[]): string {
  let match: GradeBand | undefined;
  for (const band of bands) {
    if (toH(band.gradePoint) <= gpaH && (!match || band.gradePoint > match.gradePoint))
      match = band;
  }
  return (match ?? failBand(bands)).letter;
}

// ── One subject ──

export type SubjectStatus = 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';

export interface SubjectResult {
  status: SubjectStatus;
  /** Absent parts count 0. */
  obtainedH: number;
  fullMarks: number;
  passed: boolean;
  /** Absent parts, and parts under their own pass mark (PER_COMPONENT). */
  failedComponents: string[];
  /** Kinds whose summed marks are under the combined pass mark (COMBINED). */
  failedKinds: ComponentKind[];
  /** Null without bands (MARKS mode) or while incomplete. */
  letter: string | null;
  gradePoint: number | null;
}

export interface SubjectResultInput {
  passRule: PassRule;
  components: readonly ComponentSpec[];
  passGroups: readonly PassGroupSpec[];
  /** By component key. */
  marks: Readonly<Record<string, MarkEntry | undefined>>;
  /** Null in MARKS mode: pass marks still decide pass/fail, but there is no letter. */
  bands: readonly GradeBand[] | null;
  roundingMode: RoundingMode;
}

/**
 * A subject's result. Absent in any part fails it. Under PER_COMPONENT a part under its own
 * pass mark fails it; under COMBINED the parts of one kind are summed across papers and checked
 * against that kind's combined pass mark (kinds without one are not checked). A passing subject
 * gets the band of its total percentage; a 0-point band is a fail.
 */
export function subjectResult(input: SubjectResultInput): SubjectResult {
  const { components, marks } = input;
  const fullMarks = components.reduce((n, c) => n + c.fullMarks, 0);
  const entries = components.map((c) => ({ c, e: marks[c.key] }));
  const blank = entries.some(({ e }) => !e || (!e.absent && e.scoreH === null));
  const obtainedH = entries.reduce((n, { e }) => n + (e && !e.absent ? (e.scoreH ?? 0) : 0), 0);
  if (blank) {
    return {
      status: 'INCOMPLETE',
      obtainedH,
      fullMarks,
      passed: false,
      failedComponents: [],
      failedKinds: [],
      letter: null,
      gradePoint: null,
    };
  }
  const allAbsent = entries.length > 0 && entries.every(({ e }) => e!.absent);
  const failedComponents = entries
    .filter(
      ({ c, e }) =>
        e!.absent ||
        (input.passRule === 'PER_COMPONENT' &&
          c.passMarks !== null &&
          e!.scoreH! < c.passMarks * 100),
    )
    .map(({ c }) => c.key);
  const failedKinds: ComponentKind[] = [];
  if (input.passRule === 'COMBINED') {
    for (const group of input.passGroups) {
      const sum = entries
        .filter(({ c }) => c.kind === group.kind)
        .reduce((n, { e }) => n + (e!.absent ? 0 : e!.scoreH!), 0);
      if (sum < group.passMarks * 100) failedKinds.push(group.kind);
    }
  }
  const failed = failedComponents.length > 0 || failedKinds.length > 0;
  const status: SubjectStatus = allAbsent ? 'ABSENT' : 'COMPLETE';
  if (!input.bands) {
    return {
      status,
      obtainedH,
      fullMarks,
      passed: !failed,
      failedComponents,
      failedKinds,
      letter: null,
      gradePoint: null,
    };
  }
  const band = failed
    ? failBand(input.bands)
    : gradeForMarks(obtainedH, fullMarks, input.bands, input.roundingMode);
  return {
    status,
    obtainedH,
    fullMarks,
    passed: !failed && band.gradePoint > 0,
    failedComponents,
    failedKinds,
    letter: band.letter,
    gradePoint: band.gradePoint,
  };
}

// ── One student ──

export type ExamResultMode = (typeof EXAM_RESULT_MODES)[number];

export interface StudentSubject {
  /** The 4th subject (only its points above the threshold count). */
  optional: boolean;
  result: SubjectResult;
}

export interface StudentResult {
  /** Every subject entered (marks or absent in every part). */
  complete: boolean;
  /** All subjects, the 4th included. */
  totalH: number;
  fullMarks: number;
  /** Hundredths of a percent, rounded half up. */
  percentH: number;
  passed: boolean;
  /** Failed compulsory subjects (GPA mode); failed subjects (MARKS mode). */
  failedSubjects: number;
  gpaH: number | null;
  gpaWithoutOptionalH: number | null;
  letter: string | null;
}

export type StudentResultInput =
  | {
      mode: 'GPA';
      subjects: readonly StudentSubject[];
      bands: readonly GradeBand[];
      rules: GpaRules;
    }
  | { mode: 'MARKS'; subjects: readonly StudentSubject[] };

/** `sumH / n` cut to `decimals` (as hundredths) by the rounding rule. */
export function cutGpa(sumH: number, n: number, decimals: number, rounding: GpaRounding): number {
  const step = 10 ** (2 - decimals);
  const units =
    rounding === 'TRUNCATE'
      ? Math.floor(sumH / (n * step))
      : Math.floor((2 * sumH + n * step) / (2 * n * step));
  return units * step;
}

/**
 * A student's result. GPA mode (NCTB): the average of the compulsory subjects' points plus the
 * 4th subject's points above the threshold, capped, then cut to the scheme's decimals; with
 * `compulsoryFailZero`, one failed compulsory subject makes it 0. A failed 4th subject adds
 * nothing and fails nobody. MARKS mode (coaching model tests): total and percentage only.
 */
export function studentResult(input: StudentResultInput): StudentResult {
  const subjects = input.subjects;
  const totalH = subjects.reduce((n, s) => n + s.result.obtainedH, 0);
  const fullMarks = subjects.reduce((n, s) => n + s.result.fullMarks, 0);
  const percentH =
    fullMarks === 0 ? 0 : Math.floor((2 * totalH * 100 + fullMarks) / (2 * fullMarks));
  const complete = subjects.every((s) => s.result.status !== 'INCOMPLETE');
  const base = { complete, totalH, fullMarks, percentH };

  if (input.mode === 'MARKS') {
    const failedSubjects = subjects.filter((s) => !s.result.passed).length;
    return {
      ...base,
      passed: complete && failedSubjects === 0,
      failedSubjects,
      gpaH: null,
      gpaWithoutOptionalH: null,
      letter: null,
    };
  }

  const { bands, rules } = input;
  const compulsory = subjects.filter((s) => !s.optional);
  const optional = subjects.find((s) => s.optional);
  const failedSubjects = compulsory.filter((s) => !s.result.passed).length;
  const passed = complete && compulsory.length > 0 && failedSubjects === 0;
  if (!complete || compulsory.length === 0) {
    return { ...base, passed, failedSubjects, gpaH: null, gpaWithoutOptionalH: null, letter: null };
  }
  if (failedSubjects > 0 && rules.compulsoryFailZero) {
    return {
      ...base,
      passed,
      failedSubjects,
      gpaH: 0,
      gpaWithoutOptionalH: 0,
      letter: failBand(bands).letter,
    };
  }
  const n = compulsory.length;
  const sumH = compulsory.reduce((total, s) => total + toH(s.result.gradePoint ?? 0), 0);
  const bonusH =
    optional && rules.optionalBonusAbove !== null
      ? Math.max(0, toH(optional.result.gradePoint ?? 0) - toH(rules.optionalBonusAbove))
      : 0;
  const capH = toH(rules.gpaMax);
  const gpaH = Math.min(capH, cutGpa(sumH + bonusH, n, rules.gpaDecimals, rules.gpaRounding));
  const gpaWithoutOptionalH = Math.min(capH, cutGpa(sumH, n, rules.gpaDecimals, rules.gpaRounding));
  return {
    ...base,
    passed,
    failedSubjects,
    gpaH,
    gpaWithoutOptionalH,
    letter: gpaLetter(gpaH, bands),
  };
}

// ── Which subjects a student takes ──

export interface ExamSubjectRef {
  subjectId: string;
  /** Null: every group takes it. */
  studyGroupId: string | null;
  /** In the elective pool: taken only when the student chose it. */
  isElective: boolean;
}

export interface SubjectChoiceRef {
  subjectId: string;
  kind: SubjectChoiceKind;
}

/**
 * The subjects a student takes in an exam, in the exam's order: those for every group or the
 * student's group, electives only when chosen. The choice of kind OPTIONAL is the 4th subject.
 */
export function applicableSubjects(
  subjects: readonly ExamSubjectRef[],
  student: { studyGroupId: string | null },
  choices: readonly SubjectChoiceRef[],
): { subjectId: string; optional: boolean }[] {
  const chosen = new Map(choices.map((c) => [c.subjectId, c.kind]));
  return subjects
    .filter((s) => s.studyGroupId === null || s.studyGroupId === student.studyGroupId)
    .filter((s) => !s.isElective || chosen.has(s.subjectId))
    .map((s) => ({
      subjectId: s.subjectId,
      optional: s.isElective && chosen.get(s.subjectId) === 'OPTIONAL',
    }));
}
