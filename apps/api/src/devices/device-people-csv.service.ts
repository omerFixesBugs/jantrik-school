import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  DEVICE_IMPORT_MAX_ROWS,
  DEVICE_PEOPLE_CSV_COLUMNS,
  checkDeviceImport,
  importStudentCode,
  toCsv,
  type DeviceImportLine,
  type DeviceImportLookup,
  type DeviceImportResult,
  type DevicePersonRef,
  type StaffRole,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Db } from '../tenancy/db.service.js';
import {
  DEVICE_PEOPLE_BATCH,
  DevicePeopleRoster,
  HOLDER_SELECT,
  holderKey,
  personColumns,
  personKey,
  staffPersonRef,
  studentRef,
} from './device-people-roster.js';

const ROLE_LABELS: Record<'bn' | 'en', Record<StaffRole, string>> = {
  bn: {
    OWNER: 'প্রতিষ্ঠান প্রধান',
    ADMIN: 'প্রশাসক',
    TEACHER: 'শিক্ষক',
    ACCOUNTANT: 'হিসাবরক্ষক',
    STAFF: 'কর্মী',
  },
  en: {
    OWNER: 'Owner',
    ADMIN: 'Admin',
    TEACHER: 'Teacher',
    ACCOUNTANT: 'Accountant',
    STAFF: 'Staff',
  },
};

/** "+8801711000001" → "01711000001" (what people type; the import reads it back). */
const localPhone = (e164: string) => e164.replace(/^\+88/, '');

/**
 * The people ↔ device IDs CSV: everyone with their ID (or the default they would get), and the
 * upload that sets IDs from such a file (preview, then apply).
 */
@Injectable()
export class DevicePeopleCsvService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly roster: DevicePeopleRoster,
  ) {}

  /**
   * Students, then staff. The header is the import format in both languages; names, classes and
   * roles follow `locale`. IDs, codes and phones are ASCII.
   */
  async exportCsv(locale: 'bn' | 'en'): Promise<{ filename: string; csv: string }> {
    const r = await this.roster.load();
    const bn = locale === 'bn';
    const id = (p: { key: string; deviceUserId: string | null }) =>
      p.deviceUserId ?? r.suggested.get(p.key) ?? '';
    const status = (p: { deviceUserId: string | null }) =>
      p.deviceUserId ? 'current' : 'suggested';
    const rows: string[][] = [[...DEVICE_PEOPLE_CSV_COLUMNS]];
    for (const s of r.students) {
      rows.push([
        s.studentCode,
        '',
        id(s),
        (bn ? (s.nameBn ?? s.nameEn) : (s.nameEn ?? s.nameBn)) ?? '',
        bn ? s.classLevel.nameBn : s.classLevel.nameEn,
        s.section?.name ?? '',
        '',
        status(s),
      ]);
    }
    for (const s of r.staff) {
      rows.push([
        '',
        localPhone(s.phone),
        id(s),
        bn ? (s.nameBn ?? s.name) : s.name,
        '',
        '',
        s.roles.map((role) => ROLE_LABELS[locale][role]).join('; '),
        status(s),
      ]);
    }
    return { filename: 'device-people.csv', csv: toCsv(rows) };
  }

  /**
   * A CSV of `student_code` or `staff_phone` with `device_id` per row. The preview writes
   * nothing. The apply checks the file again against the database as it is now, under the lock,
   * and writes only the OK rows: every changing person's ID is removed first, then the new ones
   * are given (so a swap works), audited as one batch, then sent to the active devices. An ID a
   * device still has someone else under is refused (ID_STILL_ON_DEVICE), also in a swap.
   */
  async importCsv(
    file: { buffer: Buffer; originalname: string } | undefined,
    apply: boolean,
  ): Promise<DeviceImportResult> {
    if (!file) throw apiError(422, 'FILE_MISSING', 'Choose a file');
    const lines = readCsv(file.buffer, file.originalname);
    if (apply) await this.roster.lock();
    const { lookup, refs } = await this.lookup();
    const checks = checkDeviceImport(lines, lookup);
    const counts = { ok: 0, unchanged: 0, error: 0 };
    for (const c of checks) {
      if (c.status === 'OK') counts.ok += 1;
      else if (c.status === 'UNCHANGED') counts.unchanged += 1;
      else counts.error += 1;
    }
    const result: DeviceImportResult = {
      applied: apply,
      rows: checks.map((c) => ({
        row: c.row,
        person: c.key === null ? null : refs.get(c.key)!,
        previous: c.key === null ? null : (lookup.current.get(c.key) ?? null),
        deviceUserId: c.deviceUserId,
        status: c.status,
        ...(c.error ? { error: c.error } : {}),
      })),
      counts,
      queued: 0,
    };
    const ok = checks.filter((c) => c.status === 'OK');
    if (!apply || ok.length === 0) return result;

    const tx = this.db.tx;
    const columns = ok.map((c) => personColumns(c.key!));
    const studentIds = columns.flatMap((c) => ('studentId' in c ? [c.studentId] : []));
    const staffUserIds = columns.flatMap((c) => ('staffUserId' in c ? [c.staffUserId] : []));
    await tx.devicePerson.deleteMany({
      where: { OR: [{ studentId: { in: studentIds } }, { staffUserId: { in: staffUserIds } }] },
    });
    const given = ok.flatMap((c) =>
      c.deviceUserId === null ? [] : [{ key: c.key!, deviceUserId: c.deviceUserId }],
    );
    await this.roster.insert(given);
    await this.audit.record({
      entity: DEVICE_PEOPLE_BATCH,
      entityId: randomUUID(),
      action: 'UPDATE',
      newValues: {
        source: 'IMPORT',
        changes: ok.map((c) => ({
          ...personColumns(c.key!),
          from: lookup.current.get(c.key!) ?? null,
          to: c.deviceUserId,
        })),
      },
    });
    result.queued = await this.roster.queueUpserts(given.map((g) => g.deviceUserId));
    return result;
  }

  /**
   * Who a file can name: students not deleted (by code, any case) and staff with an active staff
   * role and a profile (by phone), as PUT allows. A code or phone two people share names nobody.
   */
  private async lookup(): Promise<{
    lookup: DeviceImportLookup;
    refs: Map<string, DevicePersonRef>;
  }> {
    const tx = this.db.tx;
    const refs = new Map<string, DevicePersonRef>();
    const students = new Map<string, string | null>();
    for (const s of await tx.student.findMany({
      where: { deletedAt: null },
      select: { id: true, nameBn: true, nameEn: true, studentCode: true },
    })) {
      const key = personKey('STUDENT', s.id);
      refs.set(key, studentRef(s));
      const code = importStudentCode(s.studentCode);
      students.set(code, students.has(code) ? null : key);
    }
    const roles = await this.roster.activeStaffRoles();
    const staff = new Map<string, string | null>();
    for (const p of await tx.staffProfile.findMany({
      where: { userId: { in: [...roles.keys()] } },
      select: { userId: true, name: true, nameBn: true, phone: true },
    })) {
      const key = personKey('STAFF', p.userId);
      refs.set(key, staffPersonRef(p.userId, p));
      staff.set(p.phone, staff.has(p.phone) ? null : key);
    }
    const rows = await tx.devicePerson.findMany({ select: HOLDER_SELECT });
    const named = (m: Map<string, string | null>) =>
      new Map([...m].flatMap(([k, v]) => (v === null ? [] : [[k, v] as const])));
    return {
      lookup: {
        students: named(students),
        staff: named(staff),
        current: new Map(rows.map((r) => [holderKey(r), r.deviceUserId])),
        holders: new Map(rows.map((r) => [r.deviceUserId, holderKey(r)])),
        onDevice: new Map([...(await this.roster.onDevice())].map(([id, o]) => [id, o.key])),
      },
      refs,
    };
  }
}

const IMPORT_COLUMNS = ['student_code', 'staff_phone', 'device_id'] as const;

/**
 * The uploaded file → its data rows. CSV only (the interceptor refuses more than 1 MB), a header
 * row naming the columns (any order and case; others ignored), at most 5000 data rows. Blank
 * rows are skipped but counted, so row numbers match the spreadsheet's.
 */
function readCsv(buffer: Buffer, fileName: string): DeviceImportLine[] {
  if (buffer.length === 0) throw apiError(422, 'FILE_EMPTY', 'The file is empty');
  const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!fileName.toLowerCase().endsWith('.csv') || isZip) {
    throw apiError(422, 'FILE_TYPE', 'Upload a .csv file');
  }
  let grid: string[][];
  try {
    grid = parseCsv(buffer.toString('utf8'), { bom: true, relax_column_count: true }) as string[][];
  } catch {
    throw apiError(422, 'FILE_INVALID', 'Could not read the CSV file');
  }
  const blank = (r: string[]) => r.every((c) => c.trim() === '');
  const at = grid.findIndex((r) => !blank(r));
  if (at < 0) throw apiError(422, 'FILE_EMPTY', 'No rows in the file');
  const header = grid[at]!.map((h) => h.trim().toLowerCase());
  const [code, phone, id] = IMPORT_COLUMNS.map((c) => header.indexOf(c)) as [
    number,
    number,
    number,
  ];
  if (id < 0 || (code < 0 && phone < 0)) {
    throw apiError(
      422,
      'MISSING_COLUMNS',
      'The header needs device_id and student_code or staff_phone',
      {
        missing: IMPORT_COLUMNS.filter((c) => !header.includes(c)),
      },
    );
  }
  const cell = (r: string[], i: number) => (i < 0 ? '' : (r[i] ?? ''));
  const lines: DeviceImportLine[] = [];
  for (let i = at + 1; i < grid.length; i += 1) {
    const r = grid[i]!;
    if (blank(r)) continue;
    lines.push({
      row: i + 1,
      studentCode: cell(r, code),
      staffPhone: cell(r, phone),
      deviceId: cell(r, id),
    });
  }
  if (lines.length === 0) throw apiError(422, 'NO_DATA_ROWS', 'Only a header row');
  if (lines.length > DEVICE_IMPORT_MAX_ROWS) {
    throw apiError(422, 'TOO_MANY_ROWS', `At most ${DEVICE_IMPORT_MAX_ROWS} rows`, {
      max: DEVICE_IMPORT_MAX_ROWS,
      rows: lines.length,
    });
  }
  return lines;
}
