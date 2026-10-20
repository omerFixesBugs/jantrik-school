import { Injectable, NotFoundException } from '@nestjs/common';
import {
  LABEL_KEYS,
  dateFromDb,
  dateToDb,
  type IsoDate,
  type LabelKey,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupLabel,
  type SetupSection,
  type SetupShift,
  type SetupStudyGroup,
  type SetupSubject,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

interface YearInput {
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  copySectionsFrom?: string | null;
}
interface CodeNameInput {
  code?: string;
  nameBn?: string;
  nameEn?: string;
  sortOrder?: number;
  isActive?: boolean;
}
interface ShiftInput {
  nameBn?: string;
  nameEn?: string;
  startTime?: string;
  endTime?: string;
  sortOrder?: number;
  isActive?: boolean;
}
interface SectionCreate {
  academicYearId: string;
  classLevelId: string;
  name: string;
  shiftId: string | null;
  capacity: number | null;
  sortOrder: number;
}
interface SectionUpdate {
  name?: string;
  shiftId?: string | null;
  capacity?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}
interface SubjectCreate {
  classLevelId: string;
  studyGroupId: string | null;
  code: string;
  nameBn: string;
  nameEn: string;
  isOptional: boolean;
  sortOrder: number;
}
type SubjectUpdate = Partial<Omit<SubjectCreate, 'classLevelId'>> & { isActive?: boolean };

/** "HH:MM" ⇄ a TIME column (Prisma maps it to a Date on 1970-01-01 UTC). */
const timeToDb = (t: string): Date => new Date(`1970-01-01T${t}:00Z`);
const timeFromDb = (d: Date): string => d.toISOString().slice(11, 16);

const inUse = (usage: Record<string, number>) =>
  apiError(409, 'IN_USE', 'In use: deactivate it instead of deleting', { usage });
const duplicate = (field: string) =>
  apiError(409, 'DUPLICATE', `Another one already has this ${field}`, { field });
const used = (usage: Record<string, number>) => Object.values(usage).some((n) => n > 0);

/**
 * Institute setup (OWNER/ADMIN). Every write goes through the request transaction (`Db.tx`,
 * tenant RLS) and is audited. Uniqueness is checked before writing: a unique violation would
 * abort the whole request transaction.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Academic years ───────────────────────────

  async listYears(): Promise<SetupAcademicYear[]> {
    const rows = await this.db.tx.academicYear.findMany({
      orderBy: { startDate: 'desc' },
      include: { _count: { select: { sections: true, enrolments: true } } },
    });
    return rows.map(toYear);
  }

  async createYear(input: YearInput): Promise<SetupAcademicYear> {
    const tx = this.db.tx;
    if (await tx.academicYear.findFirst({ where: { name: input.name }, select: { id: true } }))
      throw duplicate('name');
    const source = input.copySectionsFrom
      ? await tx.academicYear.findUnique({ where: { id: input.copySectionsFrom } })
      : null;
    if (input.copySectionsFrom && !source) throw new NotFoundException('Academic year not found');

    const year = await tx.academicYear.create({
      data: {
        tenantId: this.tenantId,
        name: input.name,
        startDate: dateToDb(input.startDate),
        endDate: dateToDb(input.endDate),
        // The first year of an institute becomes current by itself.
        isCurrent: (await tx.academicYear.count()) === 0,
      },
    });
    let copied = 0;
    if (source) {
      const sections = await tx.section.findMany({
        where: { academicYearId: source.id, isActive: true, classLevel: { isActive: true } },
        select: {
          classLevelId: true,
          branchId: true,
          shiftId: true,
          shift: { select: { isActive: true } },
          name: true,
          capacity: true,
          sortOrder: true,
        },
      });
      if (sections.length > 0) {
        await tx.section.createMany({
          data: sections.map(({ shift, ...s }) => ({
            ...s,
            // A deactivated shift is not carried into the new year.
            shiftId: shift?.isActive ? s.shiftId : null,
            tenantId: this.tenantId,
            academicYearId: year.id,
          })),
        });
      }
      copied = sections.length;
    }
    await this.audit.record({
      entity: 'academic_year',
      entityId: year.id,
      action: 'CREATE',
      newValues: { ...input, copiedSections: copied },
    });
    return this.year(year.id);
  }

  async updateYear(id: string, input: YearInput): Promise<SetupAcademicYear> {
    const tx = this.db.tx;
    const before = await this.year(id);
    if (
      await tx.academicYear.findFirst({
        where: { name: input.name, id: { not: id } },
        select: { id: true },
      })
    )
      throw duplicate('name');
    await tx.academicYear.update({
      where: { id },
      data: {
        name: input.name,
        startDate: dateToDb(input.startDate),
        endDate: dateToDb(input.endDate),
      },
    });
    const after = await this.year(id);
    await this.audit.record({
      entity: 'academic_year',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickYear(before),
      newValues: pickYear(after),
    });
    return after;
  }

  /** Make this the current year (exactly one is current: partial unique index). */
  async setCurrentYear(id: string): Promise<SetupAcademicYear> {
    const tx = this.db.tx;
    const target = await this.year(id);
    const previous = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    if (previous?.id !== id) {
      await tx.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.academicYear.update({ where: { id }, data: { isCurrent: true } });
      await this.audit.record({
        entity: 'academic_year',
        entityId: id,
        action: 'UPDATE',
        oldValues: { isCurrent: false, previousCurrentId: previous?.id ?? null },
        newValues: { isCurrent: true },
      });
    }
    return { ...target, isCurrent: true };
  }

  async deleteYear(id: string): Promise<void> {
    const year = await this.year(id);
    const usage = { sections: year.sectionCount, enrolments: year.enrolmentCount };
    if (used(usage) || year.isCurrent) throw inUse({ ...usage, current: year.isCurrent ? 1 : 0 });
    await this.db.tx.academicYear.delete({ where: { id } });
    await this.audit.record({
      entity: 'academic_year',
      entityId: id,
      action: 'DELETE',
      oldValues: pickYear(year),
    });
  }

  private async year(id: string): Promise<SetupAcademicYear> {
    const row = await this.db.tx.academicYear.findUnique({
      where: { id },
      include: { _count: { select: { sections: true, enrolments: true } } },
    });
    if (!row) throw new NotFoundException('Academic year not found');
    return toYear(row);
  }

  // ─────────────────────────── Class levels ───────────────────────────

  async listClassLevels(): Promise<SetupClassLevel[]> {
    const rows = await this.db.tx.classLevel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { sections: true, subjects: true, enrolments: true } } },
    });
    return rows.map(toClassLevel);
  }

  async createClassLevel(
    input: Required<Omit<CodeNameInput, 'isActive'>>,
  ): Promise<SetupClassLevel> {
    const tx = this.db.tx;
    if (await tx.classLevel.findFirst({ where: { code: input.code }, select: { id: true } }))
      throw duplicate('code');
    const row = await tx.classLevel.create({ data: { tenantId: this.tenantId, ...input } });
    await this.audit.record({
      entity: 'class_level',
      entityId: row.id,
      action: 'CREATE',
      newValues: input,
    });
    return this.classLevel(row.id);
  }

  async updateClassLevel(id: string, input: CodeNameInput): Promise<SetupClassLevel> {
    const tx = this.db.tx;
    const before = await this.classLevel(id);
    if (
      input.code &&
      (await tx.classLevel.findFirst({
        where: { code: input.code, id: { not: id } },
        select: { id: true },
      }))
    )
      throw duplicate('code');
    await tx.classLevel.update({ where: { id }, data: input });
    const after = await this.classLevel(id);
    await this.audit.record({
      entity: 'class_level',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickCodeName(before),
      newValues: pickCodeName(after),
    });
    return after;
  }

  async deleteClassLevel(id: string): Promise<void> {
    const before = await this.classLevel(id);
    if (used(before.usage)) throw inUse(before.usage);
    await this.db.tx.classLevel.delete({ where: { id } });
    await this.audit.record({
      entity: 'class_level',
      entityId: id,
      action: 'DELETE',
      oldValues: pickCodeName(before),
    });
  }

  private async classLevel(id: string): Promise<SetupClassLevel> {
    const row = await this.db.tx.classLevel.findUnique({
      where: { id },
      include: { _count: { select: { sections: true, subjects: true, enrolments: true } } },
    });
    if (!row) throw new NotFoundException('Class level not found');
    return toClassLevel(row);
  }

  // ─────────────────────────── Study groups ───────────────────────────

  async listStudyGroups(): Promise<SetupStudyGroup[]> {
    const rows = await this.db.tx.studyGroup.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { subjects: true, enrolments: true } } },
    });
    return rows.map(toStudyGroup);
  }

  async createStudyGroup(
    input: Required<Omit<CodeNameInput, 'isActive'>>,
  ): Promise<SetupStudyGroup> {
    const tx = this.db.tx;
    if (await tx.studyGroup.findFirst({ where: { code: input.code }, select: { id: true } }))
      throw duplicate('code');
    const row = await tx.studyGroup.create({ data: { tenantId: this.tenantId, ...input } });
    await this.audit.record({
      entity: 'study_group',
      entityId: row.id,
      action: 'CREATE',
      newValues: input,
    });
    return this.studyGroup(row.id);
  }

  async updateStudyGroup(id: string, input: CodeNameInput): Promise<SetupStudyGroup> {
    const tx = this.db.tx;
    const before = await this.studyGroup(id);
    if (
      input.code &&
      (await tx.studyGroup.findFirst({
        where: { code: input.code, id: { not: id } },
        select: { id: true },
      }))
    )
      throw duplicate('code');
    await tx.studyGroup.update({ where: { id }, data: input });
    const after = await this.studyGroup(id);
    await this.audit.record({
      entity: 'study_group',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickCodeName(before),
      newValues: pickCodeName(after),
    });
    return after;
  }

  async deleteStudyGroup(id: string): Promise<void> {
    const before = await this.studyGroup(id);
    if (used(before.usage)) throw inUse(before.usage);
    await this.db.tx.studyGroup.delete({ where: { id } });
    await this.audit.record({
      entity: 'study_group',
      entityId: id,
      action: 'DELETE',
      oldValues: pickCodeName(before),
    });
  }

  private async studyGroup(id: string): Promise<SetupStudyGroup> {
    const row = await this.db.tx.studyGroup.findUnique({
      where: { id },
      include: { _count: { select: { subjects: true, enrolments: true } } },
    });
    if (!row) throw new NotFoundException('Study group not found');
    return toStudyGroup(row);
  }

  // ─────────────────────────── Shifts ───────────────────────────

  async listShifts(): Promise<SetupShift[]> {
    const rows = await this.db.tx.shift.findMany({
      orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }],
      include: { _count: { select: { sections: true } } },
    });
    return rows.map(toShift);
  }

  async createShift(input: Required<Omit<ShiftInput, 'isActive'>>): Promise<SetupShift> {
    const tx = this.db.tx;
    if (await tx.shift.findFirst({ where: { nameEn: input.nameEn }, select: { id: true } }))
      throw duplicate('nameEn');
    const row = await tx.shift.create({
      data: {
        tenantId: this.tenantId,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        startTime: timeToDb(input.startTime),
        endTime: timeToDb(input.endTime),
        sortOrder: input.sortOrder,
      },
    });
    await this.audit.record({
      entity: 'shift',
      entityId: row.id,
      action: 'CREATE',
      newValues: input,
    });
    return this.shift(row.id);
  }

  async updateShift(id: string, input: ShiftInput): Promise<SetupShift> {
    const tx = this.db.tx;
    const before = await this.shift(id);
    const startTime = input.startTime ?? before.startTime;
    const endTime = input.endTime ?? before.endTime;
    if (endTime <= startTime)
      throw apiError(422, 'INVALID_TIMES', 'End must be after start', { field: 'endTime' });
    if (
      input.nameEn &&
      (await tx.shift.findFirst({
        where: { nameEn: input.nameEn, id: { not: id } },
        select: { id: true },
      }))
    )
      throw duplicate('nameEn');
    await tx.shift.update({
      where: { id },
      data: {
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        startTime: timeToDb(startTime),
        endTime: timeToDb(endTime),
      },
    });
    const after = await this.shift(id);
    await this.audit.record({
      entity: 'shift',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickShift(before),
      newValues: pickShift(after),
    });
    return after;
  }

  async deleteShift(id: string): Promise<void> {
    const before = await this.shift(id);
    if (used(before.usage)) throw inUse(before.usage);
    await this.db.tx.shift.delete({ where: { id } });
    await this.audit.record({
      entity: 'shift',
      entityId: id,
      action: 'DELETE',
      oldValues: pickShift(before),
    });
  }

  private async shift(id: string): Promise<SetupShift> {
    const row = await this.db.tx.shift.findUnique({
      where: { id },
      include: { _count: { select: { sections: true } } },
    });
    if (!row) throw new NotFoundException('Shift not found');
    return toShift(row);
  }

  // ─────────────────────────── Sections ───────────────────────────

  async listSections(academicYearId: string): Promise<SetupSection[]> {
    const rows = await this.db.tx.section.findMany({
      where: { academicYearId },
      orderBy: [{ classLevel: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: sectionCounts,
    });
    return rows.map(toSection);
  }

  async createSection(input: SectionCreate): Promise<SetupSection> {
    const tx = this.db.tx;
    const [year, classLevel] = [
      await tx.academicYear.findUnique({
        where: { id: input.academicYearId },
        select: { id: true },
      }),
      await tx.classLevel.findUnique({
        where: { id: input.classLevelId },
        select: { isActive: true },
      }),
    ];
    if (!year) throw new NotFoundException('Academic year not found');
    if (!classLevel) throw new NotFoundException('Class level not found');
    if (!classLevel.isActive) throw apiError(422, 'INACTIVE', 'This class level is deactivated');
    await this.assertShift(input.shiftId);
    if (
      await tx.section.findFirst({
        where: {
          academicYearId: input.academicYearId,
          classLevelId: input.classLevelId,
          name: input.name,
        },
        select: { id: true },
      })
    )
      throw duplicate('name');
    const row = await tx.section.create({ data: { tenantId: this.tenantId, ...input } });
    await this.audit.record({
      entity: 'section',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...input },
    });
    return this.section(row.id);
  }

  async updateSection(id: string, input: SectionUpdate): Promise<SetupSection> {
    const tx = this.db.tx;
    const before = await this.section(id);
    // Keeping a (since deactivated) shift is fine; choosing one needs it to be active.
    if (input.shiftId !== undefined && input.shiftId !== before.shiftId)
      await this.assertShift(input.shiftId);
    if (input.isActive && !before.isActive) {
      const classLevel = await tx.classLevel.findUniqueOrThrow({
        where: { id: before.classLevelId },
        select: { isActive: true },
      });
      if (!classLevel.isActive) throw apiError(422, 'INACTIVE', 'Activate the class level first');
    }
    if (
      input.name &&
      (await tx.section.findFirst({
        where: {
          academicYearId: before.academicYearId,
          classLevelId: before.classLevelId,
          name: input.name,
          id: { not: id },
        },
        select: { id: true },
      }))
    )
      throw duplicate('name');
    if (input.capacity != null && input.capacity < before.usage.enrolments) {
      throw apiError(422, 'CAPACITY_TOO_LOW', 'More students are already enrolled', {
        enrolled: before.usage.enrolments,
      });
    }
    await tx.section.update({ where: { id }, data: input });
    const after = await this.section(id);
    await this.audit.record({
      entity: 'section',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickSection(before),
      newValues: pickSection(after),
    });
    return after;
  }

  async deleteSection(id: string): Promise<void> {
    // Lock the row first: section_teachers cascades on delete, so a teacher assigned between the
    // usage check and the delete would otherwise vanish silently. Inserts referencing the section
    // wait for this lock, then fail their foreign key.
    await this.db.tx.$queryRaw`SELECT id FROM sections WHERE id = ${id}::uuid FOR UPDATE`;
    const before = await this.section(id);
    if (used(before.usage)) throw inUse(before.usage);
    await this.db.tx.section.delete({ where: { id } });
    await this.audit.record({
      entity: 'section',
      entityId: id,
      action: 'DELETE',
      oldValues: pickSection(before),
    });
  }

  private async section(id: string): Promise<SetupSection> {
    const row = await this.db.tx.section.findUnique({ where: { id }, include: sectionCounts });
    if (!row) throw new NotFoundException('Section not found');
    return toSection(row);
  }

  private async assertShift(shiftId: string | null): Promise<void> {
    if (!shiftId) return;
    const shift = await this.db.tx.shift.findUnique({
      where: { id: shiftId },
      select: { isActive: true },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    if (!shift.isActive) throw apiError(422, 'INACTIVE', 'This shift is deactivated');
  }

  // ─────────────────────────── Subjects ───────────────────────────

  async listSubjects(classLevelId: string): Promise<SetupSubject[]> {
    const rows = await this.db.tx.subject.findMany({
      where: { classLevelId },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { attendanceSessions: true } } },
    });
    return rows.map(toSubject);
  }

  async createSubject(input: SubjectCreate): Promise<SetupSubject> {
    const tx = this.db.tx;
    const classLevel = await tx.classLevel.findUnique({
      where: { id: input.classLevelId },
      select: { isActive: true },
    });
    if (!classLevel) throw new NotFoundException('Class level not found');
    if (!classLevel.isActive) throw apiError(422, 'INACTIVE', 'This class level is deactivated');
    await this.assertStudyGroup(input.studyGroupId);
    if (
      await tx.subject.findFirst({
        where: { classLevelId: input.classLevelId, code: input.code },
        select: { id: true },
      })
    )
      throw duplicate('code');
    const row = await tx.subject.create({ data: { tenantId: this.tenantId, ...input } });
    await this.audit.record({
      entity: 'subject',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...input },
    });
    return this.subject(row.id);
  }

  async updateSubject(id: string, input: SubjectUpdate): Promise<SetupSubject> {
    const tx = this.db.tx;
    const before = await this.subject(id);
    if (input.studyGroupId !== undefined && input.studyGroupId !== before.studyGroupId)
      await this.assertStudyGroup(input.studyGroupId);
    if (
      input.code &&
      (await tx.subject.findFirst({
        where: { classLevelId: before.classLevelId, code: input.code, id: { not: id } },
        select: { id: true },
      }))
    )
      throw duplicate('code');
    await tx.subject.update({ where: { id }, data: input });
    const after = await this.subject(id);
    await this.audit.record({
      entity: 'subject',
      entityId: id,
      action: 'UPDATE',
      oldValues: pickSubject(before),
      newValues: pickSubject(after),
    });
    return after;
  }

  async deleteSubject(id: string): Promise<void> {
    const before = await this.subject(id);
    if (used(before.usage)) throw inUse(before.usage);
    await this.db.tx.subject.delete({ where: { id } });
    await this.audit.record({
      entity: 'subject',
      entityId: id,
      action: 'DELETE',
      oldValues: pickSubject(before),
    });
  }

  private async subject(id: string): Promise<SetupSubject> {
    const row = await this.db.tx.subject.findUnique({
      where: { id },
      include: { _count: { select: { attendanceSessions: true } } },
    });
    if (!row) throw new NotFoundException('Subject not found');
    return toSubject(row);
  }

  private async assertStudyGroup(id: string | null): Promise<void> {
    if (!id) return;
    const group = await this.db.tx.studyGroup.findUnique({
      where: { id },
      select: { isActive: true },
    });
    if (!group) throw new NotFoundException('Study group not found');
    if (!group.isActive) throw apiError(422, 'INACTIVE', 'This study group is deactivated');
  }

  // ─────────────────────────── Labels ───────────────────────────

  async listLabels(): Promise<SetupLabel[]> {
    const tx = this.db.tx;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: this.tenantId },
      select: { instituteTypeId: true },
    });
    const [own, defaults] = [
      await tx.tenantLabel.findMany(),
      await tx.templateLabel.findMany({ where: { instituteTypeId: tenant.instituteTypeId } }),
    ];
    return LABEL_KEYS.map((key) => {
      const d = defaults.find((x) => x.key === key);
      const o = own.find((x) => x.key === key);
      const defaultBn = d?.valueBn ?? key;
      const defaultEn = d?.valueEn ?? key;
      return {
        key,
        bn: o?.valueBn ?? defaultBn,
        en: o?.valueEn ?? defaultEn,
        defaultBn,
        defaultEn,
      };
    });
  }

  async updateLabels(labels: { key: LabelKey; bn: string; en: string }[]): Promise<SetupLabel[]> {
    const tx = this.db.tx;
    const before = await this.listLabels();
    for (const l of labels) {
      await tx.tenantLabel.upsert({
        where: { tenantId_key: { tenantId: this.tenantId, key: l.key } },
        create: { tenantId: this.tenantId, key: l.key, valueBn: l.bn, valueEn: l.en },
        update: { valueBn: l.bn, valueEn: l.en },
      });
    }
    const after = await this.listLabels();
    const changed = labels.map((l) => l.key);
    await this.audit.record({
      entity: 'tenant_labels',
      // One entry for the set; the tenant id identifies it.
      entityId: this.tenantId,
      action: 'UPDATE',
      oldValues: before
        .filter((b) => changed.includes(b.key))
        .map(({ key, bn, en }) => ({ key, bn, en })),
      newValues: labels,
    });
    return after;
  }
}

const sectionCounts = {
  _count: { select: { enrolments: true, attendanceSessions: true, teachers: true } },
} as const;

type Counted<T, C> = T & { _count: C };

function toYear(
  y: Counted<
    { id: string; name: string; startDate: Date; endDate: Date; isCurrent: boolean },
    { sections: number; enrolments: number }
  >,
): SetupAcademicYear {
  return {
    id: y.id,
    name: y.name,
    startDate: dateFromDb(y.startDate),
    endDate: dateFromDb(y.endDate),
    isCurrent: y.isCurrent,
    sectionCount: y._count.sections,
    enrolmentCount: y._count.enrolments,
  };
}

function toClassLevel(
  c: Counted<
    {
      id: string;
      code: string;
      nameBn: string;
      nameEn: string;
      sortOrder: number;
      isActive: boolean;
    },
    { sections: number; subjects: number; enrolments: number }
  >,
): SetupClassLevel {
  const { _count, ...rest } = c;
  return {
    id: rest.id,
    code: rest.code,
    nameBn: rest.nameBn,
    nameEn: rest.nameEn,
    sortOrder: rest.sortOrder,
    isActive: rest.isActive,
    usage: { ..._count },
  };
}

function toStudyGroup(
  g: Counted<
    {
      id: string;
      code: string;
      nameBn: string;
      nameEn: string;
      sortOrder: number;
      isActive: boolean;
    },
    { subjects: number; enrolments: number }
  >,
): SetupStudyGroup {
  return {
    id: g.id,
    code: g.code,
    nameBn: g.nameBn,
    nameEn: g.nameEn,
    sortOrder: g.sortOrder,
    isActive: g.isActive,
    usage: { ...g._count },
  };
}

function toShift(
  s: Counted<
    {
      id: string;
      nameBn: string;
      nameEn: string;
      startTime: Date;
      endTime: Date;
      sortOrder: number;
      isActive: boolean;
    },
    { sections: number }
  >,
): SetupShift {
  return {
    id: s.id,
    nameBn: s.nameBn,
    nameEn: s.nameEn,
    startTime: timeFromDb(s.startTime),
    endTime: timeFromDb(s.endTime),
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    usage: { ...s._count },
  };
}

function toSection(
  s: Counted<
    {
      id: string;
      academicYearId: string;
      classLevelId: string;
      shiftId: string | null;
      name: string;
      capacity: number | null;
      sortOrder: number;
      isActive: boolean;
    },
    { enrolments: number; attendanceSessions: number; teachers: number }
  >,
): SetupSection {
  return {
    id: s.id,
    academicYearId: s.academicYearId,
    classLevelId: s.classLevelId,
    shiftId: s.shiftId,
    name: s.name,
    capacity: s.capacity,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    usage: {
      enrolments: s._count.enrolments,
      attendance: s._count.attendanceSessions,
      teachers: s._count.teachers,
    },
  };
}

function toSubject(
  s: Counted<
    {
      id: string;
      classLevelId: string;
      studyGroupId: string | null;
      code: string;
      nameBn: string;
      nameEn: string;
      isOptional: boolean;
      sortOrder: number;
      isActive: boolean;
    },
    { attendanceSessions: number }
  >,
): SetupSubject {
  return {
    id: s.id,
    classLevelId: s.classLevelId,
    studyGroupId: s.studyGroupId,
    code: s.code,
    nameBn: s.nameBn,
    nameEn: s.nameEn,
    isOptional: s.isOptional,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    usage: { attendance: s._count.attendanceSessions },
  };
}

const pickYear = ({ name, startDate, endDate, isCurrent }: SetupAcademicYear) => ({
  name,
  startDate,
  endDate,
  isCurrent,
});
const pickCodeName = (x: {
  code: string;
  nameBn: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}) => ({
  code: x.code,
  nameBn: x.nameBn,
  nameEn: x.nameEn,
  sortOrder: x.sortOrder,
  isActive: x.isActive,
});
const pickShift = ({ usage: _usage, id: _id, ...rest }: SetupShift) => rest;
const pickSection = ({ usage: _usage, id: _id, ...rest }: SetupSection) => rest;
const pickSubject = ({ usage: _usage, id: _id, ...rest }: SetupSubject) => rest;
