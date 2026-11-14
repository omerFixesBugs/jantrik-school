import { describe, expect, it } from 'vitest';
import { DEVICE_SETTINGS_DEFAULTS, attendancePercent } from './attendance.js';
import { attendanceSettingsSchema, submitAttendanceSchema } from './attendance-schema.js';
import { addDays, isIsoDate, isoWeekday, todayIn } from './dates.js';
import { isoDateSchema } from './dates-schema.js';
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
      ...DEVICE_SETTINGS_DEFAULTS,
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

describe('attendanceSettingsSchema: device and staff settings', () => {
  const base = {
    mode: 'DAILY',
    weeklyOffDays: [5],
    editWindowDays: 0,
    leaveCountsAsAbsent: false,
    absentSmsEnabled: false,
    absentSmsTemplate: null,
    absentSmsDelayMinutes: 10,
    dailySmsCap: null,
    ...DEVICE_SETTINGS_DEFAULTS,
  } as const;
  const problems = (patch: Record<string, unknown>) => {
    const r = attendanceSettingsSchema.safeParse({ ...base, ...patch });
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('the defaults are what the database defaults to', () => {
    expect(DEVICE_SETTINGS_DEFAULTS).toEqual({
      deviceAutoMark: false,
      deviceGraceMinutes: 10,
      deviceCutoffMinutes: 60,
      deviceDefaultStart: '08:00',
      entrySmsEnabled: false,
      exitSmsEnabled: false,
      staffOfficeStart: '08:00',
      staffOfficeEnd: '16:00',
      staffLateGraceMinutes: 10,
      staffEarlyGraceMinutes: 10,
      deviceHoursStart: '05:00',
      deviceHoursEnd: '20:00',
      deviceMaxPunchesPerMinute: 60,
      staffDeviceIdStart: 9001,
      punchRetentionDays: 730,
    });
    expect(attendanceSettingsSchema.parse(base)).toMatchObject(DEVICE_SETTINGS_DEFAULTS);
  });

  it('accepts Bangla digits in numbers and times', () => {
    expect(
      attendanceSettingsSchema.parse({
        ...base,
        deviceGraceMinutes: '১৫',
        staffDeviceIdStart: ' ৯০০১ ',
        punchRetentionDays: '৩৬৫',
        deviceDefaultStart: '০৭:৩০',
        staffOfficeEnd: '১৭:০০',
      }),
    ).toMatchObject({
      deviceGraceMinutes: 15,
      staffDeviceIdStart: 9001,
      punchRetentionDays: 365,
      deviceDefaultStart: '07:30',
      staffOfficeEnd: '17:00',
    });
  });

  it.each([
    ['deviceGraceMinutes', -1],
    ['deviceGraceMinutes', 121],
    ['deviceCutoffMinutes', 14],
    ['deviceCutoffMinutes', 301],
    ['staffLateGraceMinutes', 121],
    ['staffEarlyGraceMinutes', -1],
    ['deviceMaxPunchesPerMinute', 9],
    ['deviceMaxPunchesPerMinute', 241],
    ['staffDeviceIdStart', 99],
    ['staffDeviceIdStart', 1_000_000_000],
    ['punchRetentionDays', 29],
    ['punchRetentionDays', 3651],
    ['deviceGraceMinutes', 2.5],
    ['deviceGraceMinutes', ''],
    ['deviceGraceMinutes', '1e1'],
    ['deviceDefaultStart', '8:00'],
    ['deviceHoursStart', '24:00'],
    ['deviceAutoMark', 'yes'],
  ])('rejects %s = %j', (field, value) => {
    expect(problems({ [field]: value })).toContain(field);
  });

  it.each([
    [{ deviceGraceMinutes: 0, deviceCutoffMinutes: 15, deviceMaxPunchesPerMinute: 10 }],
    [{ deviceGraceMinutes: 120, deviceCutoffMinutes: 300, deviceMaxPunchesPerMinute: 240 }],
    [{ staffDeviceIdStart: 100, punchRetentionDays: 30 }],
    [{ staffDeviceIdStart: 999_999_999, punchRetentionDays: 3650 }],
  ])('accepts the range ends %j', (patch) => {
    expect(problems(patch)).toEqual([]);
  });

  it('office hours and device hours must end after they start', () => {
    expect(problems({ staffOfficeStart: '16:00', staffOfficeEnd: '16:00' })).toEqual([
      'staffOfficeEnd',
    ]);
    expect(problems({ deviceHoursStart: '20:00', deviceHoursEnd: '05:00' })).toEqual([
      'deviceHoursEnd',
    ]);
    expect(problems({ staffOfficeStart: '07:59', staffOfficeEnd: '08:00' })).toEqual([]);
  });

  it('replaces the whole object: every new field is required', () => {
    for (const field of Object.keys(DEVICE_SETTINGS_DEFAULTS)) {
      const rest: Record<string, unknown> = { ...base };
      delete rest[field];
      const r = attendanceSettingsSchema.safeParse(rest);
      expect(r.success, field).toBe(false);
    }
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
    // The zod-free check the browser uses agrees.
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('18-10-2026')).toBe(false);
    expect(isIsoDate('2026-10-18')).toBe(true);
    expect(isIsoDate('2026-10-18T00:00')).toBe(false);
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
