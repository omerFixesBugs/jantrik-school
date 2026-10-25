import { toAsciiDigits, type DeviceAttendanceSettings } from '@jantrik/shared';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { inputDigits, normalizeTime } from './time-input';

/*
 * The device and staff settings as the settings form edits them: numbers and times as typed
 * (Bangla digits shown and accepted), sent back tidied; the API's 400 put on their fields.
 */

/** The API's bounds (attendanceSettingsSchema), for the hints and the error text. */
export const DEVICE_NUMBER_FIELDS = {
  deviceGraceMinutes: [0, 120],
  deviceCutoffMinutes: [15, 300],
  staffLateGraceMinutes: [0, 120],
  staffEarlyGraceMinutes: [0, 120],
  deviceMaxPunchesPerMinute: [10, 240],
  staffDeviceIdStart: [100, 999_999_999],
  punchRetentionDays: [30, 3650],
} as const;
export type DeviceNumberField = keyof typeof DEVICE_NUMBER_FIELDS;

export const DEVICE_TIME_FIELDS = [
  'deviceDefaultStart',
  'staffOfficeStart',
  'staffOfficeEnd',
  'deviceHoursStart',
  'deviceHoursEnd',
] as const;
export type DeviceTimeField = (typeof DEVICE_TIME_FIELDS)[number];

export type DeviceValues = Pick<
  DeviceAttendanceSettings,
  'deviceAutoMark' | 'entrySmsEnabled' | 'exitSmsEnabled'
> &
  Record<DeviceNumberField | DeviceTimeField, string>;

/** The staff ID start is an ID: ASCII digits whatever the language. */
const ASCII_ONLY: readonly DeviceNumberField[] = ['staffDeviceIdStart'];

export function deviceValues(s: DeviceAttendanceSettings, locale: Locale): DeviceValues {
  const out = {
    deviceAutoMark: s.deviceAutoMark,
    entrySmsEnabled: s.entrySmsEnabled,
    exitSmsEnabled: s.exitSmsEnabled,
  } as DeviceValues;
  for (const f of Object.keys(DEVICE_NUMBER_FIELDS) as DeviceNumberField[]) {
    out[f] = ASCII_ONLY.includes(f) ? String(s[f]) : inputDigits(s[f], locale);
  }
  for (const f of DEVICE_TIME_FIELDS) out[f] = inputDigits(s[f], locale);
  return out;
}

/** What the PUT sends: ASCII digits, "HH:MM" times; anything else as typed, for the API to judge. */
export function deviceBody(v: DeviceValues): DeviceValues {
  const out = { ...v };
  for (const f of Object.keys(DEVICE_NUMBER_FIELDS) as DeviceNumberField[]) {
    out[f] = toAsciiDigits(v[f]).trim();
  }
  for (const f of DEVICE_TIME_FIELDS) out[f] = normalizeTime(v[f]);
  return out;
}

export type DeviceFieldProblem = 'RANGE' | 'TIME' | 'END';

/** A 400's problems on the device fields: out of range, not a time, or an end before its start. */
export function deviceFieldErrors(
  error: unknown,
): Partial<Record<DeviceNumberField | DeviceTimeField, DeviceFieldProblem>> {
  if (!(error instanceof ApiError) || error.status !== 400) return {};
  const body = error.body as { errors?: { path: string; message: string }[] } | null | undefined;
  const out: Partial<Record<DeviceNumberField | DeviceTimeField, DeviceFieldProblem>> = {};
  for (const e of body?.errors ?? []) {
    if (e.path in DEVICE_NUMBER_FIELDS) out[e.path as DeviceNumberField] = 'RANGE';
    else if ((DEVICE_TIME_FIELDS as readonly string[]).includes(e.path)) {
      out[e.path as DeviceTimeField] = e.message.startsWith('End must be') ? 'END' : 'TIME';
    }
  }
  return out;
}
