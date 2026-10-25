import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  addDays,
  arrivalStatus,
  dateFromDb,
  localDateOf,
  localTimeOf,
  verifyKind,
  type FeedPunch,
  type PunchFeed,
  type PunchFlag,
  type PunchPerson,
  type PunchReview,
  type PunchReviewAction,
  type UnknownDeviceId,
} from '@jantrik/shared';
import {
  AttendanceSettingsService,
  timeFromDb,
  type AttendanceTenant,
} from '../attendance/attendance-settings.service.js';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { staffNames } from '../staff/staff.module.js';
import { Db } from '../tenancy/db.service.js';
import { DeviceAttendanceService } from './device-attendance.service.js';
import { REVIEW_WINDOW_MS } from './devices.constants.js';
import { PunchReviewEffects } from './punch-review-effects.js';

/** The flags an admin reviews (the others only explain how a time was read). */
const REVIEW_FLAGS: PunchFlag[] = ['NEW_IP', 'OUTSIDE_HOURS', 'BURST'];

const REVIEW_OF: Record<PunchReviewAction, PunchReview> = {
  OK: 'OK',
  ACCEPT: 'ACCEPTED',
  REJECT: 'REJECTED',
};

const UNKNOWN_IDS_DAYS = 30;
const UNKNOWN_IDS_SHOWN = 200;

const FEED_SELECT = {
  id: true,
  deviceUserId: true,
  punchedAt: true,
  receivedAt: true,
  localDate: true,
  direction: true,
  verifyType: true,
  flags: true,
  review: true,
  outcome: true,
  device: { select: { id: true, name: true, gate: true } },
} satisfies Prisma.DevicePunchSelect;
type FeedRow = Prisma.DevicePunchGetPayload<{ select: typeof FEED_SELECT }>;

/** A feed position: when the newest punch the client has was received, and its id. */
const cursorOf = (p: { receivedAt: Date; id: string }) => `${p.receivedAt.getTime()}_${p.id}`;
function parseCursor(cursor: string): { receivedAt: Date; id: string } {
  const [ms, id] = cursor.split('_') as [string, string];
  return { receivedAt: new Date(Number(ms)), id };
}

interface Owner {
  person: PunchPerson;
  /** The student's section shift start ("HH:MM"), when it has one. */
  shiftStart: string | null;
}

/**
 * The live punch feed, its review and the IDs that belong to nobody (OWNER/ADMIN). People are
 * resolved through device_people when read, with names from students and staff_profiles only.
 */
@Injectable()
export class DevicePunchesService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
    private readonly effects: PunchReviewEffects,
    private readonly deviceAttendance: DeviceAttendanceService,
  ) {}

  /**
   * Newest first. Punches of one upload share their received time, so the punch time and the id
   * order within it. `after` keeps only punches received after that position (the 5-second poll).
   * `flagged` looks back over the review window only (the received-time index bounds the scan).
   */
  async feed(query: {
    after?: string;
    limit: number;
    flagged?: boolean;
    deviceId?: string;
  }): Promise<PunchFeed> {
    const after = query.after ? parseCursor(query.after) : null;
    const reviewSince = new Date(this.clock.now().getTime() - REVIEW_WINDOW_MS);
    const rows = await this.db.tx.devicePunch.findMany({
      where: {
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        ...(query.flagged
          ? { review: null, flags: { hasSome: REVIEW_FLAGS }, receivedAt: { gte: reviewSince } }
          : {}),
        ...(after
          ? {
              OR: [
                { receivedAt: { gt: after.receivedAt } },
                { receivedAt: after.receivedAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ receivedAt: 'desc' }, { punchedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: FEED_SELECT,
    });
    const newest = rows.reduce<FeedRow | null>(
      (max, r) =>
        max === null ||
        r.receivedAt > max.receivedAt ||
        (r.receivedAt.getTime() === max.receivedAt.getTime() && r.id > max.id)
          ? r
          : max,
      null,
    );
    return {
      punches: await this.toFeed(rows, await this.settings.load()),
      cursor: newest ? cursorOf(newest) : (query.after ?? null),
    };
  }

  /**
   * OK (looks right), ACCEPT (a held BURST punch counts) or REJECT (it stops counting). Any punch
   * may be reviewed again; the last decision wins. Audited.
   */
  async review(id: string, action: PunchReviewAction): Promise<FeedPunch> {
    const tx = this.db.tx;
    // Lock order, as processing: the institute's punch lock, the punch row, then the person's day.
    await this.deviceAttendance.lockPunches();
    const [locked] = await tx.$queryRaw<{ flags: string[]; review: PunchReview | null }[]>`
      SELECT flags, review::text AS review FROM device_punches WHERE id = ${id}::uuid
      FOR NO KEY UPDATE`;
    if (!locked) throw new NotFoundException('Punch not found');
    if (action === 'ACCEPT' && !locked.flags.includes('BURST')) {
      throw apiError(422, 'NOT_HELD', 'Only a held punch can be accepted');
    }
    const review = REVIEW_OF[action];
    const row = await tx.devicePunch.update({
      where: { id },
      data: {
        review,
        reviewedById: this.context.requirePrincipal().userId,
        reviewedAt: this.clock.now(),
      },
      select: FEED_SELECT,
    });
    await this.audit.record({
      entity: 'device_punch',
      entityId: id,
      action: 'UPDATE',
      oldValues: { review: locked.review },
      newValues: { review },
    });
    await this.effects.afterReview({
      id,
      deviceUserId: row.deviceUserId,
      localDate: dateFromDb(row.localDate),
      flags: row.flags as PunchFlag[],
      review,
      previousReview: locked.review,
    });
    // The hook may have changed the outcome.
    const { outcome } = await tx.devicePunch.findUniqueOrThrow({
      where: { id },
      select: { outcome: true },
    });
    const [punch] = await this.toFeed([{ ...row, outcome }], await this.settings.load());
    return punch!;
  }

  /**
   * Device IDs that punched in the last 30 days (local dates) and belong to nobody. One pass over
   * those days: the device of each ID's latest punch is picked while grouping, and the device
   * names are joined once.
   */
  async unknownIds(): Promise<UnknownDeviceId[]> {
    const tx = this.db.tx;
    const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const from = addDays(localDateOf(this.clock.now(), timezone), -(UNKNOWN_IDS_DAYS - 1));
    const rows = await tx.$queryRaw<
      { device_user_id: string; count: number; last_punch_at: Date; last_device_name: string }[]
    >`
      WITH unknown AS (
        SELECT p.device_user_id, count(*)::int AS count, max(p.punched_at) AS last_punch_at,
               (array_agg(p.device_id ORDER BY p.punched_at DESC, p.id DESC))[1] AS last_device_id
        FROM device_punches p
        WHERE p.local_date >= ${from}::date
          AND NOT EXISTS (SELECT 1 FROM device_people dp
                          WHERE dp.tenant_id = p.tenant_id
                            AND dp.device_user_id = p.device_user_id)
        GROUP BY p.device_user_id
        ORDER BY last_punch_at DESC, p.device_user_id
        LIMIT ${UNKNOWN_IDS_SHOWN}
      )
      SELECT u.device_user_id, u.count, u.last_punch_at, d.name AS last_device_name
      FROM unknown u
      JOIN attendance_devices d ON d.id = u.last_device_id
      ORDER BY u.last_punch_at DESC, u.device_user_id`;
    return rows.map((r) => ({
      deviceUserId: r.device_user_id,
      lastPunchAt: r.last_punch_at.toISOString(),
      count: r.count,
      lastDeviceName: r.last_device_name,
    }));
  }

  private async toFeed(rows: FeedRow[], tenant: AttendanceTenant): Promise<FeedPunch[]> {
    const owners = await this.owners([...new Set(rows.map((r) => r.deviceUserId))]);
    const { deviceDefaultStart, deviceGraceMinutes } = tenant.settings;
    return rows.map((r) => {
      const owner = owners.get(r.deviceUserId) ?? null;
      const arrival =
        owner?.person.kind === 'STUDENT' && r.direction === 'IN'
          ? arrivalStatus(
              localTimeOf(r.punchedAt, tenant.timezone),
              owner.shiftStart ?? deviceDefaultStart,
              deviceGraceMinutes,
            )
          : null;
      return {
        id: r.id,
        device: r.device,
        deviceUserId: r.deviceUserId,
        punchedAt: r.punchedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        localDate: dateFromDb(r.localDate),
        direction: r.direction,
        verifyKind: verifyKind(r.verifyType),
        flags: r.flags as PunchFlag[],
        review: r.review,
        outcome: r.outcome,
        person: owner?.person ?? null,
        arrival,
      };
    });
  }

  /** Who each device ID belongs to now; students with this year's class and section. */
  private async owners(deviceUserIds: string[]): Promise<Map<string, Owner>> {
    const out = new Map<string, Owner>();
    if (deviceUserIds.length === 0) return out;
    const tx = this.db.tx;
    const rows = await tx.devicePerson.findMany({
      where: { deviceUserId: { in: deviceUserIds } },
      select: {
        deviceUserId: true,
        staffUserId: true,
        student: {
          select: {
            id: true,
            nameBn: true,
            nameEn: true,
            studentCode: true,
            enrolments: {
              where: { academicYear: { isCurrent: true } },
              select: {
                classLevel: { select: { id: true, nameBn: true, nameEn: true } },
                section: {
                  select: { id: true, name: true, shift: { select: { startTime: true } } },
                },
              },
              take: 1,
            },
          },
        },
      },
    });
    const names = await staffNames(
      tx,
      rows.flatMap((r) => (r.staffUserId ? [r.staffUserId] : [])),
    );
    for (const r of rows) {
      if (r.student) {
        const enrolment = r.student.enrolments[0];
        const section = enrolment?.section ?? null;
        out.set(r.deviceUserId, {
          person: {
            kind: 'STUDENT',
            id: r.student.id,
            nameBn: r.student.nameBn,
            nameEn: r.student.nameEn,
            studentCode: r.student.studentCode,
            classLevel: enrolment?.classLevel ?? null,
            section: section ? { id: section.id, name: section.name } : null,
          },
          shiftStart: section?.shift ? timeFromDb(section.shift.startTime) : null,
        });
      } else if (r.staffUserId) {
        const name = names.get(r.staffUserId);
        out.set(r.deviceUserId, {
          person: {
            kind: 'STAFF',
            userId: r.staffUserId,
            name: name?.name ?? '',
            nameBn: name?.nameBn ?? null,
          },
          shiftStart: null,
        });
      }
    }
    return out;
  }
}
