import { describe, expect, it } from 'vitest';
import {
  allocate,
  amountInWords,
  concessionAmount,
  dueBalance,
  effectiveConcession,
  feePeriods,
  fineAccrued,
  maskPhone,
  normalizeTrxId,
  parseTaka,
  planStudentDues,
  receiptNumber,
  receiptSmsText,
  reminderSmsText,
  siblingRanks,
  type DueBalanceInput,
  type FineRule,
  type PlanInput,
} from './fees.js';
import { smsLength } from './sms.js';

describe('parseTaka (what people type → paisa)', () => {
  it.each([
    ['1250', 125000],
    ['1,250', 125000],
    [' ১২৫০ ', 125000],
    ['১,২৫০.৫০', 125050],
    ['1250.5', 125050],
    ['0.01', 1],
    ['0', 0],
    ['10,00,000', 100000000], // Bangladeshi grouping
  ])('%s → %i', (input, paisa) => {
    expect(parseTaka(input)).toBe(paisa);
  });

  it.each(['', ' ', '-5', '12.345', 'abc', '1.2.3', '1e3', '10000001', '.', '৳500'])(
    'rejects %j',
    (input) => {
      expect(parseTaka(input)).toBeNull();
    },
  );
});

describe('fineAccrued (late fines)', () => {
  const perDay: FineRule = { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 5000 };
  const flat: FineRule = { type: 'FLAT', amountPaisa: 2000, capPaisa: null };

  it('nothing on or before the due date', () => {
    expect(fineAccrued(perDay, '2026-03-10', '2026-03-10')).toBe(0);
    expect(fineAccrued(flat, '2026-03-10', '2026-03-10')).toBe(0);
    expect(fineAccrued(perDay, '2026-03-10', '2026-03-01')).toBe(0);
  });

  it('flat: the whole amount from the day after', () => {
    expect(fineAccrued(flat, '2026-03-10', '2026-03-11')).toBe(2000);
    expect(fineAccrued(flat, '2026-03-10', '2026-12-31')).toBe(2000);
  });

  it('per day: days × rate, up to the cap', () => {
    expect(fineAccrued(perDay, '2026-03-10', '2026-03-11')).toBe(1000);
    expect(fineAccrued(perDay, '2026-03-10', '2026-03-14')).toBe(4000);
    expect(fineAccrued(perDay, '2026-03-10', '2026-03-15')).toBe(5000); // exactly the cap
    expect(fineAccrued(perDay, '2026-03-10', '2026-04-30')).toBe(5000);
  });

  it('counts calendar days across a leap day and a year end', () => {
    const rule: FineRule = { type: 'PER_DAY', amountPaisa: 100, capPaisa: 1_000_000 };
    expect(fineAccrued(rule, '2028-02-28', '2028-03-01')).toBe(200); // 29 Feb 2028 counts
    expect(fineAccrued(rule, '2026-12-31', '2027-01-02')).toBe(200);
  });

  it('none: never', () => {
    expect(
      fineAccrued({ type: 'NONE', amountPaisa: 0, capPaisa: null }, '2026-01-01', '2027-01-01'),
    ).toBe(0);
  });
});

describe('dueBalance (what is still owed on one due)', () => {
  const base: DueBalanceInput = {
    status: 'OPEN',
    amountPaisa: 120000,
    concessionPaisa: 20000,
    paidPrincipalPaisa: 0,
    paidFinePaisa: 0,
    principalClearedOn: null,
    dueDate: '2026-03-10',
    fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
    fineWaivedPaisa: 0,
    fineWaivedAll: false,
  };

  it('before the due date: the net amount, no fine', () => {
    expect(dueBalance(base, '2026-03-05')).toEqual({ principal: 100000, fine: 0, total: 100000 });
  });

  it('late: principal plus the fine accrued so far', () => {
    expect(dueBalance(base, '2026-03-13')).toEqual({
      principal: 100000,
      fine: 3000,
      total: 103000,
    });
  });

  it('a partial payment does not stop the fine', () => {
    const due = { ...base, paidPrincipalPaisa: 60000 };
    expect(dueBalance(due, '2026-03-15')).toEqual({ principal: 40000, fine: 5000, total: 45000 });
  });

  it('the fine stops on the day the principal was cleared', () => {
    const due = { ...base, paidPrincipalPaisa: 100000, principalClearedOn: '2026-03-12' };
    expect(dueBalance(due, '2026-06-01')).toEqual({ principal: 0, fine: 2000, total: 2000 });
  });

  it('cleared on time: no fine ever', () => {
    const due = { ...base, paidPrincipalPaisa: 100000, principalClearedOn: '2026-03-10' };
    expect(dueBalance(due, '2026-12-01')).toEqual({ principal: 0, fine: 0, total: 0 });
  });

  it('fine already paid and waived is subtracted; never negative', () => {
    const due = { ...base, paidFinePaisa: 2000, fineWaivedPaisa: 500 };
    expect(dueBalance(due, '2026-03-14')).toEqual({ principal: 100000, fine: 1500, total: 101500 });
    expect(dueBalance({ ...due, fineWaivedPaisa: 9000 }, '2026-03-14').fine).toBe(0);
  });

  it('a waiver of the whole fine: nothing, however late', () => {
    expect(dueBalance({ ...base, fineWaivedAll: true }, '2026-12-01').fine).toBe(0);
  });

  it('a due reduced to nothing by a concession has no fine', () => {
    const free = { ...base, concessionPaisa: 120000 };
    expect(dueBalance(free, '2026-12-01')).toEqual({ principal: 0, fine: 0, total: 0 });
  });

  it('a cancelled due owes nothing', () => {
    expect(dueBalance({ ...base, status: 'CANCELLED' }, '2026-12-01').total).toBe(0);
  });
});

describe('allocate (where a payment goes)', () => {
  const dues = [
    { id: 'apr', dueDate: '2026-04-10', principal: 100000, fine: 0 },
    { id: 'mar', dueDate: '2026-03-10', principal: 100000, fine: 3000 },
    { id: 'exam', dueDate: '2026-03-10', principal: 50000, fine: 0, sortOrder: 5 },
  ];

  it('the whole amount: everything settled', () => {
    expect(allocate(dues, 253000)).toEqual([
      { dueId: 'mar', principalPaisa: 100000, finePaisa: 3000 },
      { dueId: 'exam', principalPaisa: 50000, finePaisa: 0 },
      { dueId: 'apr', principalPaisa: 100000, finePaisa: 0 },
    ]);
  });

  it('partial: principal oldest first, then fines', () => {
    expect(allocate(dues, 120000)).toEqual([
      { dueId: 'mar', principalPaisa: 100000, finePaisa: 0 },
      { dueId: 'exam', principalPaisa: 20000, finePaisa: 0 },
    ]);
    expect(allocate(dues, 251000)).toEqual([
      { dueId: 'mar', principalPaisa: 100000, finePaisa: 1000 },
      { dueId: 'exam', principalPaisa: 50000, finePaisa: 0 },
      { dueId: 'apr', principalPaisa: 100000, finePaisa: 0 },
    ]);
  });

  it('refuses nothing, too much, or fractions', () => {
    expect(() => allocate(dues, 0)).toThrow();
    expect(() => allocate(dues, 253001)).toThrow();
    expect(() => allocate(dues, 10.5)).toThrow();
  });
});

describe('concessions', () => {
  it('fixed is capped at the amount; percent rounds half up to the paisa', () => {
    expect(concessionAmount(100000, { type: 'FIXED', value: 30000 })).toBe(30000);
    expect(concessionAmount(100000, { type: 'FIXED', value: 150000 })).toBe(100000);
    expect(concessionAmount(100000, { type: 'PERCENT', value: 50 })).toBe(50000);
    expect(concessionAmount(333, { type: 'PERCENT', value: 50 })).toBe(167); // 166.5 → 167
    expect(concessionAmount(333, { type: 'PERCENT', value: 10 })).toBe(33); // 33.3 → 33
    expect(concessionAmount(100000, { type: 'PERCENT', value: 100 })).toBe(100000);
  });

  it('never stacks: the larger of the manual and the sibling discount', () => {
    expect(
      effectiveConcession(100000, { type: 'PERCENT', value: 20 }, { type: 'FIXED', value: 30000 }),
    ).toEqual({ paisa: 30000, source: 'SIBLING' });
    expect(
      effectiveConcession(100000, { type: 'PERCENT', value: 50 }, { type: 'FIXED', value: 30000 }),
    ).toEqual({ paisa: 50000, source: 'MANUAL' });
    expect(effectiveConcession(100000, null, null)).toEqual({ paisa: 0, source: 'NONE' });
    // A tie goes to the manual concession (it carries a reason).
    expect(
      effectiveConcession(100000, { type: 'FIXED', value: 500 }, { type: 'FIXED', value: 500 }),
    ).toEqual({ paisa: 500, source: 'MANUAL' });
  });
});

describe('siblingRanks (inside a confirmed family)', () => {
  it('the highest class pays full; ties go to the earlier admission', () => {
    const ranks = siblingRanks([
      { studentId: 'six', classSortOrder: 6, admittedAt: '2024-01-05T00:00:00Z' },
      { studentId: 'nine', classSortOrder: 9, admittedAt: '2025-01-05T00:00:00Z' },
      { studentId: 'six-b', classSortOrder: 6, admittedAt: '2023-01-05T00:00:00Z' },
    ]);
    expect(ranks.get('nine')).toBe(1);
    expect(ranks.get('six-b')).toBe(2);
    expect(ranks.get('six')).toBe(3);
  });
});

describe('feePeriods', () => {
  const year = { startDate: '2026-01-01', endDate: '2026-12-31' };

  it('monthly: one period per month, due on the due day', () => {
    const periods = feePeriods({ frequency: 'MONTHLY', dueDay: 10, dueOffsetDays: 0 }, year, []);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({
      key: '2026-01',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      dueDate: '2026-01-10',
      termId: null,
    });
    expect(periods[1]!.periodEnd).toBe('2026-02-28');
    expect(periods[11]!.key).toBe('2026-12');
  });

  it('a coaching year from July to June crosses the calendar year', () => {
    const periods = feePeriods(
      { frequency: 'MONTHLY', dueDay: 5, dueOffsetDays: 0 },
      { startDate: '2026-07-15', endDate: '2027-06-30' },
      [],
    );
    expect(periods.map((p) => p.key)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
    ]);
    // The first month starts with the year; its due day is never before that.
    expect(periods[0]).toMatchObject({ periodStart: '2026-07-15', dueDate: '2026-07-15' });
  });

  it('yearly: one period from the year start; terms: one per term', () => {
    expect(feePeriods({ frequency: 'YEARLY', dueDay: null, dueOffsetDays: 15 }, year, [])).toEqual([
      {
        key: 'Y',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-01-16',
        termId: null,
      },
    ]);
    const terms = [
      { id: 't1', opensOn: '2026-04-20', dueDate: '2026-05-05' },
      { id: 't2', opensOn: '2026-10-20', dueDate: '2026-11-05' },
    ];
    expect(
      feePeriods({ frequency: 'PER_TERM', dueDay: null, dueOffsetDays: 0 }, year, terms),
    ).toEqual([
      {
        key: 'T:t1',
        periodStart: '2026-04-20',
        periodEnd: '2026-05-05',
        dueDate: '2026-05-05',
        termId: 't1',
      },
      {
        key: 'T:t2',
        periodStart: '2026-10-20',
        periodEnd: '2026-11-05',
        dueDate: '2026-11-05',
        termId: 't2',
      },
    ]);
  });
});

describe('planStudentDues (which dues a student should have)', () => {
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    asOf: '2026-10-22',
    upTo: null,
    duesFrom: '2026-09-01',
    sibling: { type: 'PERCENT', value: 50, fromChild: 2 },
    year: { id: 'y26', startDate: '2026-01-01', endDate: '2026-12-31' },
    heads: [
      {
        id: 'tuition',
        frequency: 'MONTHLY',
        dueDay: 10,
        dueOffsetDays: 0,
        oneTimeFrom: null,
        siblingEligible: true,
        isActive: true,
        fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
      },
      {
        id: 'admission',
        frequency: 'ONE_TIME',
        dueDay: null,
        dueOffsetDays: 7,
        oneTimeFrom: '2026-09-01',
        siblingEligible: false,
        isActive: true,
        fine: { type: 'NONE', amountPaisa: 0, capPaisa: null },
      },
      {
        id: 'session',
        frequency: 'YEARLY',
        dueDay: null,
        dueOffsetDays: 30,
        oneTimeFrom: null,
        siblingEligible: false,
        isActive: true,
        fine: { type: 'NONE', amountPaisa: 0, capPaisa: null },
      },
    ],
    terms: [],
    amounts: [
      { feeHeadId: 'tuition', classLevelId: 'c6', studyGroupId: null, amountPaisa: 100000 },
      { feeHeadId: 'admission', classLevelId: 'c6', studyGroupId: null, amountPaisa: 500000 },
      { feeHeadId: 'session', classLevelId: 'c6', studyGroupId: null, amountPaisa: 300000 },
      { feeHeadId: 'tuition', classLevelId: 'c9', studyGroupId: null, amountPaisa: 150000 },
      { feeHeadId: 'tuition', classLevelId: 'c9', studyGroupId: 'sci', amountPaisa: 180000 },
    ],
    student: {
      id: 's1',
      admittedOn: '2025-01-05',
      classLevelId: 'c6',
      studyGroupId: null,
      siblingRank: null,
    },
    concessions: [],
    ...over,
  });

  it('nothing before the owner sets the start month', () => {
    expect(planStudentDues(input({ duesFrom: null }))).toEqual([]);
  });

  it('monthly dues from the start month up to today; no back-charging', () => {
    const dues = planStudentDues(input());
    const tuition = dues.filter((d) => d.feeHeadId === 'tuition');
    expect(tuition.map((d) => d.periodKey)).toEqual(['2026-09', '2026-10']);
    expect(tuition[0]).toMatchObject({
      amountPaisa: 100000,
      concessionPaisa: 0,
      concessionSource: 'NONE',
      dueDate: '2026-09-10',
      fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
    });
    // The yearly session fee started in January, before the fees start month: not charged.
    expect(dues.some((d) => d.feeHeadId === 'session')).toBe(false);
    // Admitted in 2025, before the admission fee applies: not charged.
    expect(dues.some((d) => d.feeHeadId === 'admission')).toBe(false);
  });

  it('paying ahead: future months up to the requested date', () => {
    const keys = planStudentDues(input({ upTo: '2026-12-01' }))
      .filter((d) => d.feeHeadId === 'tuition')
      .map((d) => d.periodKey);
    expect(keys).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
  });

  it('a new admission: the admission fee once, months from the admission month, a grace week', () => {
    const dues = planStudentDues(
      input({
        student: {
          id: 's2',
          admittedOn: '2026-10-15',
          classLevelId: 'c6',
          studyGroupId: null,
          siblingRank: null,
        },
      }),
    );
    expect(dues.map((d) => `${d.feeHeadId}:${d.periodKey}:${d.dueDate}`)).toEqual([
      'tuition:2026-10:2026-10-22', // due day 10 was before admission: a week after it
      'admission:ONCE:2026-10-22',
    ]);
  });

  it('a study group amount overrides the class amount', () => {
    const dues = planStudentDues(
      input({
        student: {
          id: 's3',
          admittedOn: '2024-01-01',
          classLevelId: 'c9',
          studyGroupId: 'sci',
          siblingRank: null,
        },
      }),
    );
    expect(dues.every((d) => d.amountPaisa === 180000)).toBe(true);
    const arts = planStudentDues(
      input({
        student: {
          id: 's4',
          admittedOn: '2024-01-01',
          classLevelId: 'c9',
          studyGroupId: 'arts',
          siblingRank: null,
        },
      }),
    );
    expect(arts.every((d) => d.amountPaisa === 150000)).toBe(true);
  });

  it('a confirmed younger sibling gets the sibling rule on eligible heads only', () => {
    const dues = planStudentDues(
      input({
        asOf: '2026-10-22',
        student: {
          id: 's5',
          admittedOn: '2026-09-01',
          classLevelId: 'c6',
          studyGroupId: null,
          siblingRank: 2,
        },
      }),
    );
    const tuition = dues.find((d) => d.feeHeadId === 'tuition')!;
    expect(tuition).toMatchObject({ concessionPaisa: 50000, concessionSource: 'SIBLING' });
    const admission = dues.find((d) => d.feeHeadId === 'admission')!;
    expect(admission).toMatchObject({ concessionPaisa: 0, concessionSource: 'NONE' });
    // The eldest (rank 1) pays full.
    const eldest = planStudentDues(
      input({
        student: {
          id: 's6',
          admittedOn: '2024-01-01',
          classLevelId: 'c6',
          studyGroupId: null,
          siblingRank: 1,
        },
      }),
    );
    expect(eldest.every((d) => d.concessionPaisa === 0)).toBe(true);
  });

  it('a manual concession applies to dues falling due inside its dates; the larger one wins', () => {
    const dues = planStudentDues(
      input({
        concessions: [
          {
            id: 'c1',
            feeHeadId: 'tuition',
            type: 'PERCENT',
            value: 100,
            validFrom: '2026-10-01',
            endedOn: null,
          },
        ],
      }),
    );
    const byKey = Object.fromEntries(dues.map((d) => [d.periodKey, d]));
    expect(byKey['2026-09']).toMatchObject({
      concessionPaisa: 0,
      concessionSource: 'NONE',
      concessionId: null,
    });
    expect(byKey['2026-10']).toMatchObject({
      concessionPaisa: 100000,
      concessionSource: 'MANUAL',
      concessionId: 'c1',
    });
    const ended = planStudentDues(
      input({
        concessions: [
          {
            id: 'c1',
            feeHeadId: 'tuition',
            type: 'PERCENT',
            value: 100,
            validFrom: '2026-01-01',
            endedOn: '2026-10-01',
          },
        ],
      }),
    );
    expect(ended.find((d) => d.periodKey === '2026-10')!.concessionPaisa).toBe(0);
  });

  it('inactive heads and heads without an amount for the class are skipped', () => {
    const dues = planStudentDues(
      input({
        student: {
          id: 's7',
          admittedOn: '2024-01-01',
          classLevelId: 'c10',
          studyGroupId: null,
          siblingRank: null,
        },
      }),
    );
    expect(dues).toEqual([]);
    const heads = input().heads.map((h) => ({ ...h, isActive: h.id !== 'tuition' }));
    expect(planStudentDues(input({ heads })).some((d) => d.feeHeadId === 'tuition')).toBe(false);
  });
});

describe('amountInWords (receipts)', () => {
  it.each([
    [0, 'শূন্য টাকা মাত্র'],
    [100, 'এক টাকা মাত্র'],
    [9900, 'নিরানব্বই টাকা মাত্র'],
    [125000, 'এক হাজার দুই শত পঞ্চাশ টাকা মাত্র'],
    [125050, 'এক হাজার দুই শত পঞ্চাশ টাকা পঞ্চাশ পয়সা মাত্র'],
    [10000000, 'এক লক্ষ টাকা মাত্র'],
    [1234567800, 'এক কোটি তেইশ লক্ষ পঁয়তাল্লিশ হাজার ছয় শত আটাত্তর টাকা মাত্র'],
    [50, 'শূন্য টাকা পঞ্চাশ পয়সা মাত্র'],
  ])('bn %i', (paisa, words) => {
    expect(amountInWords(paisa, 'bn')).toBe(words);
  });

  it.each([
    [0, 'Zero taka only'],
    [125000, 'One thousand two hundred fifty taka only'],
    [125050, 'One thousand two hundred fifty taka and fifty paisa only'],
    [10000000, 'One lakh taka only'],
    [
      1234567800,
      'One crore twenty-three lakh forty-five thousand six hundred seventy-eight taka only',
    ],
  ])('en %i', (paisa, words) => {
    expect(amountInWords(paisa, 'en')).toBe(words);
  });
});

describe('identifiers', () => {
  it('receipt numbers: year and six ASCII digits', () => {
    expect(receiptNumber(2026, 123)).toBe('2026-000123');
    expect(receiptNumber(2026, 1234567)).toBe('2026-1234567');
  });

  it('maskPhone keeps the operator and the last three digits', () => {
    expect(maskPhone('+8801811000101')).toBe('018•••••101');
  });

  it('normalizeTrxId: Bangla digits, case and spaces; rejects junk', () => {
    expect(normalizeTrxId(' bfh7 kj2l-9q ')).toBe('BFH7KJ2L9Q');
    expect(normalizeTrxId('৯A১B২C৩D')).toBe('9A1B2C3D');
    expect(normalizeTrxId('abc')).toBeNull();
    expect(normalizeTrxId('ABC!DEF12')).toBeNull();
    expect(normalizeTrxId('A'.repeat(21))).toBeNull();
  });
});

describe('fee SMS (fixed Bangla text)', () => {
  it('receipt: Bangla amounts, ASCII receipt number, the balance only when something is left', () => {
    const text = receiptSmsText({
      institute: 'শাপলা উচ্চ বিদ্যালয়',
      student: 'তাসনিম',
      amountPaisa: 125000,
      receiptNumber: '2026-000123',
      date: '২২ অক্টো ২০২৬',
      balancePaisa: 50000,
    });
    expect(text).toContain('৳১,২৫০');
    expect(text).toContain('2026-000123');
    expect(text).toContain('বাকি ৳৫০০');
    expect(
      receiptSmsText({
        institute: 'x',
        student: 'y',
        amountPaisa: 100,
        receiptNumber: 'r',
        date: 'd',
        balancePaisa: 0,
      }),
    ).not.toContain('বাকি');
  });

  it('stays within 2 SMS even with long names', () => {
    const text = receiptSmsText({
      institute: 'শাপলা উচ্চ বিদ্যালয় ও কলেজ',
      student: 'মোছাম্মৎ তাসনিম রহমান চৌধুরী',
      amountPaisa: 1234567,
      receiptNumber: '2026-012345',
      date: '৩০ সেপ্টেম্বর ২০২৬',
      balancePaisa: 9876543,
    });
    expect(smsLength(text).segments).toBeLessThanOrEqual(2);
    expect(
      smsLength(
        reminderSmsText({
          institute: 'শাপলা উচ্চ বিদ্যালয় ও কলেজ',
          student: 'মোছাম্মৎ তাসনিম রহমান চৌধুরী',
          duePaisa: 9876543,
        }),
      ).segments,
    ).toBeLessThanOrEqual(2);
  });
});
