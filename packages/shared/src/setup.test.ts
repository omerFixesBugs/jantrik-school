import { describe, expect, it } from 'vitest';
import {
  createClassLevelSchema,
  createShiftSchema,
  suggestNextYear,
  updateLabelsSchema,
} from './setup.js';

describe('suggestNextYear', () => {
  it.each([
    ['2026', '2027'],
    ['২০২৬', '2027'],
    ['2025-2026', '2026-2027'],
    ['2025-26', '2026-27'],
    ['2099-00', '2100-01'],
    ['Session A', 'Session A (+1)'],
  ])('%s → %s', (name, next) => {
    expect(suggestNextYear({ name, startDate: '2026-01-01', endDate: '2026-12-31' }).name).toBe(
      next,
    );
  });

  it('moves the dates one year on, 29 Feb → 28 Feb', () => {
    expect(
      suggestNextYear({ name: '2028', startDate: '2028-02-29', endDate: '2029-01-31' }),
    ).toMatchObject({ startDate: '2029-02-28', endDate: '2030-01-31' });
  });
});

describe('setup schemas', () => {
  it('normalises codes (case, spaces, Bangla digits)', () => {
    expect(
      createClassLevelSchema.parse({ code: ' class ৬ ', nameBn: 'ষষ্ঠ', nameEn: 'Six' }).code,
    ).toBe('CLASS_6');
    expect(
      createClassLevelSchema.safeParse({ code: 'ক্লাস', nameBn: 'x', nameEn: 'x' }).success,
    ).toBe(false);
  });

  it('shift times are HH:MM with end after start', () => {
    const ok = createShiftSchema.parse({
      nameBn: 'প্রভাতি',
      nameEn: 'Morning',
      startTime: '০৭:৩০',
      endTime: '12:00',
    });
    expect(ok.startTime).toBe('07:30');
    expect(
      createShiftSchema.safeParse({
        nameBn: 'x',
        nameEn: 'x',
        startTime: '12:00',
        endTime: '11:00',
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        nameBn: 'x',
        nameEn: 'x',
        startTime: '25:00',
        endTime: '26:00',
      }).success,
    ).toBe(false);
  });

  it('labels: known keys only, no duplicates', () => {
    expect(
      updateLabelsSchema.safeParse({ labels: [{ key: 'section', bn: 'ব্যাচ', en: 'Batch' }] })
        .success,
    ).toBe(true);
    expect(
      updateLabelsSchema.safeParse({ labels: [{ key: 'fee', bn: 'x', en: 'x' }] }).success,
    ).toBe(false);
    expect(
      updateLabelsSchema.safeParse({
        labels: [
          { key: 'section', bn: 'a', en: 'a' },
          { key: 'section', bn: 'b', en: 'b' },
        ],
      }).success,
    ).toBe(false);
  });
});
