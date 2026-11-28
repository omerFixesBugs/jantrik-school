import { describe, expect, it } from 'vitest';
import {
  admissionMerit,
  admissionResultSmsText,
  type AdmissionTieBreak,
  type MeritApplicant,
} from './admission-test.js';

// Sprint 1 P4: the merit list of an admission test (review focus 1: ties).

let n = 0;
const row = (scoreH: number | null, over: Partial<MeritApplicant> = {}): MeritApplicant => ({
  id: `a${++n}`,
  scoreH,
  absent: false,
  dateOfBirth: '2019-05-01',
  submittedAt: `2026-11-20T06:00:${String(n % 60).padStart(2, '0')}.000Z`,
  ...over,
});
const merit = (
  rows: MeritApplicant[],
  opts: Partial<{
    tieBreak: AdmissionTieBreak;
    passMarksH: number | null;
    selectCount: number;
    waitlistCount: number;
  }> = {},
) =>
  admissionMerit(rows, {
    tieBreak: 'NONE',
    passMarksH: null,
    selectCount: 100,
    waitlistCount: 0,
    ...opts,
  });

describe('admissionMerit', () => {
  it('ranks by score; equal scores share a place and the next place skips (NONE)', () => {
    const rows = [row(9000), row(8500), row(8500), row(7000)];
    const { outcomes } = merit(rows);
    expect(rows.map((r) => outcomes.get(r.id)!.meritPosition)).toEqual([1, 2, 2, 4]);
  });

  it('OLDER_FIRST puts the older of two equal scores first; YOUNGER_FIRST the younger', () => {
    const top = row(9000);
    const older = row(8500, { dateOfBirth: '2019-01-01' });
    const younger = row(8500, { dateOfBirth: '2019-09-01' });
    const rows = [top, younger, older];
    const o = merit(rows, { tieBreak: 'OLDER_FIRST' }).outcomes;
    expect([o.get(older.id)!.meritPosition, o.get(younger.id)!.meritPosition]).toEqual([2, 3]);
    const y = merit(rows, { tieBreak: 'YOUNGER_FIRST' }).outcomes;
    expect([y.get(younger.id)!.meritPosition, y.get(older.id)!.meritPosition]).toEqual([2, 3]);
  });

  it('the same score and date of birth: the earlier submission first', () => {
    const late = row(8500, { submittedAt: '2026-11-21T06:00:00.000Z' });
    const early = row(8500, { submittedAt: '2026-11-20T06:00:00.000Z' });
    const { outcomes } = merit([late, early], { tieBreak: 'OLDER_FIRST' });
    expect(outcomes.get(early.id)!.meritPosition).toBe(1);
    expect(outcomes.get(late.id)!.meritPosition).toBe(2);
  });

  it('absent and below the pass marks are unranked; no pass marks: nobody fails', () => {
    const absent = row(null, { absent: true });
    const low = row(3200);
    const ok = row(3300);
    const withPass = merit([absent, low, ok], { passMarksH: 3300 }).outcomes;
    expect(withPass.get(absent.id)).toEqual({
      result: 'ABSENT',
      meritPosition: null,
      waitlistPosition: null,
    });
    expect(withPass.get(low.id)).toEqual({
      result: 'FAILED',
      meritPosition: null,
      waitlistPosition: null,
    });
    expect(withPass.get(ok.id)).toMatchObject({ result: 'SELECTED', meritPosition: 1 });
    expect(merit([low, ok]).outcomes.get(low.id)).toMatchObject({
      result: 'SELECTED',
      meritPosition: 2,
    });
  });

  it('a tie on the last selected place selects everyone tied there (P4-B)', () => {
    const rows = [row(9000), row(8500), row(8500)];
    const { outcomes, boundaryTie } = merit(rows, { selectCount: 2 });
    expect(rows.map((r) => outcomes.get(r.id)!.result)).toEqual([
      'SELECTED',
      'SELECTED',
      'SELECTED',
    ]);
    expect(boundaryTie).toBe(1);
  });

  it('the waitlist takes the next ones in order; the rest are not selected', () => {
    const rows = [row(9000), row(8000), row(7000), row(6000), row(5000)];
    const { outcomes, boundaryTie } = merit(rows, { selectCount: 2, waitlistCount: 2 });
    expect(rows.map((r) => outcomes.get(r.id))).toEqual([
      { result: 'SELECTED', meritPosition: 1, waitlistPosition: null },
      { result: 'SELECTED', meritPosition: 2, waitlistPosition: null },
      { result: 'WAITLISTED', meritPosition: 3, waitlistPosition: 1 },
      { result: 'WAITLISTED', meritPosition: 4, waitlistPosition: 2 },
      { result: 'NOT_SELECTED', meritPosition: 5, waitlistPosition: null },
    ]);
    expect(boundaryTie).toBe(0);
  });

  it('a tie on the last waitlisted place waitlists everyone tied there, at a shared position', () => {
    const rows = [row(9000), row(8500), row(8500), row(7000)];
    const { outcomes, waitlistTie } = merit(rows, { selectCount: 1, waitlistCount: 1 });
    expect(rows.map((r) => outcomes.get(r.id)!.waitlistPosition)).toEqual([null, 1, 1, null]);
    expect(outcomes.get(rows[3]!.id)!.result).toBe('NOT_SELECTED');
    expect(waitlistTie).toBe(1);
  });

  it('select count 0: everyone ranked is waitlisted or not selected', () => {
    const rows = [row(9000), row(8000), row(7000)];
    const { outcomes } = merit(rows, { selectCount: 0, waitlistCount: 1 });
    expect(rows.map((r) => outcomes.get(r.id)!.result)).toEqual([
      'WAITLISTED',
      'NOT_SELECTED',
      'NOT_SELECTED',
    ]);
  });

  it('the input order never changes the output (100 shuffles)', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(i % 7 === 0 ? null : 5000 + ((i * 37) % 9) * 500, {
        absent: i % 7 === 0,
        dateOfBirth: `2019-0${1 + (i % 3)}-01`,
      }),
    );
    for (const tieBreak of ['NONE', 'OLDER_FIRST', 'YOUNGER_FIRST'] as const) {
      const opts = { tieBreak, passMarksH: 6000, selectCount: 10, waitlistCount: 5 };
      const expected = merit(rows, opts);
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      for (let k = 0; k < 100; k++) {
        const shuffled = [...rows].sort(() => random() - 0.5);
        const got = merit(shuffled, opts);
        expect(got.boundaryTie).toBe(expected.boundaryTie);
        for (const r of rows) expect(got.outcomes.get(r.id)).toEqual(expected.outcomes.get(r.id));
      }
    }
  });
});

describe('admissionResultSmsText (P4-H: no score)', () => {
  const base = { institute: 'শাপলা স্কুল', applicationNo: '2027-0012' };
  it('says the outcome with the place or position, the number and the status link', () => {
    const selected = admissionResultSmsText({
      ...base,
      outcome: 'SELECTED',
      meritPosition: 12,
      waitlistPosition: null,
      statusUrl: 'https://jantrik.app/apply/shapla/status',
      locale: 'bn',
    });
    expect(selected).toContain('2027-0012');
    expect(selected).toContain('১২');
    expect(selected).toContain('https://jantrik.app/apply/shapla/status');
    const waitlisted = admissionResultSmsText({
      ...base,
      outcome: 'WAITLISTED',
      meritPosition: 30,
      waitlistPosition: 3,
      statusUrl: null,
      locale: 'en',
    });
    expect(waitlisted).toMatch(/waitlist.*3/i);
    expect(waitlisted).not.toContain('http');
    const rejected = admissionResultSmsText({
      ...base,
      outcome: 'REJECTED',
      meritPosition: null,
      waitlistPosition: null,
      statusUrl: null,
      locale: 'en',
    });
    expect(rejected).toMatch(/not selected/i);
  });
});
