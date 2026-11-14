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
   * Whether `tenantId` still exists (its own row, read in its context). An institute that is gone
   * has nothing left to process or delete. Throws unless the transaction runs in that institute's
   * context, so a missing or different context can never make a live institute look gone.
   */
  async instituteExists(tenantId: string): Promise<boolean> {
    const [row] = await this.db.tx.$queryRaw<{ context: string | null; n: number }[]>`
      SELECT app_current_tenant_id()::text AS context,
             (SELECT count(*)::int FROM tenants WHERE id = app_current_tenant_id()) AS n`;
    if (!row || row.context !== tenantId) {
      throw new Error("Not in the institute's context");
    }
    return row.n > 0;
  }

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
   * Up to `limit` command rows older than 90 days that FAILED, were CANCELLED, or are DONE with a
   * later DONE for the same device and ID; how many were deleted. Each ID's latest DONE per device
   * (highest seq) is never deleted: it is what the device has, and the freed-ID rule reads it
   * (`DevicePeopleRoster.onDevice`). PENDING and SENT rows are still on their way. A row's age
   * counts from the latest of updated_at (the app's), sent_at and done_at (the receiver's; a
   * command it gave up on after the 5th send has only sent_at).
   *
   * The DONE rows are ranked per device and ID in one sort. A correlated "later DONE exists" check
   * read every DONE row of the device for each old one: 12 s a night for 5000 IDs on 4 devices,
   * deleting nothing (this takes 50 ms).
   */
  async deleteCommands(limit: number): Promise<number> {
    const before = new Date(this.clock.now().getTime() - COMMAND_RETENTION_DAYS * 86_400_000);
    return this.db.tx.$executeRaw`
      DELETE FROM device_commands WHERE id IN (
        SELECT c.id FROM device_commands c
        WHERE c.status IN ('FAILED', 'CANCELLED')
          AND greatest(c.updated_at, c.sent_at, c.done_at) < ${before}::timestamptz
        UNION ALL
        SELECT done.id FROM (
          SELECT c.id, greatest(c.updated_at, c.sent_at, c.done_at) AS changed,
                 row_number() OVER (PARTITION BY c.device_id, c.device_user_id
                                    ORDER BY c.seq DESC) AS newest
          FROM device_commands c
          WHERE c.status = 'DONE'
        ) done
        WHERE done.newest > 1 AND done.changed < ${before}::timestamptz
        LIMIT ${limit})`;
  }
}
