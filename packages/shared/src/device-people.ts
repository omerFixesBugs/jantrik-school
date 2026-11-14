import { defaultStudentDeviceId, nextStaffDeviceId } from './devices.js';
import { deviceUserIdSchema } from './devices-schema.js';
import { toAsciiDigits } from './digits.js';
import { parseImportPhone } from './import.js';

/**
 * People ↔ device IDs: which ID "assign default IDs" gives each person, and what a CSV of IDs
 * would change. Pure rules; the API loads the people and holds the lock. Person keys are opaque.
 *
 * An ID still on a device (`onDevice`: ID → the person a device has under it) keeps their
 * fingerprints there, so it goes to nobody else until the devices confirm removing it: their
 * finger would punch as the new holder. Giving it back to that same person is fine.
 */

// ---------------------------------------------------------------------------------------------
// Default IDs

export const DEFAULT_ID_CONFLICT_REASONS = [
  'NO_DEFAULT',
  'TAKEN',
  'SHARED',
  'ID_STILL_ON_DEVICE',
] as const;
/**
 * NO_DEFAULT: the student code has no usable digits (or no staff number is left); TAKEN: someone
 * holds the number; SHARED: another unmapped student's code gives the same number;
 * ID_STILL_ON_DEVICE: a device still has someone else under the number.
 */
export type DefaultIdConflictReason = (typeof DEFAULT_ID_CONFLICT_REASONS)[number];

export interface DefaultIds {
  assigned: { key: string; deviceUserId: string }[];
  conflicts: { key: string; deviceUserId: string | null; reason: DefaultIdConflictReason }[];
}

/**
 * The ID each person without one would get now. Students: the digits of their code when that is
 * a valid ID, nobody holds it and no other unmapped student's code gives it (otherwise none of
 * them gets it), nor a device has someone else under it. Staff, in the order given: the next free
 * number from `staffStart`, never one a listed student's code gives, mapped or not, nor one still
 * on a device. `held` is every ID in use, also by people not listed.
 */
export function defaultDeviceIds(input: {
  /** The current year's students. */
  students: { key: string; code: string; current: string | null }[];
  /** Staff in the order they get numbers. */
  staff: { key: string; current: string | null }[];
  held: ReadonlySet<string>;
  /** ID → the person a device still has under it. */
  onDevice: ReadonlyMap<string, string>;
  staffStart: number;
}): DefaultIds {
  const out: DefaultIds = { assigned: [], conflicts: [] };
  const students = input.students.map((s) => ({ ...s, wanted: defaultStudentDeviceId(s.code) }));
  const unmapped = students.filter((s) => s.current === null);
  const wantedBy = new Map<string, number>();
  for (const s of unmapped) {
    if (s.wanted !== null) wantedBy.set(s.wanted, (wantedBy.get(s.wanted) ?? 0) + 1);
  }
  for (const { key, wanted } of unmapped) {
    if (wanted === null) out.conflicts.push({ key, deviceUserId: null, reason: 'NO_DEFAULT' });
    else if (input.held.has(wanted))
      out.conflicts.push({ key, deviceUserId: wanted, reason: 'TAKEN' });
    else if (wantedBy.get(wanted)! > 1)
      out.conflicts.push({ key, deviceUserId: wanted, reason: 'SHARED' });
    else if ((input.onDevice.get(wanted) ?? key) !== key)
      out.conflicts.push({ key, deviceUserId: wanted, reason: 'ID_STILL_ON_DEVICE' });
    else out.assigned.push({ key, deviceUserId: wanted });
  }

  const reserved = new Set(students.flatMap((s) => (s.wanted === null ? [] : [s.wanted])));
  const used = new Set([...input.held, ...input.onDevice.keys()]);
  // Every number below the last one given is used or reserved, so the search goes on from there.
  let from = input.staffStart;
  for (const { key, current } of input.staff) {
    if (current !== null) continue;
    const id = nextStaffDeviceId(from, used, reserved);
    if (id === null) {
      out.conflicts.push({ key, deviceUserId: null, reason: 'NO_DEFAULT' });
      continue;
    }
    used.add(id);
    from = Number(id) + 1;
    out.assigned.push({ key, deviceUserId: id });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CSV import

export const DEVICE_IMPORT_ERRORS = [
  'NO_PERSON_KEY',
  'BOTH_KEYS',
  'UNKNOWN_STUDENT',
  'UNKNOWN_STAFF',
  'BAD_DEVICE_ID',
  'DUPLICATE_PERSON',
  'DUPLICATE_ID',
  'TAKEN',
  'ID_STILL_ON_DEVICE',
] as const;
export type DeviceImportError = (typeof DEVICE_IMPORT_ERRORS)[number];

export type DeviceImportStatus = 'OK' | 'UNCHANGED' | 'ERROR';

/** One data row of the file, cells as text ('' when the column is missing). */
export interface DeviceImportLine {
  /** The row number in the file (the header is row 1). */
  row: number;
  studentCode: string;
  staffPhone: string;
  deviceId: string;
}

export interface DeviceImportLookup {
  /** Student code (`importStudentCode`) → person key. */
  students: ReadonlyMap<string, string>;
  /** E.164 phone → person key. */
  staff: ReadonlyMap<string, string>;
  /** Person key → their ID now. */
  current: ReadonlyMap<string, string>;
  /** ID → whoever holds it, also people the file cannot name. */
  holders: ReadonlyMap<string, string>;
  /** ID → the person a device still has under it. */
  onDevice: ReadonlyMap<string, string>;
}

export interface DeviceImportCheck {
  row: number;
  /** The person, when the row names one the institute has. */
  key: string | null;
  /** The ID asked for, when valid; null also means "clear". */
  deviceUserId: string | null;
  status: DeviceImportStatus;
  error?: DeviceImportError;
}

/** A student code as typed: trimmed, upper case, ASCII digits. */
export const importStudentCode = (code: string): string => toAsciiDigits(code).trim().toUpperCase();

/**
 * What each row would do. Per row, the first of: NO_PERSON_KEY / BOTH_KEYS, UNKNOWN_STUDENT /
 * UNKNOWN_STAFF, BAD_DEVICE_ID. Across rows: DUPLICATE_PERSON (the same person twice) and
 * DUPLICATE_ID (one ID on two rows) mark every such row. A row asking for the ID the person has
 * is UNCHANGED. A row asking for an ID held by someone this file does not move away (no OK row
 * of theirs) is TAKEN, which can stop the person they waited on in turn. A row asking for an ID
 * a device still has under someone else is ID_STILL_ON_DEVICE, even when the file moves its
 * holder away. Other swaps are fine: the apply removes every changing person's ID before giving
 * the new ones.
 */
export function checkDeviceImport(
  lines: DeviceImportLine[],
  lookup: DeviceImportLookup,
): DeviceImportCheck[] {
  const out = lines.map((l): DeviceImportCheck => {
    const raw = toAsciiDigits(l.deviceId).trim();
    const id = deviceUserIdSchema.safeParse(raw);
    const deviceUserId = id.success ? id.data : null;
    const fail = (error: DeviceImportError, key: string | null = null): DeviceImportCheck => ({
      row: l.row,
      key,
      deviceUserId,
      status: 'ERROR',
      error,
    });
    const code = l.studentCode.trim();
    const phone = l.staffPhone.trim();
    if (!code && !phone) return fail('NO_PERSON_KEY');
    if (code && phone) return fail('BOTH_KEYS');
    let key: string | undefined;
    if (code) {
      key = lookup.students.get(importStudentCode(code));
      if (key === undefined) return fail('UNKNOWN_STUDENT');
    } else {
      const e164 = parseImportPhone(phone);
      key = e164 === null ? undefined : lookup.staff.get(e164);
      if (key === undefined) return fail('UNKNOWN_STAFF');
    }
    if (raw !== '' && !id.success) return fail('BAD_DEVICE_ID', key);
    return { row: l.row, key, deviceUserId, status: 'OK' };
  });

  const valid = out.filter((r) => r.status === 'OK');
  const count = (values: (string | null)[]) => {
    const n = new Map<string, number>();
    for (const v of values) if (v !== null) n.set(v, (n.get(v) ?? 0) + 1);
    return n;
  };
  const perPerson = count(valid.map((r) => r.key));
  const perId = count(valid.map((r) => r.deviceUserId));
  for (const r of valid) {
    if (perPerson.get(r.key!)! > 1)
      Object.assign(r, { status: 'ERROR', error: 'DUPLICATE_PERSON' });
    else if (r.deviceUserId !== null && perId.get(r.deviceUserId)! > 1)
      Object.assign(r, { status: 'ERROR', error: 'DUPLICATE_ID' });
    else if (r.deviceUserId === (lookup.current.get(r.key!) ?? null)) r.status = 'UNCHANGED';
  }

  // People whose ID this file changes; a row waiting on someone who stays is TAKEN, until stable.
  const moving = new Set(out.filter((r) => r.status === 'OK').map((r) => r.key!));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of out) {
      if (r.status !== 'OK' || r.deviceUserId === null) continue;
      const holder = lookup.holders.get(r.deviceUserId);
      let error: DeviceImportError;
      if (holder !== undefined && holder !== r.key && !moving.has(holder)) error = 'TAKEN';
      else if ((lookup.onDevice.get(r.deviceUserId) ?? r.key) !== r.key)
        error = 'ID_STILL_ON_DEVICE';
      else continue;
      Object.assign(r, { status: 'ERROR', error });
      moving.delete(r.key!);
      changed = true;
    }
  }
  return out;
}
