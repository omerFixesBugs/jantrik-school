import type { ExamComponentView, GradeBandView } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { partsProblems, withPassGroups, type PartsValue } from './parts';

const BANDS: GradeBandView[] = [
  { minPercent: 80, maxPercent: 100, letter: 'A+', gradePoint: 5 },
  { minPercent: 33, maxPercent: 39, letter: 'D', gradePoint: 1 },
  { minPercent: 0, maxPercent: 32, letter: 'F', gradePoint: 0 },
];

const part = (
  key: string,
  kind: ExamComponentView['kind'],
  fullMarks: number,
): ExamComponentView => ({
  key,
  kind,
  nameBn: key,
  nameEn: key,
  fullMarks,
  passMarks: null,
});

/** Bangla 9–10 as the NCTB template has it. */
const BAN: PartsValue = {
  passRule: 'COMBINED',
  components: [
    part('P1_CQ', 'CQ', 70),
    part('P1_MCQ', 'MCQ', 30),
    part('P2_CQ', 'CQ', 70),
    part('P2_MCQ', 'MCQ', 30),
  ],
  passGroups: [
    { kind: 'CQ', passMarks: 46 },
    { kind: 'MCQ', passMarks: 20 },
  ],
};

describe('combined pass marks follow the parts', () => {
  it('a kind with no part left loses its combined mark', () => {
    const v = withPassGroups(
      { ...BAN, components: BAN.components.filter((c) => c.kind !== 'MCQ') },
      BANDS,
    );
    expect(v.passGroups).toEqual([{ kind: 'CQ', passMarks: 46 }]);
  });

  it('a new kind gets a suggested combined mark; the others keep theirs', () => {
    const v = withPassGroups(
      { ...BAN, components: [...BAN.components, part('PR', 'PRACTICAL', 50)] },
      BANDS,
    );
    expect(v.passGroups).toEqual([
      { kind: 'CQ', passMarks: 46 },
      { kind: 'MCQ', passMarks: 20 },
      { kind: 'PRACTICAL', passMarks: 17 },
    ]);
  });

  it('each part on its own has no combined marks', () => {
    expect(withPassGroups({ ...BAN, passRule: 'PER_COMPONENT' }, BANDS).passGroups).toEqual([]);
  });
});

describe('problems are named, part by part', () => {
  it('none for the template', () => {
    expect(partsProblems(BAN)).toEqual([]);
  });

  it('a new part without names, a cleared full mark, a duplicate or badly formed code', () => {
    const v: PartsValue = {
      passRule: 'PER_COMPONENT',
      components: [
        { ...part('CQ', 'CQ', 70), passMarks: 80 },
        { ...part('CQ', 'MCQ', 30) },
        { ...part('1X', 'WRITTEN', 0), nameBn: ' ', nameEn: '' },
      ],
      passGroups: [],
    };
    expect(partsProblems(v)).toEqual([
      { problem: 'passOverFull', part: 1 },
      { problem: 'keyDuplicate', part: 2 },
      { problem: 'keyFormat', part: 3 },
      { problem: 'nameMissing', part: 3 },
      { problem: 'fullMissing', part: 3 },
    ]);
  });

  it('a combined mark above its kind’s full marks', () => {
    const v = { ...BAN, passGroups: [{ kind: 'CQ' as const, passMarks: 150 }, BAN.passGroups[1]!] };
    expect(partsProblems(v)).toEqual([{ problem: 'groupOverFull', kind: 'CQ' }]);
  });
});
