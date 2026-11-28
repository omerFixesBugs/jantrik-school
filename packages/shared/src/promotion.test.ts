import { describe, expect, it } from 'vitest';
import {
  assignRolls,
  nextClassLevel,
  type RollCandidate,
  type RollGroup,
  type RollStrategy,
} from './promotion.js';
import { leaveSchema, numberRollsSchema, promotionRowsSchema } from './promotion-schema.js';

let n = 0;
function c(over: Partial<RollCandidate> & { group?: RollGroup } = {}): RollCandidate {
  n++;
  return {
    id: `e${String(n).padStart(3, '0')}`,
    group: 'PROMOTED',
    nameBn: null,
    nameEn: null,
    studentCode: `S-${String(n).padStart(3, '0')}`,
    oldRoll: null,
    meritPosition: null,
    ...over,
  };
}

const all = (s: RollStrategy): Record<RollGroup, RollStrategy> => ({
  PROMOTED: s,
  REPEATER: s,
  NEW: 'NAME_BN',
});

/** The ids in roll order. */
function order(map: Map<string, number>): string[] {
  return [...map.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

describe('assignRolls (S15, P5-A, P5-B)', () => {
  it('MERIT: places ascending; shared places by the lower old roll; unranked after, by Bangla name', () => {
    const first = c({ meritPosition: 1, oldRoll: 9 });
    const tieHigh = c({ meritPosition: 2, oldRoll: 7 });
    const tieLow = c({ meritPosition: 2, oldRoll: 3 });
    const fourth = c({ meritPosition: 4, oldRoll: 1 });
    const unrankedB = c({ nameBn: 'খাদিজা' });
    const unrankedA = c({ nameBn: 'অমিত' });
    const rolls = assignRolls(
      [unrankedB, fourth, tieHigh, first, unrankedA, tieLow],
      all('MERIT'),
      new Set(),
    );
    expect(order(rolls)).toEqual([
      first.id,
      tieLow.id,
      tieHigh.id,
      fourth.id,
      unrankedA.id,
      unrankedB.id,
    ]);
    expect([...rolls.values()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('NAME_BN: the Bangla collator’s order, ties by student code; English-only names sort by it', () => {
    const names = ['খাদিজা', 'ঋতু', 'অমিত', 'কবির', 'ইমরান', 'আরিফ'];
    const people = names.map((nameBn) => c({ nameBn }));
    const expected = [...names].sort(new Intl.Collator('bn', { sensitivity: 'base' }).compare);
    const rolls = assignRolls(people, all('NAME_BN'), new Set());
    expect(order(rolls).map((id) => people.find((p) => p.id === id)!.nameBn)).toEqual(expected);

    const twinB = c({ nameBn: 'রহিম', studentCode: 'B-2' });
    const twinA = c({ nameBn: 'রহিম', studentCode: 'A-1' });
    expect(order(assignRolls([twinB, twinA], all('NAME_BN'), new Set()))).toEqual([
      twinA.id,
      twinB.id,
    ]);

    const english = c({ nameEn: 'Zara' });
    const bangla = c({ nameBn: 'অমিত' });
    expect(assignRolls([english, bangla], all('NAME_BN'), new Set()).size).toBe(2);
  });

  it('NAME_EN orders by the English name, falling back to the Bangla one', () => {
    const b = c({ nameEn: 'Babul' });
    const a = c({ nameEn: 'arif' });
    const onlyBn = c({ nameBn: 'চন্দন' });
    const rolls = assignRolls([b, onlyBn, a], all('NAME_EN'), new Set());
    expect(order(rolls).slice(0, 2)).toEqual([a.id, b.id]);
    expect(rolls.size).toBe(3);
  });

  it('S15 groups: promoted, then repeaters, then new admits, each by its own strategy', () => {
    const promotedSecond = c({ group: 'PROMOTED', meritPosition: 2 });
    const promotedFirst = c({ group: 'PROMOTED', meritPosition: 1 });
    const repeaterB = c({ group: 'REPEATER', nameBn: 'কবির' });
    const repeaterA = c({ group: 'REPEATER', nameBn: 'অমিত' });
    const admitted = c({ group: 'NEW', nameBn: 'আরিফ' });
    const rolls = assignRolls(
      [admitted, repeaterB, promotedSecond, repeaterA, promotedFirst],
      { PROMOTED: 'MERIT', REPEATER: 'NAME_BN', NEW: 'NAME_BN' },
      new Set(),
    );
    expect(order(rolls)).toEqual([
      promotedFirst.id,
      promotedSecond.id,
      repeaterA.id,
      repeaterB.id,
      admitted.id,
    ]);
  });

  it('never gives a number already taken in the section', () => {
    const people = [1, 2, 3, 4].map((i) => c({ meritPosition: i }));
    const rolls = assignRolls(people, all('MERIT'), new Set([1, 4]));
    expect(people.map((p) => rolls.get(p.id))).toEqual([2, 3, 5, 6]);
  });

  it('a hand-set roll 3 is skipped; the next group continues after the previous one', () => {
    const promoted = [1, 2].map((i) => c({ group: 'PROMOTED', meritPosition: i }));
    const repeater = c({ group: 'REPEATER', nameBn: 'অমিত' });
    const rolls = assignRolls([...promoted, repeater], all('MERIT'), new Set([3]));
    expect([
      rolls.get(promoted[0]!.id),
      rolls.get(promoted[1]!.id),
      rolls.get(repeater.id),
    ]).toEqual([1, 2, 4]);
  });

  it('KEEP: free old rolls are kept; clashing and missing ones follow the highest kept, by name', () => {
    const keeps5 = c({ oldRoll: 5, nameBn: 'অমিত' });
    const keeps2 = c({ oldRoll: 2, nameBn: 'খাদিজা' });
    const clashes = c({ oldRoll: 5, nameBn: 'কবির' }); // after অমিত by name: loses 5
    const takenOld = c({ oldRoll: 1, nameBn: 'আরিফ' }); // 1 is taken in the section
    const noOld = c({ nameBn: 'ইমরান' });
    const rolls = assignRolls(
      [clashes, noOld, keeps2, takenOld, keeps5],
      all('KEEP'),
      new Set([1]),
    );
    expect(rolls.get(keeps5.id)).toBe(5);
    expect(rolls.get(keeps2.id)).toBe(2);
    // The rest after 5, by Bangla name: আরিফ, ইমরান, কবির.
    expect([rolls.get(takenOld.id), rolls.get(noOld.id), rolls.get(clashes.id)]).toEqual([6, 7, 8]);
  });

  it('is deterministic: shuffled input gives the same map', () => {
    const people = Array.from({ length: 30 }, (_, i) =>
      c({
        group: (['PROMOTED', 'REPEATER', 'NEW'] as const)[i % 3],
        nameBn: ['অমিত', 'আরিফ', 'কবির', 'খাদিজা'][i % 4]!,
        meritPosition: i % 5 === 0 ? null : (i % 7) + 1,
        oldRoll: (i % 9) + 1,
      }),
    );
    const strategies: Record<RollGroup, RollStrategy> = {
      PROMOTED: 'MERIT',
      REPEATER: 'KEEP',
      NEW: 'NAME_BN',
    };
    const a = assignRolls(people, strategies, new Set([3, 11]));
    const shuffled = [...people]
      .reverse()
      .sort((x, y) => (x.id.charCodeAt(3) % 3) - (y.id.charCodeAt(3) % 3));
    const b = assignRolls(shuffled, strategies, new Set([11, 3]));
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
    expect(new Set(a.values()).size).toBe(30);
    expect([...a.values()].some((r) => r === 3 || r === 11)).toBe(false);
  });
});

describe('nextClassLevel', () => {
  const classes = [
    { id: 'c6', sortOrder: 6, isActive: true },
    { id: 'c7', sortOrder: 7, isActive: false },
    { id: 'c8', sortOrder: 8, isActive: true },
    { id: 'c10', sortOrder: 10, isActive: true },
  ];
  it('skips inactive classes and returns null for the top class', () => {
    expect(nextClassLevel(classes, 'c6')?.id).toBe('c8');
    expect(nextClassLevel(classes, 'c8')?.id).toBe('c10');
    expect(nextClassLevel(classes, 'c10')).toBeNull();
    expect(nextClassLevel(classes, 'missing')).toBeNull();
  });
});

describe('promotion schemas', () => {
  it('leaveSchema refuses ACTIVE, takes ISO dates only (Bangla digits too) and trims the reason', () => {
    expect(leaveSchema.safeParse({ status: 'ACTIVE', leftOn: '2026-12-31' }).success).toBe(false);
    expect(leaveSchema.safeParse({ status: 'GRADUATED', leftOn: '31/12/2026' }).success).toBe(
      false,
    );
    expect(leaveSchema.safeParse({ status: 'GRADUATED', leftOn: '2026-02-30' }).success).toBe(
      false,
    );
    expect(
      leaveSchema.parse({ status: 'TRANSFERRED', leftOn: '২০২৬-১২-৩১', reason: '  moved  ' }),
    ).toEqual({ status: 'TRANSFERRED', leftOn: '2026-12-31', reason: 'moved' });
    expect(leaveSchema.parse({ status: 'DROPPED_OUT', leftOn: '2026-06-01', reason: ' ' })).toEqual(
      {
        status: 'DROPPED_OUT',
        leftOn: '2026-06-01',
        reason: null,
      },
    );
    expect(
      leaveSchema.safeParse({ status: 'GRADUATED', leftOn: '2026-12-31', reason: 'x'.repeat(501) })
        .success,
    ).toBe(false);
  });

  const id = '0190a3c5-7a7b-7cde-8f00-000000000001';
  const other = '0190a3c5-7a7b-7cde-8f00-000000000002';
  it('promotionRowsSchema refuses a LEAVE row with a target, and a stay row without a class', () => {
    const leaveWithTarget = {
      id,
      decision: 'LEAVE',
      targetClassLevelId: other,
      leaveStatus: 'GRADUATED',
      leftOn: '2026-12-31',
    };
    expect(promotionRowsSchema.safeParse({ rows: [leaveWithTarget] }).success).toBe(false);
    expect(
      promotionRowsSchema.safeParse({ rows: [{ id, decision: 'LEAVE', leaveStatus: 'GRADUATED' }] })
        .success,
    ).toBe(false);
    expect(promotionRowsSchema.safeParse({ rows: [{ id, decision: 'PROMOTE' }] }).success).toBe(
      false,
    );
    expect(
      promotionRowsSchema.safeParse({
        rows: [{ id, decision: 'REPEAT', targetClassLevelId: other, leftOn: '2026-12-31' }],
      }).success,
    ).toBe(false);
    expect(
      promotionRowsSchema.parse({
        rows: [{ id, decision: 'LEAVE', leaveStatus: 'GRADUATED', leftOn: '2026-12-31' }],
      }).rows[0],
    ).toMatchObject({ targetClassLevelId: null, leaveReason: null });
    expect(
      promotionRowsSchema.safeParse({
        rows: [
          { id, decision: 'PROMOTE', targetClassLevelId: other },
          { id, decision: 'REPEAT', targetClassLevelId: other },
        ],
      }).success,
    ).toBe(false);
  });

  it('numberRollsSchema takes Bangla digits and refuses a duplicate roll in a section', () => {
    const base = { toYearId: id, classLevelId: id, version: 'v1' };
    const parsed = numberRollsSchema.parse({
      ...base,
      sections: [{ sectionId: id, rolls: [{ enrolmentId: id, roll: '১২' }] }],
    });
    expect(parsed.sections[0]!.rolls[0]!.roll).toBe(12);
    expect(
      numberRollsSchema.safeParse({
        ...base,
        sections: [
          {
            sectionId: id,
            rolls: [
              { enrolmentId: id, roll: 3 },
              { enrolmentId: other, roll: 3 },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
