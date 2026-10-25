import { Injectable } from '@nestjs/common';
import { addDays } from '@jantrik/shared';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import { Clock } from '../common/clock.js';
import { Db } from '../tenancy/db.service.js';

/** Finished command rows are kept this long after their last change (they carry names). */
const COMMAND_RETENTION_DAYS = 90;

/**
 * What the daily `expire-punches` job deletes, one chunk per call, in one institute's job
 * transaction: raw punches past the institute's `punch_retention_days`, and command rows nothing
 * needs any more. Registers, records, staff days, SMS logs and the audit log are kept.
 */
@Injectable()
export class DeviceRetentionService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
  ) {}

  /**
   * Up to `limit` punches from before today − `punch_retention_days`, oldest first; how many were
   * deleted. The database never lets the app delete a punch from the last 30 days (policy
   * `retention_only`, by its own current_date, which can be a day behind the institute's today).
   * Oldest first, such a punch can only come at the end of a chunk, so a chunk that deletes fewer
   * than `limit` still means nothing deletable is left.
   */
  async deletePunches(limit: number): Promise<number> {
    const { today, settings } = await this.settings.load();
    const before = addDays(today, -settings.punchRetentionDays);
    return this.db.tx.$executeRaw`
      DELETE FROM device_punches WHERE id IN (
        SELECT id FROM device_punches
        WHERE local_date < ${before}::date
        ORDER BY local_date
        LIMIT ${limit})`;
  }

  /**
   * Up to `limit` command rows unchanged for 90 days that FAILED, were CANCELLED, or are DONE with
   * a later DONE for the same device and ID; how many were deleted. Each ID's latest DONE per
   * device is never deleted: it is what the device has, and the freed-ID rule reads it
   * (`DevicePeopleRoster.onDevice`). PENDING and SENT rows are still on their way. The last change
   * is the latest of updated_at (the app's) and sent_at and done_at (the receiver's).
   */
  async deleteCommands(limit: number): Promise<number> {
    const before = new Date(this.clock.now().getTime() - COMMAND_RETENTION_DAYS * 86_400_000);
    return this.db.tx.$executeRaw`
      DELETE FROM device_commands WHERE id IN (
        SELECT c.id FROM device_commands c
        WHERE greatest(c.updated_at, c.sent_at, c.done_at) < ${before}::timestamptz
          AND (c.status IN ('FAILED', 'CANCELLED')
               OR (c.status = 'DONE'
                   AND EXISTS (SELECT 1 FROM device_commands l
                               WHERE l.device_id = c.device_id
                                 AND l.device_user_id = c.device_user_id
                                 AND l.status = 'DONE' AND l.seq > c.seq)))
        LIMIT ${limit})`;
  }
}
