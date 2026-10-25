import { DEVICE_SETTINGS_DEFAULTS } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { deviceBody, deviceFieldErrors, deviceValues } from './device-settings';

describe('deviceValues', () => {
  it('shows times and counts in Bangla digits, the staff ID start in ASCII', () => {
    const v = deviceValues({ ...DEVICE_SETTINGS_DEFAULTS, deviceAutoMark: true }, 'bn');
    expect(v.deviceAutoMark).toBe(true);
    expect(v.deviceDefaultStart).toBe('০৮:০০');
    expect(v.deviceGraceMinutes).toBe('১০');
    expect(v.punchRetentionDays).toBe('৭৩০');
    expect(v.staffDeviceIdStart).toBe('9001');
    expect(deviceValues(DEVICE_SETTINGS_DEFAULTS, 'en').deviceGraceMinutes).toBe('10');
  });
});

describe('deviceBody', () => {
  it('sends ASCII digits and tidy times', () => {
    const v = deviceValues(DEVICE_SETTINGS_DEFAULTS, 'bn');
    const body = deviceBody({
      ...v,
      staffOfficeStart: '৮:৩০',
      deviceCutoffMinutes: ' ৪৫ ',
      staffDeviceIdStart: '৯৫০০',
    });
    expect(body).toMatchObject({
      deviceDefaultStart: '08:00',
      staffOfficeStart: '08:30',
      deviceCutoffMinutes: '45',
      deviceGraceMinutes: '10',
      staffDeviceIdStart: '9500',
      deviceAutoMark: false,
    });
  });

  it('leaves what is not a number or a time for the API to refuse', () => {
    const v = deviceValues(DEVICE_SETTINGS_DEFAULTS, 'en');
    expect(deviceBody({ ...v, deviceHoursEnd: 'late', deviceGraceMinutes: 'ten' })).toMatchObject({
      deviceHoursEnd: 'late',
      deviceGraceMinutes: 'ten',
    });
  });
});

describe('deviceFieldErrors', () => {
  const invalid = (errors: { path: string; message: string }[]) =>
    new ApiError(400, undefined, 'Validation failed', undefined, {
      statusCode: 400,
      message: 'Validation failed',
      errors,
    });

  it('puts each problem on its field', () => {
    expect(
      deviceFieldErrors(
        invalid([
          { path: 'deviceGraceMinutes', message: 'Too big' },
          { path: 'staffOfficeStart', message: 'Use HH:MM' },
          { path: 'staffOfficeEnd', message: 'End must be after start' },
          { path: 'absentSmsDelayMinutes', message: 'Too big' },
        ]),
      ),
    ).toEqual({ deviceGraceMinutes: 'RANGE', staffOfficeStart: 'TIME', staffOfficeEnd: 'END' });
  });

  it('has nothing for other errors', () => {
    expect(deviceFieldErrors(new ApiError(500, undefined, 'x'))).toEqual({});
    expect(deviceFieldErrors(null)).toEqual({});
  });
});
