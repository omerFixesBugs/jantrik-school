import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_ABSENT_SMS_TEMPLATE,
  dateToDb,
  formatDate,
  renderSmsTemplate,
  type IsoDate,
} from '@jantrik/shared';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';
import { AttendanceSettingsService, type AttendanceTenant } from './attendance-settings.service.js';

/** Who an SMS about a student goes to: the student's name as SMS show it, and the phone. */
export interface GuardianContact {
  studentId: string;
  student: string;
  /** The primary guardian's phone; null when there is none (no SMS then). */
  phone: string | null;
}

/**
 * The absent SMS, used by a submit and by registers written from device punches: one per absent
 * student per day to the primary guardian, re-checked just before it is sent.
 */
@Injectable()
export class AbsentSmsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly settings: AttendanceSettingsService,
    private readonly sms: TenantSmsService,
  ) {}

  /** Just before an absent SMS goes out: is the student still absent in some register that day? */
  onModuleInit(): void {
    this.sms.registerRelevanceCheck('ATTENDANCE_ABSENT', async ({ relatedId, localDate }) => {
      if (!relatedId) return false;
      const absent = await this.db.tx.attendanceRecord.count({
        where: { studentId: relatedId, status: 'ABSENT', session: { date: dateToDb(localDate) } },
      });
      return absent > 0;
    });
  }

  /**
   * One SMS per absent student per day to the primary guardian (sms_logs dedupe key), only for
   * today's registers, and only when the tenant has turned absent SMS on.
   */
  async queue(tenant: AttendanceTenant, date: IsoDate, studentIds: string[]): Promise<void> {
    const s = tenant.settings;
    if (!s.absentSmsEnabled || date !== tenant.today || studentIds.length === 0) return;
    const contacts = await this.contacts(studentIds);
    const template = s.absentSmsTemplate ?? DEFAULT_ABSENT_SMS_TEMPLATE;
    const cap = await this.settings.effectiveDailySmsCap(s);
    const dateText = formatDate(dateToDb(date), 'bn', 'long');
    for (const c of contacts.values()) {
      if (!c.phone) continue;
      await this.sms.queue({
        purpose: 'ATTENDANCE_ABSENT',
        phone: c.phone,
        body: renderSmsTemplate(template, {
          student: c.student,
          date: dateText,
          institute: tenant.name,
        }),
        localDate: date,
        dedupeKey: `absent:${c.studentId}:${date}`,
        relatedEntity: 'student',
        relatedId: c.studentId,
        delayMs: s.absentSmsDelayMinutes * 60_000,
        dailyCap: cap,
      });
    }
  }

  /** Each student's name for SMS and their primary guardian's phone, by student id. */
  async contacts(studentIds: string[]): Promise<Map<string, GuardianContact>> {
    const students = await this.db.tx.student.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        nameBn: true,
        nameEn: true,
        guardians: {
          where: { isPrimary: true },
          take: 1,
          select: { guardian: { select: { phone: true } } },
        },
      },
    });
    return new Map(
      students.map((st) => [
        st.id,
        {
          studentId: st.id,
          student: st.nameBn ?? st.nameEn ?? '',
          phone: st.guardians[0]?.guardian.phone ?? null,
        },
      ]),
    );
  }
}
