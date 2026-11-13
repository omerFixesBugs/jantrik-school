import type { StaffDayRecord } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { entryBody, entryForm, entryProblems, reasonLength, type EntryForm } from './entry';

const form = (patch: Partial<EntryForm> = {}): EntryForm => ({
  status: 'PRESENT',
  inAt: '০৯:১৫',
  outAt: '',
  reason: 'ডিভাইস নষ্ট ছিল',
  ...patch,
});

describe('entryProblems', () => {
  it('accepts a present day with an in time and a reason', () => {
    expect(entryProblems(form())).toEqual({});
    expect(entryProblems(form({ outAt: '১৬:০০' }))).toEqual({});
  });

  it('needs the in time for a present day only', () => {
    expect(entryProblems(form({ inAt: ' ' }))).toEqual({ inAt: 'IN_REQUIRED' });
    expect(entryProblems(form({ status: 'LEAVE', inAt: '' }))).toEqual({});
    expect(entryProblems(form({ status: 'ABSENT', inAt: 'x', outAt: 'y' }))).toEqual({});
  });

  it('checks the times and their order', () => {
    expect(entryProblems(form({ inAt: '৯টা' }))).toEqual({ inAt: 'TIME_INVALID' });
    expect(entryProblems(form({ outAt: '25:00' }))).toEqual({ outAt: 'TIME_INVALID' });
    expect(entryProblems(form({ inAt: '10:00', outAt: '০৯:৫৯' }))).toEqual({
      outAt: 'OUT_BEFORE_IN',
    });
    // The same minute stands (the API refuses only an out before the in).
    expect(entryProblems(form({ inAt: '10:00', outAt: '১০:০০' }))).toEqual({});
  });

  it('counts the reason in characters, trimmed, from 3 to 200', () => {
    expect(entryProblems(form({ reason: '  ছু ' }))).toEqual({ reason: 'REASON_SHORT' });
    expect(entryProblems(form({ reason: 'অসু' }))).toEqual({});
    expect(entryProblems(form({ reason: 'ক'.repeat(201) }))).toEqual({ reason: 'REASON_LONG' });
    expect(reasonLength(' ক্ষমা ')).toBe(5); // code points, as the database counts them
  });
});

describe('entryBody', () => {
  it('sends ASCII times for a present day and none otherwise', () => {
    expect(entryBody(form({ outAt: '৪:০৫' }), 3)).toEqual({
      status: 'PRESENT',
      inAt: '09:15',
      outAt: '04:05',
      reason: 'ডিভাইস নষ্ট ছিল',
      baseVersion: 3,
    });
    expect(entryBody(form({ status: 'LEAVE', reason: ' অসুস্থ ' }), 0)).toEqual({
      status: 'LEAVE',
      inAt: null,
      outAt: null,
      reason: 'অসুস্থ',
      baseVersion: 0,
    });
  });
});

describe('entryForm', () => {
  const day: StaffDayRecord = {
    status: 'PRESENT',
    inAt: '2026-10-25T03:12:00.000Z', // 09:12 in Dhaka
    outAt: '2026-10-25T10:05:00.000Z', // 16:05
    lateMinutes: 12,
    earlyMinutes: 0,
    source: 'MANUAL',
    reason: 'কার্ড ভুলে গেছেন',
    version: 2,
    updatedBy: { id: 'u1', name: 'Admin', nameBn: null },
  };

  it("starts from the stored day's status, local times and reason", () => {
    expect(entryForm(day, 'bn')).toEqual({
      status: 'PRESENT',
      inAt: '০৯:১২',
      outAt: '১৬:০৫',
      reason: 'কার্ড ভুলে গেছেন',
    });
    expect(entryForm(day, 'en').inAt).toBe('09:12');
  });

  it("does not take a device day's empty reason or missing times", () => {
    expect(
      entryForm(
        { ...day, source: 'DEVICE', reason: null, outAt: null, updatedBy: day.updatedBy },
        'en',
      ),
    ).toEqual({ status: 'PRESENT', inAt: '09:12', outAt: '', reason: '' });
  });

  it('starts as present with nothing typed without a stored day', () => {
    expect(entryForm(null, 'bn')).toEqual({ status: 'PRESENT', inAt: '', outAt: '', reason: '' });
  });
});
