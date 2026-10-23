import { describe, expect, it } from 'vitest';
import {
  applicableSubjects,
  cutGpa,
  formatGpa,
  formatMarks,
  gradeForMarks,
  parseMarks,
  studentResult,
  subjectResult,
  suggestedPassMarks,
  type ComponentSpec,
  type GpaRules,
  type MarkEntry,
  type SubjectResult,
} from './exams.js';
import { calculateGrade, type GradeBand, type RoundingMode } from './grading.js';

// Bangladesh GPA 5.0
const GPA5: GradeBand[] = [
  { minPercent: 80, letter: 'A+', gradePoint: 5 },
  { minPercent: 70, letter: 'A', gradePoint: 4 },
  { minPercent: 60, letter: 'A-', gradePoint: 3.5 },
  { minPercent: 50, letter: 'B', gradePoint: 3 },
  { minPercent: 40, letter: 'C', gradePoint: 2 },
  { minPercent: 33, letter: 'D', gradePoint: 1 },
  { minPercent: 0, letter: 'F', gradePoint: 0 },
];

const NCTB: GpaRules = {
  gpaMax: 5,
  optionalBonusAbove: 2,
  gpaDecimals: 2,
  gpaRounding: 'TRUNCATE',
  compulsoryFailZero: true,
};

const h = (marks: number) => Math.round(marks * 100);
const m = (marks: number): MarkEntry => ({ scoreH: h(marks), absent: false });
const AB: MarkEntry = { scoreH: null, absent: true };

const CQ70: ComponentSpec = { key: 'CQ', kind: 'CQ', fullMarks: 70, passMarks: 23 };
const MCQ30: ComponentSpec = { key: 'MCQ', kind: 'MCQ', fullMarks: 30, passMarks: 10 };
const SCIENCE: ComponentSpec[] = [
  { key: 'CQ', kind: 'CQ', fullMarks: 50, passMarks: 17 },
  { key: 'MCQ', kind: 'MCQ', fullMarks: 25, passMarks: 8 },
  { key: 'PRACTICAL', kind: 'PRACTICAL', fullMarks: 25, passMarks: 8 },
];
// Bangla 9–10: two papers, CQ and MCQ summed across papers (COMBINED).
const BANGLA: ComponentSpec[] = [
  { key: 'P1_CQ', kind: 'CQ', fullMarks: 70, passMarks: 23 },
  { key: 'P1_MCQ', kind: 'MCQ', fullMarks: 30, passMarks: 10 },
  { key: 'P2_CQ', kind: 'CQ', fullMarks: 70, passMarks: 23 },
  { key: 'P2_MCQ', kind: 'MCQ', fullMarks: 30, passMarks: 10 },
];
const BANGLA_GROUPS = [
  { kind: 'CQ' as const, passMarks: 46 },
  { kind: 'MCQ' as const, passMarks: 20 },
];

const perComponent = (components: ComponentSpec[], marks: Record<string, MarkEntry>) =>
  subjectResult({
    passRule: 'PER_COMPONENT',
    components,
    passGroups: [],
    marks,
    bands: GPA5,
    roundingMode: 'NONE',
  });
const combined = (marks: Record<string, MarkEntry>, components = BANGLA) =>
  subjectResult({
    passRule: 'COMBINED',
    components,
    passGroups: BANGLA_GROUPS,
    marks,
    bands: GPA5,
    roundingMode: 'NONE',
  });

describe('parseMarks: what a teacher types', () => {
  it.each([
    ['56', 5600],
    ['৫৬.৫', 5650],
    ['56.25', 5625],
    ['0', 0],
    ['0.5', 50],
    ['.5', 50],
    ['  70 ', 7000],
    ['100', 10000],
  ])('%s → %s hundredths', (text, hundredths) => {
    expect(parseMarks(text, 100)).toEqual({ kind: 'marks', hundredths });
  });

  it.each(['a', 'A', 'ab', 'AB', 'Ab', 'অ'])('%s means absent', (text) => {
    expect(parseMarks(text, 100)).toEqual({ kind: 'absent' });
  });

  it('empty means not entered yet', () => {
    expect(parseMarks('', 100)).toEqual({ kind: 'blank' });
    expect(parseMarks('   ', 100)).toEqual({ kind: 'blank' });
  });

  it.each([
    ['56.255', 'TOO_PRECISE'],
    ['101', 'OVER_FULL'],
    ['70.5', 'OVER_FULL', 70],
    ['-1', 'NOT_A_NUMBER'],
    ['12a', 'NOT_A_NUMBER'],
    ['5,5', 'NOT_A_NUMBER'],
    ['1.2.3', 'NOT_A_NUMBER'],
  ])('%s is refused (%s)', (text, reason, full = 100) => {
    expect(parseMarks(text, full)).toEqual({ kind: 'invalid', reason });
  });

  it('formats marks back without trailing zeros, digits by language', () => {
    expect(formatMarks(5650, 'bn')).toBe('৫৬.৫');
    expect(formatMarks(5600, 'en')).toBe('56');
    expect(formatMarks(5625, 'en')).toBe('56.25');
    expect(formatMarks(5, 'en')).toBe('0.05');
  });
});

describe('gradeForMarks: exact percentages, the scheme rounding', () => {
  it.each<[number, number, RoundingMode, string]>([
    [79.5, 100, 'NONE', 'A'],
    [79.5, 100, 'ROUND_HALF_UP', 'A+'],
    [79.49, 100, 'ROUND_HALF_UP', 'A'],
    [79.01, 100, 'CEIL', 'A+'],
    [32.5, 100, 'NONE', 'F'],
    [32.5, 100, 'ROUND_HALF_UP', 'D'],
    [33, 100, 'NONE', 'D'],
    [16.5, 50, 'NONE', 'D'], // 33% exactly of 50
    [16.49, 50, 'NONE', 'F'],
    [56, 70, 'NONE', 'A+'], // 80% of 70
    [55.99, 70, 'NONE', 'A'],
  ])('%s of %s with %s → %s', (marks, full, mode, letter) => {
    expect(gradeForMarks(h(marks), full, GPA5, mode).letter).toBe(letter);
  });

  it('agrees with calculateGrade for every hundredth of a 100-mark paper', () => {
    for (const mode of ['NONE', 'ROUND_HALF_UP', 'CEIL'] as const) {
      for (let scoreH = 0; scoreH <= 10_000; scoreH += 7) {
        expect(gradeForMarks(scoreH, 100, GPA5, mode).letter).toBe(
          calculateGrade(scoreH / 100, GPA5, mode).letter,
        );
      }
    }
  });

  it('suggests pass marks at the lowest passing band (33%), rounded half up', () => {
    expect([70, 30, 50, 25, 100, 140, 60, 200].map((f) => suggestedPassMarks(f, GPA5))).toEqual([
      23, 10, 17, 8, 33, 46, 20, 66,
    ]);
  });
});

describe('subjectResult: PER_COMPONENT', () => {
  it('a failed component fails the subject even with 80% or more in total', () => {
    const r = perComponent(SCIENCE, { CQ: m(50), MCQ: m(25), PRACTICAL: m(7.5) });
    expect(r).toMatchObject({
      status: 'COMPLETE',
      obtainedH: h(82.5),
      fullMarks: 100,
      passed: false,
      letter: 'F',
      gradePoint: 0,
      failedComponents: ['PRACTICAL'],
    });
  });

  it('22.5 of 70 against a pass mark of 23 fails (raw marks, no rounding)', () => {
    expect(perComponent([CQ70, MCQ30], { CQ: m(22.5), MCQ: m(30) })).toMatchObject({
      passed: false,
      letter: 'F',
      failedComponents: ['CQ'],
    });
    expect(perComponent([CQ70, MCQ30], { CQ: m(23), MCQ: m(30) })).toMatchObject({
      passed: true,
      letter: 'B',
      gradePoint: 3,
    });
  });

  it('absent in MCQ fails the subject; absent in every part is "absent"', () => {
    expect(perComponent([CQ70, MCQ30], { CQ: m(70), MCQ: AB })).toMatchObject({
      status: 'COMPLETE',
      passed: false,
      letter: 'F',
      obtainedH: h(70),
      failedComponents: ['MCQ'],
    });
    expect(perComponent([CQ70, MCQ30], { CQ: AB, MCQ: AB })).toMatchObject({
      status: 'ABSENT',
      passed: false,
      letter: 'F',
      obtainedH: 0,
    });
  });

  it('a part not entered yet leaves the subject incomplete', () => {
    expect(perComponent([CQ70, MCQ30], { CQ: m(50) })).toMatchObject({
      status: 'INCOMPLETE',
      passed: false,
      letter: null,
      gradePoint: null,
    });
  });

  it('a part without a pass mark is never failed on its own', () => {
    const oral: ComponentSpec = { key: 'ORAL', kind: 'ORAL', fullMarks: 10, passMarks: null };
    expect(perComponent([CQ70, MCQ30, oral], { CQ: m(60), MCQ: m(25), ORAL: m(0) })).toMatchObject({
      passed: true,
      letter: 'A',
      failedComponents: [],
    });
  });

  it('a 0-point band fails even without failed parts (total under 33%)', () => {
    const plain: ComponentSpec = { key: 'W', kind: 'WRITTEN', fullMarks: 100, passMarks: null };
    expect(perComponent([plain], { W: m(32) })).toMatchObject({ passed: false, letter: 'F' });
  });
});

describe('subjectResult: COMBINED (two papers)', () => {
  it('P1_CQ 20 + P2_CQ 26 = 46 passes although P1_CQ is under 23', () => {
    expect(combined({ P1_CQ: m(20), P2_CQ: m(26), P1_MCQ: m(10), P2_MCQ: m(10) })).toMatchObject({
      passed: true,
      letter: 'D',
      obtainedH: h(66),
      fullMarks: 200,
      failedKinds: [],
    });
  });

  it('45.5 in CQ across the papers fails', () => {
    expect(combined({ P1_CQ: m(20), P2_CQ: m(25.5), P1_MCQ: m(30), P2_MCQ: m(30) })).toMatchObject({
      passed: false,
      letter: 'F',
      failedKinds: ['CQ'],
    });
  });

  it('MCQ is checked on its own: a CQ pass with an MCQ fail is F', () => {
    expect(combined({ P1_CQ: m(70), P2_CQ: m(70), P1_MCQ: m(9), P2_MCQ: m(10) })).toMatchObject({
      passed: false,
      letter: 'F',
      failedKinds: ['MCQ'],
    });
  });

  it('the same marks under PER_COMPONENT fail', () => {
    const marks = { P1_CQ: m(20), P2_CQ: m(26), P1_MCQ: m(10), P2_MCQ: m(10) };
    expect(perComponent(BANGLA, marks)).toMatchObject({
      passed: false,
      failedComponents: ['P1_CQ'],
    });
  });

  it('absent in one paper fails the subject', () => {
    expect(combined({ P1_CQ: m(70), P2_CQ: m(70), P1_MCQ: m(30), P2_MCQ: AB })).toMatchObject({
      passed: false,
      letter: 'F',
      failedComponents: ['P2_MCQ'],
    });
  });

  it('a kind without a combined pass mark is not checked', () => {
    const withOral = [
      ...BANGLA,
      { key: 'ORAL', kind: 'ORAL', fullMarks: 20, passMarks: 7 } satisfies ComponentSpec,
    ];
    expect(
      combined({ P1_CQ: m(50), P2_CQ: m(50), P1_MCQ: m(20), P2_MCQ: m(20), ORAL: m(0) }, withOral),
    ).toMatchObject({ passed: true, failedKinds: [] });
  });
});

/** A compulsory or 4th subject with a given grade (as a 100-mark single paper). */
const graded = (letter: string, optional = false): { optional: boolean; result: SubjectResult } => {
  const marksFor: Record<string, number> = {
    'A+': 85,
    A: 75,
    'A-': 65,
    B: 55,
    C: 45,
    D: 35,
    F: 20,
  };
  const paper: ComponentSpec = { key: 'W', kind: 'WRITTEN', fullMarks: 100, passMarks: 33 };
  return { optional, result: perComponent([paper], { W: m(marksFor[letter]!) }) };
};
const gpa = (subjects: ReturnType<typeof graded>[], rules: GpaRules = NCTB) =>
  studentResult({ mode: 'GPA', subjects, bands: GPA5, rules });

describe('studentResult: NCTB GPA', () => {
  it('the 4th subject at A+ adds 3.00 (its points above 2.00)', () => {
    expect(gpa([graded('A'), graded('A'), graded('A'), graded('A+', true)])).toMatchObject({
      gpaH: 500,
      gpaWithoutOptionalH: 400,
      letter: 'A+',
      passed: true,
      failedSubjects: 0,
    });
  });

  it('the GPA is capped at 5.00', () => {
    expect(gpa([graded('A+'), graded('A+'), graded('A+'), graded('A+', true)])).toMatchObject({
      gpaH: 500,
      letter: 'A+',
    });
  });

  it('a 4th subject at C adds nothing; a failed 4th adds nothing and does not fail', () => {
    expect(gpa([graded('A'), graded('A'), graded('C', true)])).toMatchObject({ gpaH: 400 });
    expect(gpa([graded('A'), graded('A'), graded('F', true)])).toMatchObject({
      gpaH: 400,
      passed: true,
      failedSubjects: 0,
      letter: 'A',
    });
  });

  it('a failed compulsory subject makes the GPA 0 (F), whatever the 4th subject', () => {
    expect(gpa([graded('A+'), graded('F'), graded('A+', true)])).toMatchObject({
      gpaH: 0,
      gpaWithoutOptionalH: 0,
      letter: 'F',
      passed: false,
      failedSubjects: 1,
    });
  });

  it('without compulsory_fail_zero the failed subject counts as 0 points', () => {
    expect(
      gpa([graded('A'), graded('A'), graded('F')], { ...NCTB, compulsoryFailZero: false }),
    ).toMatchObject({ gpaH: 266, letter: 'C', passed: false, failedSubjects: 1 });
  });

  it('is cut to 2 decimals: 59 / 12 = 4.9166… → 4.91 truncated, 4.92 rounded half up', () => {
    const subjects = [
      ...Array.from({ length: 10 }, () => graded('A+')),
      graded('A'),
      graded('A-'),
      graded('A-', true), // 3.5 → adds 1.5
    ];
    expect(gpa(subjects)).toMatchObject({ gpaH: 491, letter: 'A' });
    expect(gpa(subjects, { ...NCTB, gpaRounding: 'ROUND_HALF_UP' })).toMatchObject({
      gpaH: 492,
    });
    expect(gpa(subjects, { ...NCTB, gpaDecimals: 1 })).toMatchObject({ gpaH: 490 });
  });

  it('rounding never lifts a GPA below 5 to 5.00 (grade points are multiples of 0.5)', () => {
    for (let n = 1; n <= 15; n++) {
      // Every sum of half points below 5 × n, over n subjects.
      for (let sumH = 0; sumH < 500 * n; sumH += 50) {
        for (const rounding of ['TRUNCATE', 'ROUND_HALF_UP'] as const) {
          expect(cutGpa(sumH, n, 2, rounding)).toBeLessThan(500);
        }
      }
    }
  });

  it('no bonus when the scheme has no 4th-subject threshold', () => {
    expect(
      gpa([graded('A'), graded('A+', true)], { ...NCTB, optionalBonusAbove: null }),
    ).toMatchObject({ gpaH: 400 });
  });

  it('totals include the 4th subject; incomplete subjects give no GPA', () => {
    const r = gpa([graded('A'), graded('A+', true)]);
    expect(r).toMatchObject({ totalH: h(160), fullMarks: 200, percentH: 8000, complete: true });
    const missing = perComponent([CQ70, MCQ30], { CQ: m(50) });
    expect(gpa([graded('A'), { optional: false, result: missing }])).toMatchObject({
      complete: false,
      gpaH: null,
      letter: null,
    });
  });

  it('formats the GPA with its decimals', () => {
    expect(formatGpa(450, 2, 'en')).toBe('4.50');
    expect(formatGpa(500, 2, 'bn')).toBe('৫.০০');
    expect(formatGpa(490, 1, 'en')).toBe('4.9');
  });
});

describe('studentResult: MARKS mode (coaching model tests)', () => {
  const half: ComponentSpec = { key: 'MCQ', kind: 'MCQ', fullMarks: 50, passMarks: 17 };
  const subj = (marks: number) => ({
    optional: false,
    result: subjectResult({
      passRule: 'PER_COMPONENT',
      components: [half],
      passGroups: [],
      marks: { MCQ: m(marks) },
      bands: null,
      roundingMode: 'NONE',
    }),
  });

  it('total, percent (2 decimals, half up), no GPA or letter', () => {
    expect(studentResult({ mode: 'MARKS', subjects: [subj(45), subj(30)] })).toMatchObject({
      totalH: h(75),
      fullMarks: 100,
      percentH: 7500,
      gpaH: null,
      letter: null,
      passed: true,
    });
    expect(studentResult({ mode: 'MARKS', subjects: [subj(50), subj(50), subj(0)] })).toMatchObject(
      { percentH: 6667, passed: false, failedSubjects: 1 },
    );
  });

  it('without bands a subject has no letter; pass marks still decide pass and fail', () => {
    expect(subj(16).result).toMatchObject({ passed: false, letter: null, gradePoint: null });
    expect(subj(17).result).toMatchObject({ passed: true, letter: null });
  });
});

describe('applicableSubjects: groups and the elective pool', () => {
  const subjects = [
    { subjectId: 'BAN', studyGroupId: null, isElective: false },
    { subjectId: 'PHY', studyGroupId: 'SCI', isElective: false },
    { subjectId: 'BIO', studyGroupId: 'SCI', isElective: true },
    { subjectId: 'HMATH', studyGroupId: 'SCI', isElective: true },
    { subjectId: 'ACC', studyGroupId: 'BUS', isElective: false },
    { subjectId: 'AGRI', studyGroupId: null, isElective: true },
  ];

  it('a science student: common + science subjects, chosen electives (one as 4th)', () => {
    expect(
      applicableSubjects(subjects, { studyGroupId: 'SCI' }, [
        { subjectId: 'BIO', kind: 'COMPULSORY' },
        { subjectId: 'HMATH', kind: 'OPTIONAL' },
      ]),
    ).toEqual([
      { subjectId: 'BAN', optional: false },
      { subjectId: 'PHY', optional: false },
      { subjectId: 'BIO', optional: false },
      { subjectId: 'HMATH', optional: true },
    ]);
  });

  it('an elective without a choice is not taken; a choice of a non-elective changes nothing', () => {
    expect(
      applicableSubjects(subjects, { studyGroupId: 'BUS' }, [
        { subjectId: 'ACC', kind: 'OPTIONAL' },
      ]),
    ).toEqual([
      { subjectId: 'BAN', optional: false },
      { subjectId: 'ACC', optional: false },
    ]);
  });

  it('a student without a group takes only the common subjects', () => {
    expect(applicableSubjects(subjects, { studyGroupId: null }, [])).toEqual([
      { subjectId: 'BAN', optional: false },
    ]);
  });
});
