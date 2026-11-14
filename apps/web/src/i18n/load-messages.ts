import type { Locale } from './config';

/**
 * Fee screens keep their messages in messages/fees/<area>.<locale>.json (one file per area, so
 * areas are edited independently); they are merged into the `fees` namespace.
 */
const FEE_AREAS = ['common', 'counter', 'setup', 'reports', 'guardian'] as const;

/** Exam screens likewise: messages/exams/<area>.<locale>.json, merged into `exams`. */
const EXAM_AREAS = ['common', 'marks', 'setup', 'results', 'guardian'] as const;

/** Attendance devices likewise: messages/devices/<area>.<locale>.json, merged into `devices`. */
const DEVICE_AREAS = ['devices', 'people'] as const;

/** Staff attendance likewise: messages/staff-attendance/<area>.<locale>.json, into `staffAttendance`. */
const STAFF_ATTENDANCE_AREAS = ['common', 'day', 'month'] as const;

/** Every message of a language (server side; the browser gets each route's part). */
export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const base = (await import(`../../messages/${locale}.json`)).default;
  const fees = await Promise.all(
    FEE_AREAS.map(
      async (area) => (await import(`../../messages/fees/${area}.${locale}.json`)).default,
    ),
  );
  const exams = await Promise.all(
    EXAM_AREAS.map(
      async (area) => (await import(`../../messages/exams/${area}.${locale}.json`)).default,
    ),
  );
  const devices = await Promise.all(
    DEVICE_AREAS.map(
      async (area) => (await import(`../../messages/devices/${area}.${locale}.json`)).default,
    ),
  );
  const staffAttendance = await Promise.all(
    STAFF_ATTENDANCE_AREAS.map(
      async (area) =>
        (await import(`../../messages/staff-attendance/${area}.${locale}.json`)).default,
    ),
  );
  return {
    ...base,
    fees: Object.assign({}, ...fees),
    exams: Object.assign({}, ...exams),
    devices: Object.assign({}, ...devices),
    staffAttendance: Object.assign({}, ...staffAttendance),
  };
}
