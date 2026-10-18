import { Injectable, NotFoundException } from '@nestjs/common';
import {
  dateFromDb,
  dateToDb,
  type Holiday,
  type IsoDate,
  type SectionTeacherEntry,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

interface HolidayInput {
  startDate: IsoDate;
  endDate: IsoDate;
  nameBn: string;
  nameEn: string;
}

/** Roles that may be given a section to take attendance for. */
const MARKING_ROLES = ['TEACHER', 'ADMIN', 'OWNER'] as const;

/** Holidays and section-teacher assignments (OWNER/ADMIN). */
@Injectable()
export class AttendanceAdminService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  async listHolidays(year?: number): Promise<Holiday[]> {
    const rows = await this.db.tx.holiday.findMany({
      where: year
        ? {
            startDate: { lte: dateToDb(`${year}-12-31`) },
            endDate: { gte: dateToDb(`${year}-01-01`) },
          }
        : {},
      orderBy: { startDate: 'asc' },
    });
    return rows.map(toHoliday);
  }

  async createHoliday(input: HolidayInput): Promise<Holiday> {
    const row = await this.db.tx.holiday.create({
      data: {
        tenantId: this.tenantId,
        startDate: dateToDb(input.startDate),
        endDate: dateToDb(input.endDate),
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        createdById: this.context.requirePrincipal().userId,
      },
    });
    await this.audit.record({
      entity: 'holiday',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...input },
    });
    return toHoliday(row);
  }

  async updateHoliday(id: string, input: HolidayInput): Promise<Holiday> {
    const before = await this.db.tx.holiday.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Holiday not found');
    const row = await this.db.tx.holiday.update({
      where: { id },
      data: {
        startDate: dateToDb(input.startDate),
        endDate: dateToDb(input.endDate),
        nameBn: input.nameBn,
        nameEn: input.nameEn,
      },
    });
    await this.audit.record({
      entity: 'holiday',
      entityId: id,
      action: 'UPDATE',
      oldValues: { ...toHoliday(before) },
      newValues: { ...input },
    });
    return toHoliday(row);
  }

  async deleteHoliday(id: string): Promise<void> {
    const before = await this.db.tx.holiday.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Holiday not found');
    await this.db.tx.holiday.delete({ where: { id } });
    await this.audit.record({
      entity: 'holiday',
      entityId: id,
      action: 'DELETE',
      oldValues: { ...toHoliday(before) },
    });
  }

  async sectionTeachers(sectionId: string): Promise<SectionTeacherEntry[]> {
    await this.assertSection(sectionId);
    const rows = await this.db.tx.sectionTeacher.findMany({
      where: { sectionId },
      orderBy: [{ isClassTeacher: 'desc' }, { createdAt: 'asc' }],
      select: {
        isClassTeacher: true,
        user: { select: { id: true, name: true, nameBn: true } },
      },
    });
    return rows;
  }

  /** Replace the section's teacher list. Every user must be an active staff member here. */
  async setSectionTeachers(
    sectionId: string,
    teachers: { userId: string; isClassTeacher: boolean }[],
  ): Promise<SectionTeacherEntry[]> {
    const tx = this.db.tx;
    await this.assertSection(sectionId);
    const ids = teachers.map((t) => t.userId);
    const members = await tx.membership.findMany({
      where: { userId: { in: ids }, status: 'ACTIVE', role: { in: [...MARKING_ROLES] } },
      select: { userId: true },
    });
    const valid = new Set(members.map((m) => m.userId));
    const invalid = ids.filter((id) => !valid.has(id));
    if (invalid.length > 0) {
      throw apiError(422, 'NOT_STAFF', 'Only active teachers or admins can be assigned', {
        userIds: invalid,
      });
    }
    const before = await this.sectionTeachers(sectionId);
    await tx.sectionTeacher.deleteMany({ where: { sectionId } });
    if (teachers.length > 0) {
      await tx.sectionTeacher.createMany({
        data: teachers.map((t) => ({
          tenantId: this.tenantId,
          sectionId,
          userId: t.userId,
          isClassTeacher: t.isClassTeacher,
        })),
      });
    }
    await this.audit.record({
      entity: 'section_teachers',
      entityId: sectionId,
      action: 'UPDATE',
      oldValues: before.map((b) => ({ userId: b.user.id, isClassTeacher: b.isClassTeacher })),
      newValues: teachers,
    });
    return this.sectionTeachers(sectionId);
  }

  private async assertSection(sectionId: string): Promise<void> {
    const section = await this.db.tx.section.findUnique({
      where: { id: sectionId },
      select: { id: true },
    });
    if (!section) throw new NotFoundException('Section not found');
  }
}

const toHoliday = (h: {
  id: string;
  startDate: Date;
  endDate: Date;
  nameBn: string;
  nameEn: string;
}): Holiday => ({
  id: h.id,
  startDate: dateFromDb(h.startDate),
  endDate: dateFromDb(h.endDate),
  nameBn: h.nameBn,
  nameEn: h.nameEn,
});
