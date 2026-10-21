import { describe, expect, it } from 'vitest';
import {
  attentionItems,
  dashboardInsight,
  periodPercent,
  pointChange,
  splitPeriods,
  typicalExamMarks,
  yearProgress,
} from './dashboard.js';

const day = (date: string, present: number, absent: number) => ({
  date,
  counts: { present, absent, late: 0, leave: 0 },
  percent: (present / (present + absent)) * 100,
});
const off = (date: string) => ({ date, counts: null, percent: null });

describe('periods', () => {
  it('weights the present % by students, skipping days without a register', () => {
    // 9 of 10 and 30 of 50: 39 of 60 = 65 % (the plain average of the two days would be 75 %).
    expect(
      periodPercent([day('2026-10-19', 9, 1), off('2026-10-20'), day('2026-10-21', 30, 20)], false),
    ).toBe(65);
    expect(periodPercent([off('2026-10-20')], false)).toBeNull();
  });

  it('splits this period from the one before, by date', () => {
    const days = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].map((d) =>
      day(d, 1, 0),
    );
    const { current, previous } = splitPeriods(days, '2026-10-18', 2);
    expect(current.map((d) => d.date)).toEqual(['2026-10-17', '2026-10-18']);
    expect(previous.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16']);
  });

  it('gives the change in points, to one decimal', () => {
    expect(pointChange(93.46, 90.04)).toBe(3.4);
    expect(pointChange(90, 93)).toBe(-3);
    expect(pointChange(null, 90)).toBeNull();
  });
});

describe('dashboardInsight', () => {
  const base = {
    sectionsTotal: 4,
    sectionsTaken: 1,
    counts: { present: 26, absent: 1, late: 0, leave: 0 },
    longAbsent: 1,
    week: { now: 95, before: 93 },
  };

  it('says how many registers are in, how many are present and who to call', () => {
    expect(dashboardInsight(base)).toEqual([
      { kind: 'coverage', taken: 1, total: 4 },
      { kind: 'present', present: 26, counted: 27 },
      { kind: 'call', count: 1 },
    ]);
  });

  it('on a calmer day adds how the week moved, when it moved a point or more', () => {
    expect(dashboardInsight({ ...base, sectionsTaken: 4, longAbsent: 0 })).toEqual([
      { kind: 'allTaken', total: 4 },
      { kind: 'present', present: 26, counted: 27 },
      { kind: 'week', change: 2 },
    ]);
    expect(
      dashboardInsight({ ...base, longAbsent: 0, week: { now: 95, before: 94.6 } }),
    ).toHaveLength(2);
  });

  it('is never empty: no registers yet, a day off, nothing set up', () => {
    expect(dashboardInsight({ ...base, sectionsTaken: 0, counts: null, longAbsent: 0 })).toEqual([
      { kind: 'coverage', taken: 0, total: 4 },
      { kind: 'week', change: 2 },
    ]);
    expect(
      dashboardInsight({ ...base, sectionsTaken: 0, counts: null, dayOff: { name: null } }),
    ).toEqual([{ kind: 'dayOff', name: null }]);
    expect(dashboardInsight({ ...base, sectionsTotal: 0 })).toEqual([{ kind: 'setup' }]);
  });
});

describe('attentionItems', () => {
  it('puts the most urgent first and leaves out what is fine', () => {
    const items = attentionItems({
      absent: [
        { id: 'a', sectionId: 's1', streak: 1 },
        { id: 'b', sectionId: 's1', streak: 3 },
        { id: 'c', sectionId: 's2', streak: 5 },
      ],
      notTaken: ['s3'],
      heldSms: 2,
      week: [
        { sectionId: 's1', percent: 95 },
        { sectionId: 's2', percent: 84 },
        { sectionId: 's3', percent: 88 },
        { sectionId: 's4', percent: null },
      ],
      nextSetupStep: 'sms',
    });
    expect(items.map((i) => i.kind)).toEqual([
      'longAbsence',
      'heldSms',
      'notTaken',
      'belowTarget',
      'setup',
    ]);
    expect(items[0]).toMatchObject({ students: [{ id: 'c' }, { id: 'b' }] });
    expect(items[3]).toMatchObject({
      sections: [
        { sectionId: 's2', percent: 84 },
        { sectionId: 's3', percent: 88 },
      ],
    });
  });

  it('is empty when all is well', () => {
    expect(
      attentionItems({ absent: [], notTaken: [], heldSms: 0, week: [], nextSetupStep: null }),
    ).toEqual([]);
  });
});

describe('the term timeline', () => {
  it('says where today stands in the year', () => {
    expect(yearProgress('2026-01-01', '2026-12-31', '2026-10-21')).toEqual({
      percent: 80.5,
      week: 42,
      weeks: 53,
      daysLeft: 71,
    });
    // Before the start and after the end it is pinned to the ends.
    expect(yearProgress('2026-01-01', '2026-12-31', '2025-12-30').percent).toBe(0);
    expect(yearProgress('2026-01-01', '2026-12-31', '2027-02-01')).toMatchObject({
      percent: 100,
      daysLeft: 0,
    });
  });

  it("places a type's typical exams on its year", () => {
    expect(typicalExamMarks('NCTB_SCHOOL_BN', '2026-01-01', '2026-12-31')).toEqual([
      { key: 'halfYearly', month: 6, date: '2026-06-15', percent: 45.2 },
      { key: 'annual', month: 11, date: '2026-11-15', percent: 87.1 },
    ]);
    // A year that starts in July still finds both, in date order.
    expect(
      typicalExamMarks('NCTB_SCHOOL_BN', '2026-07-01', '2027-06-30').map((m) => m.date),
    ).toEqual(['2026-11-15', '2027-06-15']);
    expect(typicalExamMarks('COACHING', '2026-01-01', '2026-12-31')).toEqual([]);
  });
});
