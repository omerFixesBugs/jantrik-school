import { describe, expect, it } from 'vitest';
import {
  computeClassResults,
  meritPositions,
  resultSmsText,
  type ClassResultsInput,
  type MeritRow,
} from './exams-results.js';
import { smsLength } from './sms.js';
import type { GradeBand } from './grading.js';

const GPA5: GradeBand[] = [
  { minPercent: 80, letter: 'A+', gradePoint: 5 },
  { minPercent: 70, letter: 'A', gradePoint: 4 },
  { minPercent: 60, letter: 'A-', gradePoint: 3.5 },
  { minPercent: 50, letter: 'B', gradePoint: 3 },
  { minPercent: 40, letter: 'C', gradePoint: 2 },
  { minPercent: 33, letter: 'D', gradePoint: 1 },
  { minPercent: 0, letter: 'F', gradePoint: 0 },
];

const row = (id: string, data: Partial<MeritRow> = {}): MeritRow => ({
  id,
  sectionId: 'A',
  roll: null,
  passed: true,
  gpaH: 400,
  gpaWithoutOptionalH: 400,
  totalH: 50_000,
  percentH: 5000,
  failedSubjects: 0,
  subjectTotalsH: {},
  ...data,
});

describe('meritPositions: tie-breakers, shared places, failed students', () => {
  it('orders by the keys in turn; full ties share the place (1, 2, 2, 4)', () => {
    const rows = [
      row('a', { gpaH: 500, totalH: 80_000 }),
      row('b', { gpaH: 450, totalH: 70_000 }),
      row('c', { gpaH: 450, totalH: 70_000 }),
      row('d', { gpaH: 450, totalH: 60_000 }),
    ];
    const p = meritPositions(rows, ['GPA', 'TOTAL_MARKS'], 'AFTER_PASSED', 'GPA');
    expect(['a', 'b', 'c', 'd'].map((id) => p.get(id))).toEqual([1, 2, 2, 4]);
  });

  it('a later key breaks a tie on the earlier ones; ROLL breaks the rest', () => {
    const rows = [
      row('b', { gpaH: 450, totalH: 70_000, roll: 7 }),
      row('c', { gpaH: 450, totalH: 70_000, roll: 3 }),
    ];
    expect(meritPositions(rows, ['GPA', 'TOTAL_MARKS', 'ROLL'], 'AFTER_PASSED', 'GPA')).toEqual(
      new Map([
        ['c', 1],
        ['b', 2],
      ]),
    );
  });

  it('the same roll in two sections still ties in the class list', () => {
    const rows = [row('x', { sectionId: 'A', roll: 1 }), row('y', { sectionId: 'B', roll: 1 })];
    const p = meritPositions(rows, ['GPA', 'TOTAL_MARKS', 'ROLL'], 'AFTER_PASSED', 'GPA');
    expect([p.get('x'), p.get('y')]).toEqual([1, 1]);
  });

  it('failed students come after every passed one, or get no place', () => {
    const rows = [
      row('fail', { passed: false, gpaH: 0, totalH: 95_000 }),
      row('pass', { gpaH: 100, totalH: 10_000 }),
    ];
    expect(meritPositions(rows, ['TOTAL_MARKS'], 'AFTER_PASSED', 'GPA')).toEqual(
      new Map([
        ['pass', 1],
        ['fail', 2],
      ]),
    );
    expect(meritPositions(rows, ['TOTAL_MARKS'], 'UNRANKED', 'GPA')).toEqual(
      new Map([
        ['pass', 1],
        ['fail', null],
      ]),
    );
  });

  it('GPA keys are ignored in MARKS mode; FEWER_FAILED_SUBJECTS, PERCENT and SUBJECT keys work', () => {
    const rows = [
      row('a', { gpaH: null, percentH: 6000, failedSubjects: 1, passed: false }),
      row('b', { gpaH: null, percentH: 6000, failedSubjects: 0, passed: false }),
    ];
    const p = meritPositions(
      rows,
      ['GPA', 'PERCENT', 'FEWER_FAILED_SUBJECTS'],
      'AFTER_PASSED',
      'MARKS',
    );
    expect([p.get('b'), p.get('a')]).toEqual([1, 2]);
    const bySubject = meritPositions(
      [
        row('m', { subjectTotalsH: { s1: 6000 } }),
        row('n', { subjectTotalsH: { s1: 7000 } }),
        row('o', { subjectTotalsH: {} }),
      ],
      ['GPA', 'SUBJECT:s1'],
      'AFTER_PASSED',
      'GPA',
    );
    expect(['n', 'm', 'o'].map((id) => bySubject.get(id))).toEqual([1, 2, 3]);
  });
});

/** Class 9: Bangla (compulsory), Science group Physics, Higher Maths as the elective (4th). */
function nineInput(): ClassResultsInput {
  const part = (key: string, fullMarks: number, passMarks: number) => ({
    key,
    kind: key === 'MCQ' ? ('MCQ' as const) : ('CQ' as const),
    fullMarks,
    passMarks,
  });
  return {
    mode: 'GPA',
    bands: GPA5,
    roundingMode: 'NONE',
    rules: {
      gpaMax: 5,
      optionalBonusAbove: 2,
      gpaDecimals: 2,
      gpaRounding: 'TRUNCATE',
      compulsoryFailZero: true,
    },
    meritOrder: ['GPA', 'TOTAL_MARKS', 'ROLL'],
    failedRanking: 'AFTER_PASSED',
    subjects: [
      {
        examSubjectId: 'ban',
        subjectId: 'BAN',
        studyGroupId: null,
        isElective: false,
        passRule: 'PER_COMPONENT',
        components: [part('CQ', 70, 23), part('MCQ', 30, 10)],
        passGroups: [],
      },
      {
        examSubjectId: 'phy',
        subjectId: 'PHY',
        studyGroupId: 'SCI',
        isElective: false,
        passRule: 'PER_COMPONENT',
        components: [part('CQ', 70, 23), part('MCQ', 30, 10)],
        passGroups: [],
      },
      {
        examSubjectId: 'hmath',
        subjectId: 'HMATH',
        studyGroupId: 'SCI',
        isElective: true,
        passRule: 'PER_COMPONENT',
        components: [part('CQ', 70, 23), part('MCQ', 30, 10)],
        passGroups: [],
      },
    ],
    candidates: [
      {
        studentId: 's1',
        sectionId: 'A',
        roll: 1,
        studyGroupId: 'SCI',
        choices: [{ subjectId: 'HMATH', kind: 'OPTIONAL' }],
      },
      { studentId: 's2', sectionId: 'A', roll: 2, studyGroupId: 'SCI', choices: [] },
      { studentId: 's3', sectionId: 'B', roll: 1, studyGroupId: 'SCI', choices: [] },
    ],
    marks: new Map([
      ['ban:s1', { CQ: { scoreH: 6000, absent: false }, MCQ: { scoreH: 2000, absent: false } }],
      ['phy:s1', { CQ: { scoreH: 5000, absent: false }, MCQ: { scoreH: 2500, absent: false } }],
      ['hmath:s1', { CQ: { scoreH: 6000, absent: false }, MCQ: { scoreH: 2500, absent: false } }],
      ['ban:s2', { CQ: { scoreH: 6000, absent: false }, MCQ: { scoreH: 2500, absent: false } }],
      ['phy:s2', { CQ: { scoreH: 5000, absent: false }, MCQ: { scoreH: 2500, absent: false } }],
      ['ban:s3', { CQ: { scoreH: 2200, absent: false }, MCQ: { scoreH: 3000, absent: false } }],
      ['phy:s3', { CQ: { scoreH: 7000, absent: false }, MCQ: { scoreH: 3000, absent: false } }],
    ]),
  };
}

describe('computeClassResults: one class from its marks', () => {
  it('each student sits their own subjects; the 4th adds its bonus; positions in class and section', () => {
    const r = computeClassResults(nineInput());
    const s1 = r.students.find((x) => x.studentId === 's1')!;
    expect(s1.subjects.map((x) => [x.subjectId, x.optional])).toEqual([
      ['BAN', false],
      ['PHY', false],
      ['HMATH', true],
    ]);
    // BAN 80 → A+ (5), PHY 75 → A (4), HMATH 85 → A+ adds 3: (5 + 4 + 3) / 2 = 6 → capped 5.00.
    expect(s1.result).toMatchObject({
      gpaH: 500,
      gpaWithoutOptionalH: 450,
      letter: 'A+',
      passed: true,
    });
    const s2 = r.students.find((x) => x.studentId === 's2')!;
    expect(s2.subjects).toHaveLength(2);
    // BAN 85 → 5, PHY 75 → 4: 4.50.
    expect(s2.result).toMatchObject({ gpaH: 450, passed: true });
    const s3 = r.students.find((x) => x.studentId === 's3')!;
    // CQ 22 of 70 fails Bangla (pass 23): GPA 0.
    expect(s3.result).toMatchObject({ gpaH: 0, letter: 'F', passed: false, failedSubjects: 1 });
    expect([s1, s2, s3].map((x) => [x.classPosition, x.sectionPosition])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
  });

  it('subject stats: highest and average of those who sat it', () => {
    const r = computeClassResults(nineInput());
    expect(r.subjectStats['ban']).toEqual({ sat: 3, highestH: 8500, averageH: 7233 });
    expect(r.subjectStats['hmath']).toEqual({ sat: 1, highestH: 8500, averageH: 8500 });
  });

  it('a student with a blank part is incomplete: no GPA, no place', () => {
    const input = nineInput();
    input.marks.delete('phy:s2');
    const r = computeClassResults(input);
    const s2 = r.students.find((x) => x.studentId === 's2')!;
    expect(s2.result).toMatchObject({ complete: false, gpaH: null });
    expect(s2.classPosition).toBeNull();
    expect(r.incomplete).toEqual(['s2']);
  });
});

describe('resultSmsText: fixed Bangla, two segments at most', () => {
  it('GPA mode: GPA, letter and class position in Bangla digits', () => {
    const text = resultSmsText({
      institute: 'শাপলা উচ্চ বিদ্যালয়',
      student: 'তাসনিম আক্তার',
      exam: 'বার্ষিক পরীক্ষা ২০২৬',
      mode: 'GPA',
      gpaH: 450,
      gpaDecimals: 2,
      letter: 'A',
      totalH: 0,
      fullMarks: 0,
      percentH: 0,
      classPosition: 5,
    });
    expect(text).toContain('জিপিএ ৪.৫০ (A)');
    expect(text).toContain('মেধাক্রম ৫');
    expect(smsLength(text).segments).toBeLessThanOrEqual(2);
  });

  it('MARKS mode: marks and percent; no position when unranked', () => {
    const text = resultSmsText({
      institute: 'আলো কোচিং',
      student: 'সাকিব',
      exam: 'মডেল টেস্ট ১',
      mode: 'MARKS',
      gpaH: null,
      gpaDecimals: 2,
      letter: null,
      totalH: 7550,
      fullMarks: 100,
      percentH: 7550,
      classPosition: null,
    });
    expect(text).toContain('৭৫.৫/১০০');
    expect(text).toContain('৭৫.৫%');
    expect(text).not.toContain('মেধাক্রম');
  });
});
