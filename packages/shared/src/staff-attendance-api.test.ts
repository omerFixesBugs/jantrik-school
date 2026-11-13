import { describe, expect, it } from 'vitest';
import {
  staffDayEntrySchema,
  staffDayParamsSchema,
  staffDayQuerySchema,
  staffMonthCsvQuerySchema,
  staffMonthQuerySchema,
  staffTrackedSchema,
} from './staff-attendance-api.js';

const UUID = '0199f000-0000-7000-8000-000000000001';

describe('staffDayEntrySchema', () => {
  const base = { status: 'PRESENT', inAt: '09:05', reason: 'Device was down', baseVersion: 0 };

  it('accepts Bangla digits in the times; times are optional', () => {
    expect(staffDayEntrySchema.parse({ ...base, inAt: '০৯:০৫', outAt: ' ১৭:৩০ ' })).toEqual({
      ...base,
      outAt: '17:30',
    });
    expect(staffDayEntrySchema.parse({ status: 'LEAVE', reason: 'Sick', baseVersion: 3 })).toEqual({
      status: 'LEAVE',
      reason: 'Sick',
      baseVersion: 3,
    });
    expect(staffDayEntrySchema.parse({ ...base, outAt: null }).outAt).toBeNull();
  });

  it('trims the reason to 3–200 characters, counted as characters (Bangla digits fine)', () => {
    expect(staffDayEntrySchema.parse({ ...base, reason: '  জ্বর ২ দিন  ' }).reason).toBe(
      'জ্বর ২ দিন',
    );
    expect(staffDayEntrySchema.parse({ ...base, reason: 'abc' }).reason).toBe('abc');
    expect(staffDayEntrySchema.parse({ ...base, reason: 'a'.repeat(200) }).reason).toHaveLength(
      200,
    );
    for (const reason of ['ab', '  ab  ', '', 'a'.repeat(201), '😀😀']) {
      expect(staffDayEntrySchema.safeParse({ ...base, reason }).success, reason).toBe(false);
    }
    // 200 characters, 400 UTF-16 units: the database counts characters.
    expect(staffDayEntrySchema.safeParse({ ...base, reason: '😀'.repeat(200) }).success).toBe(true);
  });

  it('rejects unknown statuses, bad times, a missing reason or base version', () => {
    for (const change of [
      { status: 'LATE' },
      { inAt: '24:00' },
      { inAt: '9:05' },
      { outAt: '17:60' },
      { reason: undefined },
      { baseVersion: -1 },
      { baseVersion: 1.5 },
      { baseVersion: undefined },
    ]) {
      expect(
        staffDayEntrySchema.safeParse({ ...base, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });
});

describe('the other requests', () => {
  it('day: an optional calendar date', () => {
    expect(staffDayQuerySchema.parse({})).toEqual({});
    expect(staffDayQuerySchema.parse({ date: '2026-10-21' })).toEqual({ date: '2026-10-21' });
    expect(staffDayQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });

  it('entry params: a user id and a calendar date', () => {
    expect(staffDayParamsSchema.parse({ userId: UUID, date: '2026-10-21' })).toEqual({
      userId: UUID,
      date: '2026-10-21',
    });
    expect(staffDayParamsSchema.safeParse({ userId: 'x', date: '2026-10-21' }).success).toBe(false);
    expect(staffDayParamsSchema.safeParse({ userId: UUID, date: 'tracked' }).success).toBe(false);
  });

  it('tracked: true, false or null (the default rule), never missing', () => {
    for (const tracked of [true, false, null]) {
      expect(staffTrackedSchema.parse({ tracked })).toEqual({ tracked });
    }
    expect(staffTrackedSchema.safeParse({}).success).toBe(false);
    expect(staffTrackedSchema.safeParse({ tracked: 'yes' }).success).toBe(false);
  });

  it('month and its CSV: YYYY-MM; locale bn and kind grid by default', () => {
    expect(staffMonthQuerySchema.parse({ month: '2026-10' })).toEqual({ month: '2026-10' });
    expect(staffMonthQuerySchema.safeParse({}).success).toBe(false);
    expect(staffMonthQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(staffMonthCsvQuerySchema.parse({ month: '2026-10' })).toEqual({
      month: '2026-10',
      locale: 'bn',
      kind: 'grid',
    });
    expect(
      staffMonthCsvQuerySchema.parse({ month: '2026-10', locale: 'en', kind: 'days' }),
    ).toMatchObject({ locale: 'en', kind: 'days' });
    expect(staffMonthCsvQuerySchema.safeParse({ month: '2026-10', kind: 'rows' }).success).toBe(
      false,
    );
  });
});
