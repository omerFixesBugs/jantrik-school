/**
 * Which translation messages each part of the app sends to the browser (docs/design.md →
 * Performance budget). The root layout sends `root`; each area's layout (or a page's server
 * wrapper) adds its own through <RouteMessages area="…">, merged onto what the layouts above it
 * sent, so a page carries only its own texts. Server components keep reading every message.
 *
 * Entries are namespaces or deeper paths (`fees.guardian.summary`). `route-messages.test.ts`
 * follows each page's imports and fails when a client component asks for a namespace its route
 * does not send; when it does, add the namespace to the area here (or give the route its own).
 */
export const ROUTE_MESSAGES = {
  /** Every page, the login and the platform too. */
  root: ['app', 'common', 'errorPage', 'errors', 'tenantChanged'],
  login: ['login'],
  selectInstitute: ['roles', 'selectInstitute', 'shell'],
  platform: [
    'comingSoon',
    'dateInput',
    'notAvailable',
    'platform',
    'platformBilling',
    'platformInstitutes',
    'platformSettings',
    'platformUsage',
    'setup',
    'shell',
  ],

  /** The institute app's shell (every page under (app)) and the small sets most pages use. */
  app: [
    'comingSoon',
    'connection',
    'dateInput',
    'enums',
    'nav',
    'navGroups',
    'notAvailable',
    'palette',
    'roles',
    'shell',
    'studentStatus',
    'table',
  ],
  dashboard: [
    'attendance',
    'board',
    'charts',
    'dashboard',
    'devices.devices.alerts',
    'devices.devices.dashboard',
    'devices.devices.duration',
    'devices.devices.errors',
    'devices.devices.feed',
    'devices.devices.state',
    'exams.common',
    'exams.guardian',
    'fees.guardian.dues.status',
    'fees.guardian.submissions.status',
    'fees.guardian.summary',
    'guardian',
    'reports',
    'students',
  ],

  students: ['students'],
  studentNew: ['admission', 'setup'],
  studentProfile: ['admission', 'profile', 'setup'],
  studentImport: ['import', 'setup'],

  attendance: ['attendance', 'reports'],
  attendanceToday: ['setup'],
  attendanceSettings: ['attendanceSettings', 'setup'],
  staffAttendance: [
    'attendanceSettings',
    'fees.common.period',
    'fees.common.status',
    'fees.reports',
    'setup',
    'staffAttendance',
  ],
  devices: ['devices.devices', 'fees.common.period', 'fees.common.status', 'fees.reports', 'setup'],
  devicePeople: ['devices.people'],

  fees: ['fees.common', 'fees.counter', 'setup'],
  feeLedger: ['dashboard'],
  feeSetup: ['fees.setup'],
  feeReports: ['fees.reports'],

  exams: [
    'exams.common',
    'exams.list',
    'fees.setup.errors',
    'fees.setup.kit',
    'fees.setup.ordinal',
    'setup',
  ],
  examSetup: ['exams.parts', 'exams.setup'],
  examDetail: [
    'exams.detail',
    'exams.parts',
    'exams.results',
    'exams.setupPanel',
    'exams.students',
  ],
  examSheet: ['exams.marks', 'exams.sheetAdmin'],
  examRemarks: ['exams.remarks'],
  examPrint: ['exams.print', 'fees.common.period', 'fees.common.status', 'fees.reports'],

  children: [
    'exams.common',
    'exams.guardian',
    'exams.print',
    'fees.common',
    'fees.guardian',
    'setup',
  ],

  setup: ['appearance', 'setup'],
  setupWelcome: ['attendanceSettings', 'dashboard', 'onboarding', 'staff'],
  staff: ['setup', 'staff'],
} as const satisfies Record<string, readonly string[]>;

export type RouteArea = keyof typeof ROUTE_MESSAGES;

type Messages = Record<string, unknown>;

/** The parts of `messages` the paths name (a path reaches into nested objects). */
export function pickMessages(messages: Messages, paths: readonly string[]): Messages {
  const out: Messages = {};
  for (const p of paths) {
    const keys = p.split('.');
    let source: unknown = messages;
    for (const k of keys) source = (source as Messages | undefined)?.[k];
    if (source === undefined) continue;
    let target = out;
    keys.slice(0, -1).forEach((k) => {
      target[k] = (target[k] as Messages | undefined) ?? {};
      target = target[k] as Messages;
    });
    const last = keys.at(-1)!;
    target[last] = mergeMessages((target[last] as Messages) ?? {}, source as Messages);
  }
  return out;
}

/** `extra` laid over `base`, object by object (a route's messages over its layouts'). */
export function mergeMessages(base: Messages, extra: Messages): Messages {
  if (typeof extra !== 'object' || extra === null) return extra;
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const b = out[k];
    out[k] =
      typeof v === 'object' && v !== null && typeof b === 'object' && b !== null
        ? mergeMessages(b as Messages, v as Messages)
        : v;
  }
  return out;
}
