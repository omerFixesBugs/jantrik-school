import {
  suggestedPassMarks,
  type ComponentKind,
  type ExamComponentView,
  type GradeBandView,
  type PassGroupView,
  type PassRule,
} from '@jantrik/shared';

/** A subject's parts and how it is passed, as the parts editor edits them. */
export interface PartsValue {
  passRule: PassRule;
  components: ExamComponentView[];
  passGroups: PassGroupView[];
}

const kindsOf = (v: PartsValue): ComponentKind[] => [...new Set(v.components.map((c) => c.kind))];
const fullOf = (v: PartsValue, kind: ComponentKind) =>
  v.components.filter((c) => c.kind === kind).reduce((n, c) => n + c.fullMarks, 0);

/**
 * Under COMBINED, one combined pass mark per kind among the parts: a kind's existing mark is kept,
 * a new kind gets the suggested one, a kind with no part left loses its mark. PER_COMPONENT: none.
 */
export function withPassGroups(v: PartsValue, bands: readonly GradeBandView[]): PartsValue {
  if (v.passRule !== 'COMBINED') return { ...v, passGroups: [] };
  return {
    ...v,
    passGroups: kindsOf(v).map(
      (kind) =>
        v.passGroups.find((g) => g.kind === kind) ?? {
          kind,
          passMarks: suggestedPassMarks(fullOf(v, kind), bands),
        },
    ),
  };
}

export type PartsProblem =
  | {
      problem: 'keyFormat' | 'keyDuplicate' | 'nameMissing' | 'fullMissing' | 'passOverFull';
      part: number;
    }
  | { problem: 'groupMissing' | 'groupOverFull'; kind: ComponentKind };

/**
 * What the API would refuse (subjectMarksSchema), said part by part (numbered from 1), so the
 * dialog can name it instead of a general "check the form".
 */
export function partsProblems(v: PartsValue): PartsProblem[] {
  const out: PartsProblem[] = [];
  v.components.forEach((c, i) => {
    const part = i + 1;
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(c.key)) out.push({ problem: 'keyFormat', part });
    else if (v.components.findIndex((x) => x.key === c.key) !== i)
      out.push({ problem: 'keyDuplicate', part });
    if (!c.nameBn.trim() || !c.nameEn.trim()) out.push({ problem: 'nameMissing', part });
    if (c.fullMarks < 1 || c.fullMarks > 1000) out.push({ problem: 'fullMissing', part });
    else if (v.passRule === 'PER_COMPONENT' && c.passMarks !== null && c.passMarks > c.fullMarks)
      out.push({ problem: 'passOverFull', part });
  });
  if (v.passRule === 'COMBINED') {
    for (const kind of kindsOf(v)) {
      const group = v.passGroups.find((g) => g.kind === kind);
      if (!group) out.push({ problem: 'groupMissing', kind });
      else if (group.passMarks > fullOf(v, kind)) out.push({ problem: 'groupOverFull', kind });
    }
  }
  return out;
}
