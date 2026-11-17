import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  ADMISSION_APPLICATION_STATUSES,
  dateFromDb,
  type AdmissionApplicationStatus,
  type AdmissionCycleClasses,
  type AdmissionCycle,
  type AdmissionCycleStatus,
  type AdmissionCycleView,
  type AdmissionFieldSettings,
  type AdmissionOptions,
  type AdmissionSectionOption,
  type UpdateAdmissionCycle,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

const NAMED = { id: true, nameBn: true, nameEn: true } as const;

const CYCLE_SELECT = {
  id: true,
  nameBn: true,
  nameEn: true,
  status: true,
  opensAt: true,
  closesAt: true,
  publicNoteBn: true,
  publicNoteEn: true,
  requiresTest: true,
  collectPhoto: true,
  fields: true,
  meritTieBreak: true,
  academicYear: { select: { id: true, name: true, startDate: true } },
  classes: {
    orderBy: [{ classLevel: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
    select: {
      id: true,
      seats: true,
      isOpen: true,
      resultsVersion: true,
      classLevel: { select: NAMED },
      studyGroup: { select: NAMED },
    },
  },
} satisfies Prisma.AdmissionCycleSelect;

type CycleRow = Prisma.AdmissionCycleGetPayload<{ select: typeof CYCLE_SELECT }>;

/** Statuses that no longer count as an application in play (counts per class). */
const NOT_IN_PLAY: AdmissionApplicationStatus[] = ['REJECTED', 'WITHDRAWN'];

/**
 * Admission cycles and the classes they take (sprint 1 P3a, OWNER/ADMIN). Every id is looked up
 * under RLS, so another institute's year, class or group is simply "not found". Audited.
 */
@Injectable()
export class AdmissionCyclesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<AdmissionCycleView[]> {
    const rows = await this.db.tx.admissionCycle.findMany({
      orderBy: [{ opensAt: 'desc' }, { createdAt: 'desc' }],
      select: CYCLE_SELECT,
    });
    return this.views(rows);
  }

  async get(id: string): Promise<AdmissionCycleView> {
    const row = await this.db.tx.admissionCycle.findUnique({ where: { id }, select: CYCLE_SELECT });
    if (!row) throw new NotFoundException('Admission cycle not found');
    return (await this.views([row]))[0]!;
  }

  async create(input: AdmissionCycle): Promise<AdmissionCycleView> {
    const year = await this.db.tx.academicYear.findUnique({
      where: { id: input.academicYearId },
      select: { id: true },
    });
    if (!year) throw new NotFoundException('Academic year not found');
    const data = {
      academicYearId: input.academicYearId,
      nameBn: input.nameBn,
      nameEn: input.nameEn ?? null,
      opensAt: new Date(input.opensAt),
      closesAt: new Date(input.closesAt),
      publicNoteBn: input.publicNoteBn ?? null,
      publicNoteEn: input.publicNoteEn ?? null,
      requiresTest: input.requiresTest ?? false,
      collectPhoto: input.collectPhoto ?? false,
      fields: input.fields as Prisma.InputJsonValue,
    };
    const cycle = await this.db.tx.admissionCycle.create({
      data: {
        tenantId: this.context.requireTenantId(),
        createdBy: this.context.requirePrincipal().userId,
        ...data,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_cycle',
      entityId: cycle.id,
      action: 'CREATE',
      newValues: { ...data, opensAt: input.opensAt, closesAt: input.closesAt },
    });
    return this.get(cycle.id);
  }

  async update(id: string, input: UpdateAdmissionCycle): Promise<AdmissionCycleView> {
    const tx = this.db.tx;
    const old = await this.lock(id);
    const hasApplications = (await tx.admissionApplication.count({ where: { cycleId: id } })) > 0;
    if (hasApplications) {
      if (input.requiresTest !== undefined && input.requiresTest !== old.requiresTest) {
        throw apiError(
          409,
          'CYCLE_HAS_APPLICATIONS',
          'The admission test cannot be turned on or off once applications exist',
          { field: 'requiresTest' },
        );
      }
      if (input.academicYearId !== undefined && input.academicYearId !== old.academicYearId) {
        throw apiError(
          409,
          'CYCLE_HAS_APPLICATIONS',
          'The year cannot change once applications exist',
          { field: 'academicYearId' },
        );
      }
    }
    // The order of a published merit list never changes under it (sprint 1 P4).
    if (input.meritTieBreak !== undefined && input.meritTieBreak !== old.meritTieBreak) {
      const published = await tx.admissionCycleClass.count({
        where: { cycleId: id, resultsVersion: { gt: 0 } },
      });
      if (published > 0) {
        throw apiError(409, 'RESULTS_PUBLISHED', 'A merit list of this cycle is published', {
          field: 'meritTieBreak',
        });
      }
    }
    if (input.academicYearId !== undefined && input.academicYearId !== old.academicYearId) {
      const year = await tx.academicYear.findUnique({
        where: { id: input.academicYearId },
        select: { id: true },
      });
      if (!year) throw new NotFoundException('Academic year not found');
    }
    const opensAt = input.opensAt ? new Date(input.opensAt) : old.opensAt;
    const closesAt = input.closesAt ? new Date(input.closesAt) : old.closesAt;
    if (closesAt <= opensAt) {
      throw apiError(422, 'WINDOW', 'The form must close after it opens', { field: 'closesAt' });
    }
    const data: Record<string, unknown> = {};
    const changed: Record<string, unknown> = {};
    const was: Record<string, unknown> = {};
    const set = (key: keyof typeof old, value: unknown, stored: unknown = value) => {
      if (value === undefined) return;
      data[key] = stored;
      changed[key] = value;
      was[key] = old[key] instanceof Date ? (old[key] as Date).toISOString() : old[key];
    };
    set('nameBn', input.nameBn);
    set('nameEn', input.nameEn);
    set('opensAt', input.opensAt, input.opensAt ? opensAt : undefined);
    set('closesAt', input.closesAt, input.closesAt ? closesAt : undefined);
    set('publicNoteBn', input.publicNoteBn);
    set('publicNoteEn', input.publicNoteEn);
    set('requiresTest', input.requiresTest);
    set('collectPhoto', input.collectPhoto);
    set('fields', input.fields);
    set('meritTieBreak', input.meritTieBreak);
    set('academicYearId', input.academicYearId);
    if (Object.keys(changed).length > 0) {
      await tx.admissionCycle.update({
        where: { id },
        data: data as Prisma.AdmissionCycleUncheckedUpdateInput,
        select: { id: true },
      });
      await this.audit.record({
        entity: 'admission_cycle',
        entityId: id,
        action: 'UPDATE',
        oldValues: was as Prisma.InputJsonValue,
        newValues: changed as Prisma.InputJsonValue,
      });
    }
    return this.get(id);
  }

  async setStatus(id: string, status: AdmissionCycleStatus): Promise<AdmissionCycleView> {
    const tx = this.db.tx;
    const old = await this.lock(id);
    if (status === 'OPEN') {
      const classes = await tx.admissionCycleClass.count({ where: { cycleId: id } });
      if (classes === 0) {
        throw apiError(422, 'CYCLE_HAS_NO_CLASSES', 'Add at least one class before opening');
      }
    }
    if (old.status !== status) {
      await tx.admissionCycle.update({ where: { id }, data: { status }, select: { id: true } });
      await this.audit.record({
        entity: 'admission_cycle',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: old.status },
        newValues: { status },
      });
    }
    return this.get(id);
  }

  /**
   * Replaces the class list: new classes are added, kept ones get their seats and "open" flag,
   * and removed ones are deleted while they have no application (409 otherwise).
   */
  async setClasses(id: string, input: AdmissionCycleClasses): Promise<AdmissionCycleView> {
    const tx = this.db.tx;
    await this.lock(id);
    const wanted = input.classes.map((c) => ({
      classLevelId: c.classLevelId,
      studyGroupId: c.studyGroupId ?? null,
      seats: c.seats ?? null,
      isOpen: c.isOpen ?? true,
    }));
    const existing = await tx.admissionCycleClass.findMany({
      where: { cycleId: id },
      select: {
        id: true,
        classLevelId: true,
        studyGroupId: true,
        seats: true,
        isOpen: true,
        _count: { select: { applications: true } },
      },
    });
    const key = (c: { classLevelId: string; studyGroupId: string | null }) =>
      `${c.classLevelId}:${c.studyGroupId ?? ''}`;
    const byKey = new Map(existing.map((c) => [key(c), c]));
    const wantedKeys = new Set(wanted.map(key));

    for (const old of existing) {
      if (wantedKeys.has(key(old))) continue;
      if (old._count.applications > 0) {
        throw apiError(409, 'CLASS_HAS_APPLICATIONS', 'This class has applications', {
          cycleClassId: old.id,
        });
      }
    }
    // New classes and groups must exist here and be active.
    for (const c of wanted) {
      if (byKey.has(key(c))) continue;
      const level = await tx.classLevel.findUnique({
        where: { id: c.classLevelId },
        select: { isActive: true },
      });
      if (!level) throw new NotFoundException('Class level not found');
      if (!level.isActive) {
        throw apiError(422, 'INACTIVE', 'This class level is deactivated', {
          field: 'classLevelId',
          classLevelId: c.classLevelId,
        });
      }
      if (c.studyGroupId) {
        const group = await tx.studyGroup.findUnique({
          where: { id: c.studyGroupId },
          select: { isActive: true },
        });
        if (!group) throw new NotFoundException('Study group not found');
        if (!group.isActive) {
          throw apiError(422, 'INACTIVE', 'This study group is deactivated', {
            field: 'studyGroupId',
            studyGroupId: c.studyGroupId,
          });
        }
      }
    }

    const removed = existing.filter((c) => !wantedKeys.has(key(c)));
    if (removed.length > 0) {
      await tx.admissionCycleClass.deleteMany({ where: { id: { in: removed.map((c) => c.id) } } });
    }
    const tenantId = this.context.requireTenantId();
    for (const c of wanted) {
      const old = byKey.get(key(c));
      if (!old) {
        await tx.admissionCycleClass.create({ data: { tenantId, cycleId: id, ...c } });
      } else if (old.seats !== c.seats || old.isOpen !== c.isOpen) {
        await tx.admissionCycleClass.update({
          where: { id: old.id },
          data: { seats: c.seats, isOpen: c.isOpen },
        });
      }
    }
    await this.audit.record({
      entity: 'admission_cycle',
      entityId: id,
      action: 'UPDATE',
      oldValues: {
        classes: existing.map(({ classLevelId, studyGroupId, seats, isOpen }) => ({
          classLevelId,
          studyGroupId,
          seats,
          isOpen,
        })),
      },
      newValues: { classes: wanted },
    });
    return this.get(id);
  }

  async options(): Promise<AdmissionOptions> {
    const tx = this.db.tx;
    const [years, classLevels, studyGroups] = await Promise.all([
      tx.academicYear.findMany({
        orderBy: { startDate: 'desc' },
        select: { id: true, name: true, startDate: true, endDate: true, isCurrent: true },
      }),
      tx.classLevel.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { ...NAMED, isActive: true },
      }),
      tx.studyGroup.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { ...NAMED, isActive: true },
      }),
    ]);
    return {
      years: years.map((y) => ({
        ...y,
        startDate: dateFromDb(y.startDate),
        endDate: dateFromDb(y.endDate),
      })),
      classLevels,
      studyGroups,
    };
  }

  /** Active sections of the class in the cycle's year, with how full they are. */
  async sections(cycleClassId: string): Promise<AdmissionSectionOption[]> {
    const tx = this.db.tx;
    const cc = await tx.admissionCycleClass.findUnique({
      where: { id: cycleClassId },
      select: { classLevelId: true, cycle: { select: { academicYearId: true } } },
    });
    if (!cc) throw new NotFoundException('Admission class not found');
    const sections = await tx.section.findMany({
      where: {
        academicYearId: cc.cycle.academicYearId,
        classLevelId: cc.classLevelId,
        isActive: true,
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        capacity: true,
        _count: { select: { enrolments: { where: { student: { deletedAt: null } } } } },
      },
    });
    return sections.map((s) => ({
      id: s.id,
      name: s.name,
      capacity: s.capacity,
      enrolled: s._count.enrolments,
    }));
  }

  /** The cycle row, locked for this transaction (edits of one cycle run one at a time). */
  private async lock(id: string) {
    // Exclusive against new applications, which take it shared (review N7).
    const key = `admission-cycle:${id}`;
    await this.db.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await this.db.tx
      .$queryRaw`SELECT id FROM public.admission_cycles WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await this.db.tx.admissionCycle.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Admission cycle not found');
    return row;
  }

  private async views(rows: CycleRow[]): Promise<AdmissionCycleView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [byStatus, byClass] = await Promise.all([
      this.db.tx.admissionApplication.groupBy({
        by: ['cycleId', 'status'],
        where: { cycleId: { in: ids } },
        _count: { _all: true },
      }),
      this.db.tx.admissionApplication.groupBy({
        by: ['cycleClassId', 'status'],
        where: { cycleId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const now = this.clock.now();
    return rows.map((r) => {
      const counts = Object.fromEntries(
        ADMISSION_APPLICATION_STATUSES.map((s) => [s, 0]),
      ) as Record<AdmissionApplicationStatus, number>;
      for (const g of byStatus) if (g.cycleId === r.id) counts[g.status] = g._count._all;
      return {
        id: r.id,
        academicYear: {
          id: r.academicYear.id,
          name: r.academicYear.name,
          startDate: dateFromDb(r.academicYear.startDate),
        },
        nameBn: r.nameBn,
        nameEn: r.nameEn,
        status: r.status,
        opensAt: r.opensAt.toISOString(),
        closesAt: r.closesAt.toISOString(),
        publicNoteBn: r.publicNoteBn,
        publicNoteEn: r.publicNoteEn,
        requiresTest: r.requiresTest,
        collectPhoto: r.collectPhoto,
        fields: (r.fields ?? {}) as Partial<AdmissionFieldSettings>,
        meritTieBreak: r.meritTieBreak,
        takingApplications: r.status === 'OPEN' && r.opensAt <= now && now < r.closesAt,
        classes: r.classes.map((c) => {
          const mine = byClass.filter((g) => g.cycleClassId === c.id);
          return {
            id: c.id,
            classLevel: c.classLevel,
            studyGroup: c.studyGroup,
            seats: c.seats,
            isOpen: c.isOpen,
            resultsVersion: c.resultsVersion,
            applications: mine
              .filter((g) => !NOT_IN_PLAY.includes(g.status))
              .reduce((n, g) => n + g._count._all, 0),
            admitted: mine
              .filter((g) => g.status === 'ADMITTED')
              .reduce((n, g) => n + g._count._all, 0),
          };
        }),
        counts,
      };
    });
  }
}
