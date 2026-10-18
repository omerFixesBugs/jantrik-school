import { describe, expect, it } from 'vitest';
import {
  attendancePercent,
  attendanceSettingsSchema,
  submitAttendanceSchema,
} from './attendance.js';
import { addDays, isoDateSchema, isoWeekday, todayIn } from './dates.js';
import {
  DEFAULT_ABSENT_SMS_TEMPLATE,
  renderSmsTemplate,
  smsLength,
  validateSmsTemplate,
} from './sms.js';

describe('smsLength (segments are what we pay for)', () => {
  it.each([
    ['', 'GSM7', 0, 1],
    ['a'.repeat(160), 'GSM7', 160, 1],
    ['a'.repeat(161), 'GSM7', 161, 2],
    ['a'.repeat(306), 'GSM7', 306, 2], // 2 × 153
    ['a'.repeat(307), 'GSM7', 307, 3],
    ['€'.repeat(80), 'GSM7', 160, 1], // extension characters count twice
    ['€'.repeat(81), 'GSM7', 162, 2],
    ['অ'.repeat(70), 'UCS2', 70, 1],
    ['অ'.repeat(71), 'UCS2', 71, 2],
    ['অ'.repeat(134), 'UCS2', 134, 2], // 2 × 67
    ['অ'.repeat(135), 'UCS2', 135, 3],
    ['Hi অ', 'UCS2', 4, 1], // one Bangla letter makes the whole SMS UCS-2
    ['😀'.repeat(35), 'UCS2', 70, 1], // emoji are two UTF-16 units
  ] as const)('%#: %s', (text, encoding, length, segments) => {
    expect(smsLength(text)).toEqual({ encoding, length, segments });
  });

  it('the default absent SMS fits in 2 segments with real names', () => {
    const text = renderSmsTemplate(DEFAULT_ABSENT_SMS_TEMPLATE, {
      student: 'তাসনিম রহমান',
      date: '১৮ অক্টোবর ২০২৬',
      institute: 'শাপলা উচ্চ বিদ্যালয়',
    });
    expect(text).toBe(
      'প্রিয় অভিভাবক, আজ ১৮ অক্টোবর ২০২৬ তারিখে তাসনিম রহমান শাপলা উচ্চ বিদ্যালয়-এ অনুপস্থিত।',
    );
    expect(smsLength(text).segments).toBeLessThanOrEqual(2);
  });
});

describe('SMS templates', () => {
  it('accepts known variables and the default', () => {
    expect(validateSmsTemplate(DEFAULT_ABSENT_SMS_TEMPLATE)).toEqual([]);
    expect(validateSmsTemplate('{student} আজ আসেনি ({date}), {institute}')).toEqual([]);
  });

  it.each([
    ['', 'Template is empty'],
    ['{name} আসেনি', 'Unknown variable {name}'],
    ['{ student } আসেনি', 'Unknown variable { student }'],
    ['{student আসেনি', 'Unmatched { or }'],
    ['আসেনি }', 'Unmatched { or }'],
    ['{student} '.repeat(30), 'Too long: more than 3 SMS with long names'],
  ])('rejects %j', (template, problem) => {
    expect(validateSmsTemplate(template)).toContain(problem);
  });

  it('renders every occurrence', () => {
    expect(
      renderSmsTemplate('{student}/{student} {date} {institute}', {
        student: 'A',
        date: 'D',
        institute: 'I',
      }),
    ).toBe('A/A D I');
  });

  it('the settings schema runs the template check', () => {
    const base = {
      mode: 'DAILY',
      weeklyOffDays: [5],
      editWindowDays: 0,
      leaveCountsAsAbsent: false,
      absentSmsEnabled: true,
      absentSmsDelayMinutes: 10,
      dailySmsCap: null,
    } as const;
    expect(attendanceSettingsSchema.safeParse({ ...base, absentSmsTemplate: '{x}' }).success).toBe(
      false,
    );
    // Empty means "use the built-in template".
    expect(
      attendanceSettingsSchema.parse({ ...base, absentSmsTemplate: '  ' }).absentSmsTemplate,
    ).toBe(null);
  });
});

describe('dates', () => {
  it('today in the tenant timezone, not UTC or the device', () => {
    // 20:30 UTC on 17 Oct is already 18 Oct (02:30) in Dhaka.
    expect(todayIn('Asia/Dhaka', new Date('2026-10-17T20:30:00Z'))).toBe('2026-10-18');
    expect(todayIn('UTC', new Date('2026-10-17T20:30:00Z'))).toBe('2026-10-17');
  });

  it('weekdays and day arithmetic', () => {
    expect(isoWeekday('2026-10-16')).toBe(5); // Friday
    expect(isoWeekday('2026-10-18')).toBe(7); // Sunday
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('rejects impossible dates', () => {
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(isoDateSchema.safeParse('18-10-2026').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-10-18').success).toBe(true);
  });
});

describe('attendancePercent', () => {
  const c = { present: 6, absent: 2, late: 1, leave: 1 };

  it('LATE counts as present; LEAVE is left out by default', () => {
    expect(attendancePercent(c, false)).toBeCloseTo((7 / 9) * 100); // 77.8
  });

  it('LEAVE counts as absent when the tenant says so', () => {
    expect(attendancePercent(c, true)).toBeCloseTo((7 / 10) * 100);
  });

  it('null when nothing counts', () => {
    expect(attendancePercent({ present: 0, absent: 0, late: 0, leave: 3 }, false)).toBeNull();
  });
});

describe('submitAttendanceSchema', () => {
  const studentId = '0199f000-0000-7000-8000-000000000001';
  it('rejects the same student twice', () => {
    const result = submitAttendanceSchema.safeParse({
      sectionId: '0199f000-0000-7000-8000-000000000002',
      date: '2026-10-18',
      submissionId: '0199f000-0000-7000-8000-000000000003',
      baseVersion: 0,
      records: [
        { studentId, status: 'PRESENT' },
        { studentId, status: 'ABSENT' },
      ],
    });
    expect(result.success).toBe(false);
  });
});
