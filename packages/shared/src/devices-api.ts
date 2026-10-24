import { z } from 'zod';
import type { PersonRef } from './attendance.js';
import type { IsoDate } from './dates.js';
import type {
  DefaultIdConflictReason,
  DeviceImportError,
  DeviceImportStatus,
} from './device-people.js';
import {
  DEVICE_DIRECTIONS,
  deviceUserIdSchema,
  type DeviceDirection,
  type DeviceState,
  type PunchDirection,
  type PunchFlag,
  type PunchOutcome,
  type PunchReview,
  type VerifyKind,
} from './devices.js';
import { toAsciiDigits } from './digits.js';
import type { StaffRole } from './staff.js';

// The devices screen (OWNER/ADMIN): devices, their commands and addresses, the live punch feed
// and its review, unknown IDs and alerts; and the people screen: who has which device ID.
// Module ATTENDANCE.

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

// ─────────────────────────── People and device IDs ───────────────────────────

export const DEVICE_PERSON_KINDS = ['STUDENT', 'STAFF'] as const;
export type DevicePersonKind = (typeof DEVICE_PERSON_KINDS)[number];

/** GET /attendance/device-people */
export const devicePeopleQuerySchema = z.object({
  kind: z.enum(DEVICE_PERSON_KINDS).optional(),
  /** Only people without an ID. */
  unmapped: z.stringbool().optional(),
  /** Only this section's students. */
  sectionId: z.uuid().optional(),
});
export type DevicePeopleQuery = z.input<typeof devicePeopleQuerySchema>;

/** PUT /attendance/device-people: one student or one staff member; null clears their ID. */
export const setDeviceUserIdSchema = z
  .object({
    studentId: z.uuid().optional(),
    staffUserId: z.uuid().optional(),
    deviceUserId: deviceUserIdSchema.nullable(),
  })
  .refine((v) => (v.studentId === undefined) !== (v.staffUserId === undefined), {
    message: 'Exactly one of studentId and staffUserId',
    path: ['studentId'],
  });
export type SetDeviceUserIdInput = z.input<typeof setDeviceUserIdSchema>;

/** POST /attendance/device-people/defaults: a dry run first, then the same with false. */
export const deviceDefaultsSchema = z.object({
  kind: z.enum([...DEVICE_PERSON_KINDS, 'ALL']),
  dryRun: z.boolean(),
});
export type DeviceDefaultsInput = z.input<typeof deviceDefaultsSchema>;

/** GET /attendance/device-people/csv: names, classes and roles in this language. */
export const devicePeopleCsvQuerySchema = z.object({ locale: z.enum(['bn', 'en']).default('bn') });

/** POST /attendance/device-people/import?apply=0|1: 0 previews, 1 writes the OK rows. */
export const deviceImportQuerySchema = z.object({
  apply: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

export const DEVICE_IMPORT_MAX_BYTES = 1024 * 1024;
export const DEVICE_IMPORT_MAX_ROWS = 5000;
/** The CSV's columns: the header row in both languages (the import reads the first three). */
export const DEVICE_PEOPLE_CSV_COLUMNS = [
  'student_code',
  'staff_phone',
  'device_id',
  'name',
  'class',
  'section',
  'role',
  'status',
] as const;

/** POST /attendance/device-people/remove-from-devices */
export const removeFromDevicesSchema = z.object({
  deviceUserIds: z
    .array(deviceUserIdSchema)
    .min(1)
    .max(500)
    .transform((ids) => [...new Set(ids)]),
});

/** The numbers a staff start covers in the settings warning: start to start + 999. */
export const STAFF_RANGE_SIZE = 1000;

/** GET /attendance/device-people/staff-range-check?start= (Bangla digits accepted). */
export const staffRangeCheckQuerySchema = z.object({
  start: z
    .string()
    .transform((v) => toAsciiDigits(v).trim())
    .pipe(z.string().regex(/^\d{1,10}$/, 'A whole number'))
    .transform(Number)
    .pipe(z.number().int().min(100).max(999_999_999)),
});

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

/** Who holds, wants or asks for a device ID. Names from students and staff_profiles only. */
export interface DevicePersonRef {
  kind: DevicePersonKind;
  /** The student's id, or the staff member's user id. */
  id: string;
  /** Students: the English name (the Bangla one when there is none); staff: the profile name. */
  name: string;
  nameBn: string | null;
  /** Students only. */
  studentCode?: string;
}

export const DEVICE_SYNC_STATES = ['NONE', 'PENDING', 'FAILED', 'DONE'] as const;
/**
 * The person's ID across the active devices: NONE (not sent to every one of them), PENDING (an
 * add is waiting or sent), FAILED (a device's latest add failed), DONE (every device's latest
 * add succeeded).
 */
export type DeviceSyncState = (typeof DEVICE_SYNC_STATES)[number];

interface DevicePersonIds {
  deviceUserId: string | null;
  /** The ID "assign default IDs" would give now; null when they have one or for a conflict. */
  suggested: string | null;
  sync: DeviceSyncState;
}

/**
 * GET /attendance/device-people: active students enrolled this year (by class, section, roll),
 * then staff with an active staff role and a profile (in the order they were added).
 */
export type DevicePersonRow =
  | (DevicePersonIds & {
      kind: 'STUDENT';
      id: string;
      nameBn: string | null;
      nameEn: string | null;
      studentCode: string;
      classLevel: { id: string; nameBn: string; nameEn: string };
      section: { id: string; name: string } | null;
    })
  | (DevicePersonIds & {
      kind: 'STAFF';
      /** The user id. */
      id: string;
      name: string;
      nameBn: string | null;
      /** The active staff roles. */
      roles: StaffRole[];
    });

export interface DevicePeopleList {
  people: DevicePersonRow[];
  /** Everyone, whatever the filters. */
  counts: { students: number; studentsUnmapped: number; staff: number; staffUnmapped: number };
}

/** PUT /attendance/device-people */
export interface SetDeviceIdResult {
  deviceUserId: string | null;
  /** The ID before (null when there was none). */
  previous: string | null;
  /** The ID changed from another one: fingerprints stay under the old ID on the device. */
  reenrol: boolean;
  /** USER_UPSERT commands queued (one per active device). */
  queued: number;
}

/** GET /attendance/device-people/collisions */
export interface DeviceIdCollisionView {
  deviceUserId: string;
  /** People without an ID whose default it is (a student code's digits). */
  wantedBy: DevicePersonRef[];
  heldBy: DevicePersonRef | null;
}

/** POST /attendance/device-people/defaults (people without an ID only). */
export interface DeviceDefaultsResult {
  assigned: { person: DevicePersonRef; deviceUserId: string }[];
  conflicts: {
    person: DevicePersonRef;
    deviceUserId: string | null;
    reason: DefaultIdConflictReason;
    /** TAKEN: who holds it; ID_STILL_ON_DEVICE: who a device still has under it. */
    heldBy: DevicePersonRef | null;
  }[];
  /** USER_UPSERT commands queued (0 for a dry run). */
  queued: number;
}

export interface DeviceImportRow {
  /** The row number in the file (the header is row 1). */
  row: number;
  person: DevicePersonRef | null;
  /** Their ID now. */
  previous: string | null;
  /** The ID the row asks for; null clears (or the cell is not a valid ID). */
  deviceUserId: string | null;
  status: DeviceImportStatus;
  error?: DeviceImportError;
}

/** POST /attendance/device-people/import */
export interface DeviceImportResult {
  /** False for a preview. */
  applied: boolean;
  rows: DeviceImportRow[];
  counts: { ok: number; unchanged: number; error: number };
  /** USER_UPSERT commands queued (0 for a preview). */
  queued: number;
}

/**
 * GET /attendance/device-people/stale: someone an active device still has under an ID they should
 * no longer use there. INACTIVE: they hold the ID but are no longer active here. RELEASED: the ID
 * was changed, cleared or removed from them; it goes to nobody else until every device that has
 * them confirms removing it (their finger would punch as the new holder).
 */
export interface StaleDevicePerson {
  person: DevicePersonRef;
  deviceUserId: string;
  reason: 'INACTIVE' | 'RELEASED';
  /** The active devices that have them under this ID. */
  devices: { id: string; name: string }[];
  /** A removal is queued and not confirmed yet. */
  removing: boolean;
  /** When a device last confirmed adding them. */
  lastSyncAt: string;
}

/** POST /attendance/device-people/remove-from-devices */
export interface RemoveFromDevicesResult {
  /** IDs whose mapping was deleted (now free). */
  freed: string[];
  /** USER_DELETE commands queued (one per ID and active device). */
  queued: number;
}

/** GET /attendance/device-people/staff-range-check */
export interface StaffRangeCheck {
  start: number;
  /** Current students whose code gives a number from start to start + 999. */
  studentDefaultsInRange: number;
}

/** Error codes in 4xx bodies (`{ statusCode, code, message }`). */
export type DevicesErrorCode =
  /** 409: the serial number is active somewhere (the message never says where). */
  | 'SERIAL_TAKEN'
  /** 409: a device that has connected keeps its serial number. */
  | 'SERIAL_LOCKED'
  | 'DEVICE_INACTIVE'
  /** 422: only a held (BURST) punch can be accepted. */
  | 'NOT_HELD'
  /** 409: someone else here has this device ID (`holder: DevicePersonRef | null`). */
  | 'DEVICE_ID_TAKEN'
  /**
   * 409: a device still has someone else under this ID (`previous: DevicePersonRef`); remove it
   * from the devices first.
   */
  | 'ID_STILL_ON_DEVICE'
  /** 422: the user has no active staff role (or no staff profile) here. */
  | 'NOT_STAFF'
  /** 409: these IDs belong to active people (`people: { deviceUserId, person }[]`). */
  | 'PERSON_ACTIVE'
  /** 422: the uploaded CSV of device IDs (more than 1 MB is a plain 413). */
  | 'FILE_MISSING'
  | 'FILE_TYPE'
  | 'FILE_INVALID'
  | 'FILE_EMPTY'
  | 'MISSING_COLUMNS'
  | 'NO_DATA_ROWS'
  | 'TOO_MANY_ROWS';
