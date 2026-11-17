import { addDays, localDateOf, localTimeOf, wallClockToUtc } from './dates.js';
import type { NoticeTargetView } from './notices.js';
import { smsLength } from './sms.js';

/**
 * SMS broadcasts (sprint 1 P6b, docs/notices.md → Broadcasts): quiet hours and the 3-segment
 * limit as pure functions, and the API's views. Quiet hours are fixed for every institute this
 * sprint (P6-E) and read in the institute's own timezone, so nothing assumes UTC+6.
 */

export const QUIET_HOURS = { start: '21:00', end: '08:00' } as const;

export const BROADCAST_LIMITS = {
  /** A broadcast is at most this many SMS segments (refused above: 422 SMS_TOO_LONG). */
  segments: 3,
  /** The database's backstop on the body (characters). */
  bodyChars: 480,
  /** Scheduling: at least this many minutes ahead … */
  minAheadMinutes: 5,
  /** … and at most this many days. */
  maxDays: 30,
  targets: 100,
  /**
   * A broadcast found this late (Redis lost its job, the worker was down) is not sent: it expires
   * and needs a new preview and send (review of #26, B3). Measured from its stored time, which a
   * quiet-hours wait moves to 08:00.
   */
  staleAfterHours: 3,
} as const;

export const BROADCAST_RECIPIENTS = ['PRIMARY_GUARDIANS', 'ALL_GUARDIANS', 'STAFF'] as const;
export type BroadcastRecipients = (typeof BROADCAST_RECIPIENTS)[number];

export const BROADCAST_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'SENT',
  'CANCELLED',
  'FAILED_OVER_CAP',
  'EXPIRED',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** Inside 21:00–08:00 (start included, end not) in the institute's timezone. */
export function inQuietHours(at: Date, timeZone: string): boolean {
  const now = minutesOf(localTimeOf(at, timeZone));
  return now >= minutesOf(QUIET_HOURS.start) || now < minutesOf(QUIET_HOURS.end);
}

/** `at` itself when allowed, otherwise the next 08:00 in the institute's timezone. */
export function nextAllowedAt(at: Date, timeZone: string): Date {
  if (!inQuietHours(at, timeZone)) return at;
  const today = localDateOf(at, timeZone);
  const evening = minutesOf(localTimeOf(at, timeZone)) >= minutesOf(QUIET_HOURS.start);
  const day = evening ? addDays(today, 1) : today;
  return wallClockToUtc(`${day} ${QUIET_HOURS.end}:00`, timeZone);
}

export type BroadcastProblem = 'EMPTY' | 'SMS_TOO_LONG';

/** A string cut to `max` characters (code points, never inside an emoji), with "…" when cut. */
export function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** What is wrong with a broadcast's text: empty, or more than 3 segments. */
export function broadcastProblems(body: string): BroadcastProblem[] {
  if (body.trim().length === 0) return ['EMPTY'];
  return smsLength(body).segments > BROADCAST_LIMITS.segments ? ['SMS_TOO_LONG'] : [];
}

// ── Views ──────────────────────────────────────────────────────────────────────────────────────

/** POST /broadcasts/:id/preview: what a send would cost now (S18, S19). */
export interface BroadcastPreview {
  /** SMS to send: phones after merging. */
  recipients: number;
  /** Students (guardian broadcasts) or staff without a usable phone. */
  withoutPhone: number;
  /** Phones shared by more than one student (siblings): merged into one SMS each. */
  mergedPhones: number;
  segments: number;
  encoding: 'GSM7' | 'UCS2';
  /** recipients × segments × the platform's rate, integer paisa. */
  costPaisa: number;
  /** Today's cap minus what is queued or sent today. */
  capLeftToday: number;
  /** All or nothing (S18): false when the recipients exceed the cap left. */
  fits: boolean;
  quietNow: boolean;
  /** Now, or the next 08:00 when inside quiet hours. */
  nextAllowedAt: string;
  sampleText: string;
  /**
   * What the admin confirms: a hash of the text, the recipient kind, the targets, the notice, the
   * recipient count, the segments and the cost. Send and schedule must present it; anything that
   * changed since (another tab, another admin, a new rate) is 409 PREVIEW_CHANGED.
   */
  token: string;
}

/** SMS of a broadcast by state, read live from sms_logs (P6-C). */
export interface BroadcastSmsCounts {
  queued: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface BroadcastView {
  id: string;
  body: string;
  recipients: BroadcastRecipients;
  status: BroadcastStatus;
  noticeId: string | null;
  targets: NoticeTargetView[];
  scheduledAt: string | null;
  previewCount: number | null;
  segments: number | null;
  estimatedCostPaisa: number | null;
  queuedCount: number | null;
  sentAt: string | null;
  cancelledAt: string | null;
  cancelReason: 'BY_ADMIN' | 'ACTOR_NOT_ADMIN' | null;
  /** FAILED_OVER_CAP: {needed, capLeft}; EXPIRED: {lateMinutes}. */
  failure: { needed?: number; capLeft?: number; lateMinutes?: number } | null;
  createdAt: string;
  sms: BroadcastSmsCounts;
}

/** The dashboard's warning (P6-D): broadcasts that failed over the cap or lost their admin. */
export interface BroadcastAlert {
  id: string;
  status: 'FAILED_OVER_CAP' | 'CANCELLED' | 'EXPIRED' | 'OVERDUE';
  at: string;
  bodyStart: string;
}
