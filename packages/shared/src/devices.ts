import { z } from 'zod';
import { addDays, localDateOf, timeZoneOffsetMinutes, wallClockToUtc } from './dates.js';
import type { IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';
import { formatTime } from './format.js';
import { smsLength } from './sms.js';

/**
 * ZKTeco attendance devices: the pure rules (protocol parsing, time, flags, IDs, SMS text).
 * No database, no network. The receiver, the jobs and the screens all call these.
 */

export const DEVICE_DIRECTIONS = ['IN', 'OUT', 'BOTH'] as const;
export type DeviceDirection = (typeof DEVICE_DIRECTIONS)[number];

export const PUNCH_DIRECTIONS = ['IN', 'OUT'] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const PUNCH_FLAGS = [
  'CLOCK_CORRECTED',
  'CLOCK_FUTURE',
  'STALE',
  'NEW_IP',
  'OUTSIDE_HOURS',
  'BURST',
] as const;
export type PunchFlag = (typeof PUNCH_FLAGS)[number];

export const PUNCH_REVIEWS = ['OK', 'ACCEPTED', 'REJECTED'] as const;
export type PunchReview = (typeof PUNCH_REVIEWS)[number];

export const PUNCH_OUTCOMES = ['APPLIED', 'UNMAPPED', 'IGNORED', 'STALE', 'HELD'] as const;
export type PunchOutcome = (typeof PUNCH_OUTCOMES)[number];

export const VERIFY_KINDS = ['FINGERPRINT', 'CARD', 'FACE', 'PASSWORD', 'OTHER'] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export const DEVICE_STATES = ['ONLINE', 'OFFLINE', 'NEVER_CONNECTED', 'INACTIVE'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

// ---------------------------------------------------------------------------------------------
// ATTLOG parsing

export const MAX_ATTLOG_LINES = 10_000;

export interface ParsedPunch {
  pin: string;
  deviceTime: string;
  state: number | null;
  verify: number | null;
}

export interface ParsedAttlog {
  punches: ParsedPunch[];
  rejected: number;
  lines: number;
  tooMany: boolean;
}

const PIN_RE = /^[A-Za-z0-9]{1,24}$/;
const DEVICE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function realDeviceTime(value: string): boolean {
  const m = DEVICE_TIME_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (h > 23 || mi > 59 || s > 59) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** An integer 0-255, or empty → null. `undefined` means the value is invalid. */
function smallInt(value: string | undefined): number | null | undefined {
  if (value === undefined || value === '') return null;
  if (!/^\d{1,3}$/.test(value)) return undefined;
  const n = Number(value);
  return n <= 255 ? n : undefined;
}

/**
 * The ATTLOG body: `PIN⇥time⇥state⇥verify⇥workcode…`, one punch per line. Only the first four
 * fields are read; the rest (work codes, temperature, mask) is dropped. A line that does not
 * parse is counted in `rejected`, never stored.
 */
export function parseAttlog(body: string): ParsedAttlog {
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (rawLines.length > MAX_ATTLOG_LINES) {
    return { punches: [], rejected: 0, lines: rawLines.length, tooMany: true };
  }
  const punches: ParsedPunch[] = [];
  let rejected = 0;
  for (const line of rawLines) {
    const [pin = '', deviceTime = '', stateRaw, verifyRaw] = line.split('\t');
    const state = smallInt(stateRaw);
    const verify = smallInt(verifyRaw);
    if (
      !PIN_RE.test(pin) ||
      !realDeviceTime(deviceTime) ||
      state === undefined ||
      verify === undefined
    ) {
      rejected += 1;
      continue;
    }
    punches.push({ pin, deviceTime, state, verify });
  }
  return { punches, rejected, lines: rawLines.length, tooMany: false };
}

// ---------------------------------------------------------------------------------------------
// Time

const MIN_CORRECTED_OFFSET_SEC = 120;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_SKEW_SAMPLE_SEC = 6 * 3600;
const SKEW_SPREAD_SEC = 90;

export type InterpretedPunch =
  { skip: true } | { skip: false; punchedAt: Date; localDate: IsoDate; flags: PunchFlag[] };

/**
 * Turns the device's wall-clock time into the instant the rules use. `clockOffsetSec` is the
 * device's measured error (device time minus real time), or null when not known yet.
 */
export function interpretPunch(input: {
  deviceTime: string;
  receivedAt: Date;
  timeZone: string;
  clockOffsetSec: number | null;
  registeredOn: IsoDate;
  staleDays?: number;
}): InterpretedPunch {
  const { receivedAt, timeZone, clockOffsetSec, registeredOn, staleDays = 7 } = input;
  const flags: PunchFlag[] = [];
  let punchedAt = wallClockToUtc(input.deviceTime, timeZone);
  if (clockOffsetSec !== null && Math.abs(clockOffsetSec) >= MIN_CORRECTED_OFFSET_SEC) {
    punchedAt = new Date(punchedAt.getTime() - clockOffsetSec * 1000);
    flags.push('CLOCK_CORRECTED');
  }
  if (punchedAt.getTime() > receivedAt.getTime() + FUTURE_TOLERANCE_MS) {
    punchedAt = receivedAt;
    flags.push('CLOCK_FUTURE');
  }
  const localDate = localDateOf(punchedAt, timeZone);
  if (localDate < registeredOn) return { skip: true };
  if (localDate < addDays(localDateOf(receivedAt, timeZone), -staleDays)) flags.push('STALE');
  return { skip: false, punchedAt, localDate, flags };
}

/**
 * Folds one skew sample (device time minus our clock, seconds) into a device's history. The
 * offset only changes when the last 3 samples agree within 90 s; then it is their median.
 */
export function nextClockOffset(
  samples: number[],
  offset: number | null,
  sample: number,
): { samples: number[]; offset: number | null } {
  if (Math.abs(sample) > MAX_SKEW_SAMPLE_SEC) return { samples, offset };
  const kept = [...samples, sample].slice(-5);
  const last = kept.slice(-3);
  if (last.length < 3) return { samples: kept, offset };
  const sorted = [...last].sort((a, b) => a - b);
  if (sorted[2]! - sorted[0]! > SKEW_SPREAD_SEC) return { samples: kept, offset };
  return { samples: kept, offset: Math.round(sorted[1]!) };
}

// ---------------------------------------------------------------------------------------------
// Punch meaning

const BOTH_IN_STATES = new Set([0, 3, 4, 9]);
const BOTH_OUT_STATES = new Set([1, 2, 5, 8]);

export function punchDirection(device: DeviceDirection, state: number | null): PunchDirection {
  if (device !== 'BOTH') return device;
  if (state !== null && BOTH_OUT_STATES.has(state)) return 'OUT';
  if (state !== null && BOTH_IN_STATES.has(state)) return 'IN';
  return 'IN';
}

/** Firmware numberings differ for 0 and 2, so only the codes both agree on get a name. */
export function verifyKind(code: number | null): VerifyKind {
  switch (code) {
    case 1:
      return 'FINGERPRINT';
    case 3:
      return 'PASSWORD';
    case 4:
      return 'CARD';
    case 15:
      return 'FACE';
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------------------------
// Protocol answers and commands

/** The `GET OPTION FROM` answer to a device's handshake. LF lines, trailing LF. */
export function handshakeOptions(input: {
  sn: string;
  attlogStamp: string | null;
  timeZone: string;
  at: Date;
  legacy: boolean;
}): string {
  const stamp = input.attlogStamp && input.attlogStamp !== '0' ? input.attlogStamp : 'None';
  const [attKey, opKey, photoKey] = input.legacy
    ? ['Stamp', 'OpStamp', 'PhotoStamp']
    : ['ATTLOGStamp', 'OPERLOGStamp', 'ATTPHOTOStamp'];
  const minutes = timeZoneOffsetMinutes(input.timeZone, input.at);
  const zone = minutes % 60 === 0 ? minutes / 60 : minutes;
  return (
    [
      `GET OPTION FROM: ${input.sn}`,
      `${attKey}=${stamp}`,
      `${opKey}=9999`,
      `${photoKey}=9999`,
      'ErrorDelay=60',
      'Delay=30',
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog',
      `TimeZone=${zone}`,
      'Realtime=1',
      'Encrypt=None',
    ].join('\n') + '\n'
  );
}

function cleanAscii(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * The name a device shows: printable ASCII only (no tabs or line breaks, so a name can never add
 * a field or a command), at most 24 characters. Empty falls back to `fallback`, filtered the same.
 */
export function deviceDisplayName(nameEn: string | null, fallback: string): string {
  const cut = (v: string) => cleanAscii(cleanAscii(v).slice(0, 24));
  return cut(nameEn ?? '') || cut(fallback);
}

export function userUpsertPayload(pin: string, name: string): string {
  assertPin(pin);
  return `DATA UPDATE USERINFO PIN=${pin}\tName=${deviceDisplayName(name, '')}`;
}

export function userDeletePayload(pin: string): string {
  assertPin(pin);
  return `DATA DELETE USERINFO PIN=${pin}`;
}

export function commandLine(seq: number | bigint, payload: string): string {
  if (/[\r\n]/.test(payload)) throw new Error('A device command cannot contain a line break');
  return `C:${seq}:${payload}`;
}

function assertPin(pin: string): void {
  if (!PIN_RE.test(pin)) throw new Error('Not a valid device user id');
}

export interface DeviceCmdResult {
  id: number;
  returnCode: number;
  cmd: string;
}

/** `ID=<seq>&Return=<code>&CMD=…` lines from POST /iclock/devicecmd; anything else is ignored. */
export function parseDeviceCmdResults(body: string): DeviceCmdResult[] {
  const out: DeviceCmdResult[] = [];
  for (const line of body.split(/\r?\n/)) {
    const fields = new Map<string, string>();
    for (const part of line.split('&')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const id = fields.get('ID');
    const code = fields.get('Return');
    if (id === undefined || code === undefined) continue;
    if (!/^\d+$/.test(id) || !/^-?\d+$/.test(code)) continue;
    out.push({ id: Number(id), returnCode: Number(code), cmd: fields.get('CMD') ?? '' });
  }
  return out;
}

/** From the `INFO` query param (`firmware,users,…`) keep only the firmware and the user count. */
export function parseInfo(info: string | undefined): {
  firmware: string | null;
  userCount: number | null;
} {
  if (!info) return { firmware: null, userCount: null };
  const [first = '', second = ''] = info.split(',');
  const firmware = first
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 60)
    .trim();
  const count = second.trim();
  return {
    firmware: firmware || null,
    userCount: /^\d{1,9}$/.test(count) ? Number(count) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Device user ids (one per person, unique across students and staff)

export const DEVICE_USER_ID_RE = /^[1-9][0-9]{2,8}$/;

export const deviceUserIdSchema = z
  .string()
  .transform((v) => toAsciiDigits(v).trim())
  .pipe(
    z.string().regex(DEVICE_USER_ID_RE, 'Device ID must be 3 to 9 digits, not starting with 0'),
  );

/** The digits of a student code without leading zeros, or null when that is not a valid ID. */
export function defaultStudentDeviceId(code: string): string | null {
  const digits = toAsciiDigits(code).replace(/\D/g, '').replace(/^0+/, '');
  return DEVICE_USER_ID_RE.test(digits) ? digits : null;
}

const MAX_DEVICE_USER_ID = 999_999_999;

/** The smallest free number from `start` (never below 100), skipping used and reserved ones. */
export function nextStaffDeviceId(
  start: number,
  used: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string | null {
  for (let n = Math.max(start, 100); n <= MAX_DEVICE_USER_ID; n += 1) {
    const id = String(n);
    if (!used.has(id) && !reserved.has(id)) return id;
  }
  return null;
}

export interface DeviceIdPerson {
  key: string;
  kind: 'STUDENT' | 'STAFF';
  current: string | null;
  wanted: string | null;
}

export interface DeviceIdCollision {
  deviceUserId: string;
  wantedBy: string[];
  heldBy: string | null;
}

/**
 * Numbers wanted by someone who does not hold them while another person does, or wanted by two
 * or more people who have no ID yet. Keys are opaque to this function.
 */
export function deviceIdCollisions(people: DeviceIdPerson[]): DeviceIdCollision[] {
  const holders = new Map<string, string>();
  for (const p of people) if (p.current !== null) holders.set(p.current, p.key);
  const wanters = new Map<string, DeviceIdPerson[]>();
  for (const p of people) {
    if (p.wanted === null || p.wanted === p.current) continue;
    const list = wanters.get(p.wanted) ?? [];
    list.push(p);
    wanters.set(p.wanted, list);
  }
  const out: DeviceIdCollision[] = [];
  for (const [deviceUserId, list] of wanters) {
    const heldBy = holders.get(deviceUserId) ?? null;
    if (heldBy !== null) {
      out.push({ deviceUserId, wantedBy: list.map((p) => p.key), heldBy });
      continue;
    }
    const unmapped = list.filter((p) => p.current === null);
    if (unmapped.length >= 2)
      out.push({ deviceUserId, wantedBy: unmapped.map((p) => p.key), heldBy });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Flags and SMS eligibility

/** Outside the institute's hours; the end is inclusive to the second. */
export function outsideHours(localTime: string, hours: { start: string; end: string }): boolean {
  return localTime < `${hours.start}:00` || localTime > `${hours.end}:00`;
}

export interface PunchStatus {
  flags: readonly PunchFlag[];
  review: PunchReview | null;
}

/** A rejected punch never counts; a BURST punch counts only once an admin accepted it. */
export function countsForAttendance(p: PunchStatus): boolean {
  if (p.review === 'REJECTED') return false;
  if (p.flags.includes('BURST') && p.review !== 'ACCEPTED') return false;
  return true;
}

/** Punches received within this long of being made count as real time (no backlog SMS). */
export const REALTIME_WINDOW_MS = 10 * 60_000;

const NO_SMS_FLAGS: readonly PunchFlag[] = ['NEW_IP', 'OUTSIDE_HOURS', 'STALE', 'CLOCK_FUTURE'];

export function sendsSms(p: PunchStatus & { punchedAt: Date; receivedAt: Date }): boolean {
  if (!countsForAttendance(p)) return false;
  if (p.flags.some((f) => NO_SMS_FLAGS.includes(f))) return false;
  return p.receivedAt.getTime() - p.punchedAt.getTime() <= REALTIME_WINDOW_MS;
}

// ---------------------------------------------------------------------------------------------
// Student arrival and closing the register

const toSeconds = (hhmm: string): number => {
  const [h = 0, m = 0, s = 0] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/** LATE iff the first IN is strictly after shift start + grace (08:10:00 is on time at grace 10). */
export function arrivalStatus(
  firstIn: string,
  shiftStart: string,
  graceMin: number,
): 'PRESENT' | 'LATE' {
  return toSeconds(firstIn) > toSeconds(shiftStart) + graceMin * 60 ? 'LATE' : 'PRESENT';
}

/** When a shift's register may be closed: its start + cutoff minutes, at most 23:59:59. */
export function cutoffTime(shiftStart: string, cutoffMin: number): string {
  const total = toSeconds(shiftStart) + cutoffMin * 60;
  if (total >= 86_400) return '23:59:59';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/** A device counts as "seen recently" for closing a register when it called in this recently. */
export const DEVICES_SEEN_WINDOW_MS = 15 * 60_000;

export type CloseDecision = 'CLOSE' | 'WAIT' | 'DEVICE_OFFLINE' | 'TOO_MANY_MISSING';

export function closeDecision(input: {
  cutoffPassed: boolean;
  devicesSeenRecently: boolean;
  enrolled: number;
  arrived: number;
}): CloseDecision {
  if (!input.cutoffPassed || input.enrolled === 0) return 'WAIT';
  if (!input.devicesSeenRecently) return 'DEVICE_OFFLINE';
  if ((input.enrolled - input.arrived) * 2 > input.enrolled) return 'TOO_MANY_MISSING';
  return 'CLOSE';
}

export const DEVICE_ONLINE_WINDOW_MS = 120_000;

export function deviceState(lastSeenAt: Date | null, now: Date, isActive: boolean): DeviceState {
  if (!isActive) return 'INACTIVE';
  if (lastSeenAt === null) return 'NEVER_CONNECTED';
  return now.getTime() - lastSeenAt.getTime() <= DEVICE_ONLINE_WINDOW_MS ? 'ONLINE' : 'OFFLINE';
}

// ---------------------------------------------------------------------------------------------
// Entry and exit SMS

const MAX_SMS_SEGMENTS = 2;

function movementSms(
  verb: string,
  input: { student: string; at: Date; institute: string },
): string {
  const time = formatTime(input.at, 'bn');
  const fits = (text: string) => smsLength(text).segments <= MAX_SMS_SEGMENTS;
  const full = `${input.student} ${verb} ${time} — ${input.institute}`;
  if (fits(full)) return full;
  const short = `${input.student} ${verb} ${time}`;
  if (fits(short)) return short;
  const letters = Array.from(input.student);
  while (letters.length > 1) {
    letters.pop();
    const text = `${letters.join('').trimEnd()} ${verb} ${time}`;
    if (fits(text)) return text;
  }
  return `${letters.join('')} ${verb} ${time}`;
}

export function entrySmsText(input: { student: string; at: Date; institute: string }): string {
  return movementSms('প্রবেশ করেছে', input);
}

export function exitSmsText(input: { student: string; at: Date; institute: string }): string {
  return movementSms('বের হয়েছে', input);
}
