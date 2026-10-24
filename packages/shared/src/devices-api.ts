import { z } from 'zod';
import type { PersonRef } from './attendance.js';
import type { IsoDate } from './dates.js';
import {
  DEVICE_DIRECTIONS,
  type DeviceDirection,
  type DeviceState,
  type PunchDirection,
  type PunchFlag,
  type PunchOutcome,
  type PunchReview,
  type VerifyKind,
} from './devices.js';
import { toAsciiDigits } from './digits.js';

// The devices screen (OWNER/ADMIN): devices, their commands and addresses, the live punch feed
// and its review, unknown IDs and alerts. Module ATTENDANCE.

export const DEVICE_BRANDS = ['ZKTECO'] as const;
export type DeviceBrand = (typeof DEVICE_BRANDS)[number];

export const DEVICE_COMMAND_KINDS = ['USER_UPSERT', 'USER_DELETE'] as const;
export type DeviceCommandKind = (typeof DEVICE_COMMAND_KINDS)[number];

export const DEVICE_COMMAND_STATUSES = ['PENDING', 'SENT', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

/** A device clock this far off (either way) is shown as a warning. */
export const DEVICE_CLOCK_WARNING_SEC = 120;

// ─────────────────────────── Requests ───────────────────────────

/** As typed: spaces around it ignored, letters upper-cased (the device shows it that way). */
export const deviceSerialSchema = z
  .string()
  .transform((v) => toAsciiDigits(v).trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{6,32}$/, 'Serial number: 6 to 32 letters and digits'));

const deviceNameSchema = z.string().trim().min(1).max(60);
/** Empty = no gate. */
const gateSchema = z
  .string()
  .trim()
  .max(60)
  .nullable()
  .transform((v) => v || null);

/** POST /attendance/devices */
export const createDeviceSchema = z.object({
  brand: z.enum(DEVICE_BRANDS).default('ZKTECO'),
  serialNo: deviceSerialSchema,
  name: deviceNameSchema,
  gate: gateSchema.optional().transform((v) => v ?? null),
  direction: z.enum(DEVICE_DIRECTIONS),
});
export type CreateDeviceInput = z.input<typeof createDeviceSchema>;
/** A device to add, as validated. */
export type NewDevice = z.output<typeof createDeviceSchema>;

/** PATCH /attendance/devices/:id: only what is sent changes. */
export const updateDeviceSchema = z.object({
  name: deviceNameSchema.optional(),
  gate: gateSchema.optional(),
  direction: z.enum(DEVICE_DIRECTIONS).optional(),
  isActive: z.boolean().optional(),
  serialNo: deviceSerialSchema.optional(),
});
export type UpdateDeviceInput = z.input<typeof updateDeviceSchema>;
/** The changes, as validated (absent = unchanged). */
export type DeviceChanges = z.output<typeof updateDeviceSchema>;

/** GET /attendance/devices/:id/commands */
export const deviceCommandsQuerySchema = z.object({
  status: z.enum(DEVICE_COMMAND_STATUSES).optional(),
});

/** An opaque feed position; clients pass back `PunchFeed.cursor`. */
export const PUNCH_CURSOR_RE =
  /^\d{1,15}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** GET /attendance/devices/punches */
export const punchFeedQuerySchema = z.object({
  /** Only punches received after this position (the live feed's poll). */
  after: z.string().regex(PUNCH_CURSOR_RE, 'Not a feed cursor').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only flagged punches (NEW_IP, OUTSIDE_HOURS, BURST) nobody has reviewed. */
  flagged: z.stringbool().optional(),
  deviceId: z.uuid().optional(),
});
export type PunchFeedQuery = z.input<typeof punchFeedQuerySchema>;

export const PUNCH_REVIEW_ACTIONS = ['OK', 'ACCEPT', 'REJECT'] as const;
export type PunchReviewAction = (typeof PUNCH_REVIEW_ACTIONS)[number];

/** POST /attendance/devices/punches/:id/review */
export const reviewPunchSchema = z.object({ action: z.enum(PUNCH_REVIEW_ACTIONS) });

// ─────────────────────────── Responses ───────────────────────────

export interface DeviceView {
  id: string;
  brand: DeviceBrand;
  serialNo: string;
  name: string;
  gate: string | null;
  direction: DeviceDirection;
  isActive: boolean;
  state: DeviceState;
  lastSeenAt: string | null;
  lastPunchAt: string | null;
  lastIp: string | null;
  firmware: string | null;
  userCount: number | null;
  pushVersion: string | null;
  /** The device clock minus ours, in seconds; null until measured. */
  clockOffsetSec: number | null;
  /** The clock is off by DEVICE_CLOCK_WARNING_SEC or more. */
  clockWarning: boolean;
  /** Commands not answered yet (waiting, or sent and not confirmed). */
  pendingCommands: number;
  failedCommands: number;
  lastFloodAt: string | null;
  lastFloodDropped: number | null;
  /** Addresses the device called from that nobody has trusted. */
  untrustedAddresses: number;
  createdAt: string;
}

/** GET /attendance/devices: the devices and what the setup guide tells a device. */
export interface DeviceList {
  devices: DeviceView[];
  setup: { host: string; port: number };
}

export interface DeviceCommandView {
  /** The command's number on the wire (a 64-bit integer, as text). */
  seq: string;
  kind: DeviceCommandKind;
  deviceUserId: string;
  status: DeviceCommandStatus;
  attempts: number;
  sentAt: string | null;
  doneAt: string | null;
  returnCode: number | null;
}

/** POST /attendance/devices/:id/sync */
export interface DeviceSyncResult {
  queued: number;
  /** Already waiting on the device with the same name. */
  skipped: number;
}

/** Who a punch's device ID belongs to, resolved when it is read. Names never from `users`. */
export type PunchPerson =
  | {
      kind: 'STUDENT';
      id: string;
      nameBn: string | null;
      nameEn: string | null;
      studentCode: string;
      /** Class and section in the current academic year; null when not enrolled. */
      classLevel: { id: string; nameBn: string; nameEn: string } | null;
      section: { id: string; name: string } | null;
    }
  | { kind: 'STAFF'; userId: string; name: string; nameBn: string | null };

export interface FeedPunch {
  id: string;
  device: { id: string; name: string; gate: string | null };
  deviceUserId: string;
  punchedAt: string;
  receivedAt: string;
  localDate: IsoDate;
  direction: PunchDirection;
  verifyKind: VerifyKind;
  flags: PunchFlag[];
  review: PunchReview | null;
  outcome: PunchOutcome | null;
  /** Null when the ID belongs to nobody. */
  person: PunchPerson | null;
  /** A student's IN punch: on time or late against the section's start. */
  arrival: 'PRESENT' | 'LATE' | null;
}

/** GET /attendance/devices/punches, newest first. */
export interface PunchFeed {
  punches: FeedPunch[];
  /** Pass as `after` to get only newer punches; the request's own when nothing is newer. */
  cursor: string | null;
}

export interface DeviceAddress {
  id: string;
  ip: string;
  firstSeenAt: string;
  lastSeenAt: string;
  punchCount: number;
  trusted: boolean;
  trustedAt: string | null;
  /** Who trusted it; 'automatic' for the device's first address; null when not trusted. */
  trustedBy: PersonRef | 'automatic' | null;
}

/** POST /attendance/devices/:id/ips/:ipId/trust */
export interface TrustAddressResult {
  address: DeviceAddress;
  /** Its NEW_IP punches nobody had reviewed, now marked OK. */
  reviewedPunches: number;
}

/** GET /attendance/devices/unknown-ids: IDs that punched lately but belong to nobody. */
export interface UnknownDeviceId {
  deviceUserId: string;
  lastPunchAt: string;
  count: number;
  lastDeviceName: string;
}

interface AlertDevice {
  deviceId: string;
  deviceName: string;
}

/** GET /attendance/devices/alerts (active devices only). */
export type DeviceAlert =
  | (AlertDevice & {
      kind: 'OFFLINE';
      state: 'OFFLINE' | 'NEVER_CONNECTED';
      /** Last seen, or registered when it never connected. */
      since: string;
    })
  | (AlertDevice & {
      kind: 'NEW_IP';
      ipId: string;
      ip: string;
      punchCount: number;
      lastSeenAt: string;
    })
  | (AlertDevice & { kind: 'FLOOD'; at: string; dropped: number })
  | (AlertDevice & { kind: 'HELD'; count: number })
  | (AlertDevice & { kind: 'CLOCK'; minutes: number; ahead: boolean });

/** Error codes in 4xx bodies (`{ statusCode, code, message }`). */
export type DevicesErrorCode =
  /** 409: the serial number is active somewhere (the message never says where). */
  | 'SERIAL_TAKEN'
  /** 409: a device that has connected keeps its serial number. */
  | 'SERIAL_LOCKED'
  | 'DEVICE_INACTIVE'
  /** 422: only a held (BURST) punch can be accepted. */
  | 'NOT_HELD';
