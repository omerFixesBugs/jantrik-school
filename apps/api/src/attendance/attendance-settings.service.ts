import { Injectable } from '@nestjs/common';
import {
  DEFAULT_ABSENT_SMS_TEMPLATE,
  dateToDb,
  isoWeekday,
  todayIn,
  type AttendanceMode,
  type AttendanceSettings,
  type AttendanceSettingsInput,
  type IsoDate,
  type NonWorkingDay,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

/** The stored settings (or the institute type's defaults) without derived values. */
export interface StoredSettings {
  mode: AttendanceMode;
  weeklyOffDays: number[];
  editWindowDays: number;
  leaveCountsAsAbsent: boolean;
  absentSmsEnabled: boolean;
  absentSmsTemplate: string | null;
  absentSmsDelayMinutes: number;
  dailySmsCap: number | null;
}

export interface AttendanceTenant {
  id: string;
  name: string;
  timezone: string;
  /** Today in the tenant's timezone, from the server clock. */
  today: IsoDate;
  settings: StoredSettings;
}

@Injectable()
export class AttendanceSettingsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tenant, today and settings. Tenants created before the attendance module have no settings
   * row yet: they get the institute type's defaults until an admin saves the settings.
   */
  async load(): Promise<AttendanceTenant> {
    const tx = this.db.tx;
    const tenant = await tx.tenant.findFirstOrThrow({
      select: {
        id: true,
        name: true,
        timezone: true,
        attendanceSettings: true,
        instituteType: { select: { attendanceMode: true } },
      },
    });
    const row = tenant.attendanceSettings;
    const settings: StoredSettings = row
      ? {
          mode: row.mode,
          weeklyOffDays: row.weeklyOffDays,
          editWindowDays: row.editWindowDays,
          leaveCountsAsAbsent: row.leaveCountsAsAbsent,
          absentSmsEnabled: row.absentSmsEnabled,
          absentSmsTemplate: row.absentSmsTemplate,
          absentSmsDelayMinutes: row.absentSmsDelayMinutes,
          dailySmsCap: row.dailySmsCap,
        }
      : {
          mode: tenant.instituteType.attendanceMode,
          weeklyOffDays: [5],
          editWindowDays: 0,
          leaveCountsAsAbsent: false,
          absentSmsEnabled: false,
          absentSmsTemplate: null,
          absentSmsDelayMinutes: 10,
          dailySmsCap: null,
        };
    return {
      id: tenant.id,
      name: tenant.name,
      timezone: tenant.timezone,
      today: todayIn(tenant.timezone),
      settings,
    };
  }

  async get(): Promise<AttendanceSettings> {
    const { settings } = await this.load();
    return this.toResponse(settings);
  }

  async update(input: AttendanceSettingsInput & { absentSmsTemplate: string | null }) {
    const tx = this.db.tx;
    const before = (await this.load()).settings;
    const tenantId = this.context.requirePrincipal().tenantId!;
    const data = {
      mode: input.mode,
      weeklyOffDays: [...new Set(input.weeklyOffDays)].sort(),
      editWindowDays: input.editWindowDays,
      leaveCountsAsAbsent: input.leaveCountsAsAbsent,
      absentSmsEnabled: input.absentSmsEnabled,
      absentSmsTemplate: input.absentSmsTemplate,
      absentSmsDelayMinutes: input.absentSmsDelayMinutes,
      dailySmsCap: input.dailySmsCap,
    };
    const row = await tx.attendanceSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
      select: { id: true },
    });
    await this.audit.record({
      entity: 'attendance_settings',
      entityId: row.id,
      action: 'UPDATE',
      oldValues: { ...before },
      newValues: { ...data },
    });
    return this.toResponse(data);
  }

  /** The SMS cap in force: the tenant's own, or 2 × active students. */
  async effectiveDailySmsCap(settings: StoredSettings): Promise<number> {
    if (settings.dailySmsCap !== null) return settings.dailySmsCap;
    const active = await this.db.tx.student.count({ where: { status: 'ACTIVE', deletedAt: null } });
    return active * 2;
  }

  /** Why `date` is not a working day, or null when it is. */
  async nonWorkingDay(date: IsoDate, settings: StoredSettings): Promise<NonWorkingDay | null> {
    const holiday = await this.db.tx.holiday.findFirst({
      where: { startDate: { lte: dateToDb(date) }, endDate: { gte: dateToDb(date) } },
      orderBy: { startDate: 'asc' },
      select: { nameBn: true, nameEn: true },
    });
    if (holiday) return { reason: 'HOLIDAY', ...holiday };
    if (settings.weeklyOffDays.includes(isoWeekday(date))) return { reason: 'OFF_DAY' };
    return null;
  }

  private async toResponse(s: StoredSettings): Promise<AttendanceSettings> {
    return {
      ...s,
      effectiveAbsentSmsTemplate: s.absentSmsTemplate ?? DEFAULT_ABSENT_SMS_TEMPLATE,
      effectiveDailySmsCap: await this.effectiveDailySmsCap(s),
    };
  }
}
