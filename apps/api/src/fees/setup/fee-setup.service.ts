import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  dateToDb,
  normalizeFeeHead,
  type FeeAmountsMatrix,
  type FeeConcessionView,
  type FeeHeadView,
  type FeeSettingsView,
  type FeeTermView,
  type IsoDate,
} from '@jantrik/shared';
import type { z } from 'zod';
import type {
  copyFeeAmountsSchema,
  createFeeConcessionSchema,
  createFeeHeadSchema,
  createFeeTermSchema,
  endFeeConcessionSchema,
  feeSettingsSchema,
  setFeeAmountsSchema,
  updateFeeHeadSchema,
  updateFeeTermSchema,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { Db } from '../../tenancy/db.service.js';
import { FeeDuesService } from '../dues/fee-dues.service.js';

type SettingsInput = z.output<typeof feeSettingsSchema>;
type HeadCreate = z.output<typeof createFeeHeadSchema>;
type HeadUpdate = z.output<typeof updateFeeHeadSchema>;
type TermCreate = z.output<typeof createFeeTermSchema>;
type TermUpdate = z.output<typeof updateFeeTermSchema>;
type AmountsInput = z.output<typeof setFeeAmountsSchema>;
type CopyInput = z.output<typeof copyFeeAmountsSchema>;
type ConcessionCreate = z.output<typeof createFeeConcessionSchema>;
type ConcessionEnd = z.output<typeof endFeeConcessionSchema>;

const DEFAULT_SETTINGS: FeeSettingsView = {
  duesFrom: null,
  receiptSmsEnabled: true,
  sibling: null,
  receiptNote: null,
  saved: false,
};

const duplicate = (field: string) =>
  apiError(409, 'DUPLICATE', `Another one already has this ${field}`, { field });

type HeadRow = Prisma.FeeHeadGetPayload<object>;

export function toHeadView(h: HeadRow): FeeHeadView {
  return {
    id: h.id,
    nameBn: h.nameBn,
    nameEn: h.nameEn,
    kind: h.kind,
    frequency: h.frequency,
    dueDay: h.dueDay,
    dueOffsetDays: h.dueOffsetDays,
    oneTimeFrom: h.oneTimeFrom ? dateFromDb(h.oneTimeFrom) : null,
    fine: { type: h.fineType, amountPaisa: h.fineAmountPaisa, capPaisa: h.fineCapPaisa },
    siblingEligible: h.siblingEligible,
    isActive: h.isActive,
    sortOrder: h.sortOrder,
  };
}

const toTermView = (t: Prisma.FeeTermGetPayload<object>): FeeTermView => ({
  id: t.id,
  academicYearId: t.academicYearId,
  nameBn: t.nameBn,
  nameEn: t.nameEn,
  opensOn: dateFromDb(t.opensOn),
  dueDate: dateFromDb(t.dueDate),
  sortOrder: t.sortOrder,
});

const concessionInclude = {
  student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
  feeHead: { select: { id: true, nameBn: true, nameEn: true } },
} as const;

const toConcessionView = (
  c: Prisma.FeeConcessionGetPayload<{ include: typeof concessionInclude }>,
): FeeConcessionView => ({
  id: c.id,
  student: c.student,
  feeHead: c.feeHead,
  academicYearId: c.academicYearId,
  category: c.category,
  type: c.type,
  value: c.value,
  reason: c.reason,
  validFrom: dateFromDb(c.validFrom),
  endedOn: c.endedOn ? dateFromDb(c.endedOn) : null,
  endedReason: c.endedReason,
  createdAt: c.createdAt.toISOString(),
});

/**
 * Fee setup (OWNER/ADMIN, docs/fees.md): settings, heads, terms, amounts and concessions.
 * Every write goes through the request transaction and is audited. Uniqueness and references
 * are checked before writing: a constraint error would abort the whole request transaction.
 */
@Injectable()
export class FeeSetupService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly dues: FeeDuesService,
  ) {}

  private get tenantId(): string {
    return this.context.requireTenantId();
  }

  /** The year asked for, or the current one; 404 / 422 NO_CURRENT_YEAR. */
  async year(id?: string): Promise<{ id: string; name: string; startDate: Date; endDate: Date }> {
    const year = await this.db.tx.academicYear.findFirst({
      where: id ? { id } : { isCurrent: true },
      select: { id: true, name: true, startDate: true, endDate: true },
    });
    if (year) return year;
    if (id) throw new NotFoundException('Academic year not found');
    throw apiError(422, 'NO_CURRENT_YEAR', 'Set a current academic year first');
  }

  // ─────────────────────────── Settings ───────────────────────────

  async settings(): Promise<FeeSettingsView> {
    const row = await this.db.tx.feeSettings.findFirst();
    if (!row) return DEFAULT_SETTINGS;
    return {
      duesFrom: row.duesFrom ? dateFromDb(row.duesFrom) : null,
      receiptSmsEnabled: row.receiptSmsEnabled,
      sibling:
        row.siblingDiscountType && row.siblingDiscountValue !== null
          ? {
              type: row.siblingDiscountType,
              value: row.siblingDiscountValue,
              fromChild: row.siblingFromChild,
            }
          : null,
      receiptNote: row.receiptNote,
      saved: true,
    };
  }

  async saveSettings(input: SettingsInput): Promise<FeeSettingsView> {
    const before = await this.settings();
    const data = {
      duesFrom: input.duesFrom ? dateToDb(input.duesFrom) : null,
      receiptSmsEnabled: input.receiptSmsEnabled,
      siblingDiscountType: input.sibling?.type ?? null,
      siblingDiscountValue: input.sibling?.value ?? null,
      siblingFromChild: input.sibling?.fromChild ?? 2,
      receiptNote: input.receiptNote,
    };
    const row = await this.db.tx.feeSettings.upsert({
      where: { tenantId: this.tenantId },
      create: { tenantId: this.tenantId, ...data },
      update: data,
      select: { id: true },
    });
    const after = await this.settings();
    await this.dues.markTenant();
    await this.audit.record({
      entity: 'fee_settings',
      entityId: row.id,
      action: before.saved ? 'UPDATE' : 'CREATE',
      oldValues: before.saved ? { ...before } : undefined,
      newValues: { ...after },
    });
    return after;
  }

  // ─────────────────────────── Heads ───────────────────────────

  async listHeads(): Promise<FeeHeadView[]> {
    const rows = await this.db.tx.feeHead.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameBn: 'asc' }],
    });
    return rows.map(toHeadView);
  }

  private async activeNameTaken(nameBn: string, exceptId?: string): Promise<boolean> {
    const row = await this.db.tx.feeHead.findFirst({
      where: { nameBn, isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  private headData(head: Omit<FeeHeadView, 'id' | 'isActive'>) {
    return {
      nameBn: head.nameBn,
      nameEn: head.nameEn,
      kind: head.kind,
      frequency: head.frequency,
      dueDay: head.dueDay,
      dueOffsetDays: head.dueOffsetDays,
      oneTimeFrom: head.oneTimeFrom ? dateToDb(head.oneTimeFrom) : null,
      fineType: head.fine.type,
      fineAmountPaisa: head.fine.amountPaisa,
      fineCapPaisa: head.fine.capPaisa,
      siblingEligible: head.siblingEligible,
      sortOrder: head.sortOrder,
    };
  }

  async createHead(input: HeadCreate): Promise<FeeHeadView> {
    if (await this.activeNameTaken(input.nameBn)) throw duplicate('nameBn');
    const { head } = normalizeFeeHead(input);
    const row = await this.db.tx.feeHead.create({
      data: { tenantId: this.tenantId, ...this.headData(head) },
    });
    const view = toHeadView(row);
    await this.audit.record({
      entity: 'fee_head',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...view },
    });
    return view;
  }

  async updateHead(id: string, patch: HeadUpdate): Promise<FeeHeadView> {
    const row = await this.db.tx.feeHead.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Fee head not found');
    const before = toHeadView(row);
    const merged = { ...before, ...patch, fine: patch.fine ?? before.fine };
    const { head, problems } = normalizeFeeHead(merged);
    if (problems.length > 0) {
      throw apiError(422, 'INVALID_HEAD', 'This change leaves the fee head incomplete', {
        fields: problems,
      });
    }
    if (head.isActive && (await this.activeNameTaken(head.nameBn, id))) throw duplicate('nameBn');
    const updated = await this.db.tx.feeHead.update({
      where: { id },
      data: { ...this.headData(head), isActive: head.isActive },
    });
    const view = toHeadView(updated);
    await this.audit.record({
      entity: 'fee_head',
      entityId: id,
      action: 'UPDATE',
      oldValues: { ...before },
      newValues: { ...view },
    });
    return view;
  }

  // ─────────────────────────── Terms ───────────────────────────

  async listTerms(academicYearId?: string): Promise<FeeTermView[]> {
    const year = await this.year(academicYearId);
    const rows = await this.db.tx.feeTerm.findMany({
      where: { academicYearId: year.id },
      orderBy: [{ sortOrder: 'asc' }, { dueDate: 'asc' }],
    });
    return rows.map(toTermView);
  }

  private async termNameTaken(yearId: string, nameBn: string, exceptId?: string) {
    const row = await this.db.tx.feeTerm.findFirst({
      where: { academicYearId: yearId, nameBn, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  async createTerm(input: TermCreate): Promise<FeeTermView> {
    const year = await this.year(input.academicYearId);
    if (await this.termNameTaken(year.id, input.nameBn)) throw duplicate('nameBn');
    const row = await this.db.tx.feeTerm.create({
      data: {
        tenantId: this.tenantId,
        academicYearId: year.id,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        opensOn: dateToDb(input.opensOn),
        dueDate: dateToDb(input.dueDate),
        sortOrder: input.sortOrder,
      },
    });
    const view = toTermView(row);
    await this.audit.record({
      entity: 'fee_term',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...view },
    });
    return view;
  }

  async updateTerm(id: string, patch: TermUpdate): Promise<FeeTermView> {
    const row = await this.db.tx.feeTerm.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Term not found');
    const before = toTermView(row);
    const merged = { ...before, ...patch };
    if (merged.dueDate < merged.opensOn) {
      throw apiError(422, 'INVALID_TERM', 'Due date must be on or after the opening date');
    }
    if (patch.nameBn && (await this.termNameTaken(row.academicYearId, patch.nameBn, id))) {
      throw duplicate('nameBn');
    }
    const updated = await this.db.tx.feeTerm.update({
      where: { id },
      data: {
        nameBn: merged.nameBn,
        nameEn: merged.nameEn,
        opensOn: dateToDb(merged.opensOn),
        dueDate: dateToDb(merged.dueDate),
        sortOrder: merged.sortOrder,
      },
    });
    const view = toTermView(updated);
    await this.audit.record({
      entity: 'fee_term',
      entityId: id,
      action: 'UPDATE',
      oldValues: { ...before },
      newValues: { ...view },
    });
    return view;
  }

  async deleteTerm(id: string): Promise<void> {
    const row = await this.db.tx.feeTerm.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Term not found');
    await this.db.tx.feeTerm.delete({ where: { id } });
    await this.audit.record({
      entity: 'fee_term',
      entityId: id,
      action: 'DELETE',
      oldValues: { ...toTermView(row) },
    });
  }

  // ─────────────────────────── Amounts ───────────────────────────

  async amounts(academicYearId?: string): Promise<FeeAmountsMatrix> {
    const tx = this.db.tx;
    const year = await this.year(academicYearId);
    const [heads, classLevels, studyGroups, rows] = await Promise.all([
      tx.feeHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameBn: 'asc' }] }),
      tx.classLevel.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, nameBn: true, nameEn: true, sortOrder: true },
      }),
      tx.studyGroup.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, nameBn: true, nameEn: true, sortOrder: true },
      }),
      tx.feeAmount.findMany({
        where: { academicYearId: year.id },
        select: { feeHeadId: true, classLevelId: true, studyGroupId: true, amountPaisa: true },
      }),
    ]);
    return {
      academicYear: { id: year.id, name: year.name },
      heads: heads.map(toHeadView),
      classLevels,
      studyGroups,
      amounts: rows,
    };
  }

  /** 404 unless every head, class level and study group belongs to this institute. */
  private async assertRefs(
    rows: { feeHeadId: string; classLevelId: string; studyGroupId: string | null }[],
  ) {
    const tx = this.db.tx;
    const unique = (ids: (string | null)[]) => [...new Set(ids.filter((v): v is string => !!v))];
    const heads = unique(rows.map((r) => r.feeHeadId));
    const classes = unique(rows.map((r) => r.classLevelId));
    const groups = unique(rows.map((r) => r.studyGroupId));
    const [h, c, g] = await Promise.all([
      tx.feeHead.count({ where: { id: { in: heads } } }),
      tx.classLevel.count({ where: { id: { in: classes } } }),
      tx.studyGroup.count({ where: { id: { in: groups } } }),
    ]);
    if (h !== heads.length || c !== classes.length || g !== groups.length) {
      throw new NotFoundException('Fee head, class or study group not found');
    }
  }

  async setAmounts(input: AmountsInput): Promise<FeeAmountsMatrix> {
    const tx = this.db.tx;
    const year = await this.year(input.academicYearId);
    await this.assertRefs(input.amounts);
    const key = (r: { feeHeadId: string; classLevelId: string; studyGroupId: string | null }) =>
      `${r.feeHeadId}|${r.classLevelId}|${r.studyGroupId ?? ''}`;
    const existing = new Map(
      (await tx.feeAmount.findMany({ where: { academicYearId: year.id } })).map((r) => [key(r), r]),
    );
    const changes: {
      feeHeadId: string;
      classLevelId: string;
      studyGroupId: string | null;
      from: number | null;
      to: number | null;
    }[] = [];
    for (const row of input.amounts) {
      const current = existing.get(key(row));
      const from = current?.amountPaisa ?? null;
      if (from === row.amountPaisa) continue;
      if (row.amountPaisa === null) {
        await tx.feeAmount.delete({ where: { id: current!.id } });
      } else if (current) {
        await tx.feeAmount.update({
          where: { id: current.id },
          data: { amountPaisa: row.amountPaisa },
        });
      } else {
        await tx.feeAmount.create({
          data: {
            tenantId: this.tenantId,
            academicYearId: year.id,
            feeHeadId: row.feeHeadId,
            classLevelId: row.classLevelId,
            studyGroupId: row.studyGroupId,
            amountPaisa: row.amountPaisa,
          },
        });
      }
      changes.push({ ...row, from, to: row.amountPaisa });
    }
    if (changes.length > 0) {
      await this.audit.record({
        entity: 'fee_amounts',
        entityId: year.id,
        action: 'UPDATE',
        oldValues: { changes: changes.map(({ from, ...r }) => ({ ...r, amountPaisa: from })) },
        newValues: { changes: changes.map(({ to, ...r }) => ({ ...r, amountPaisa: to })) },
      });
    }
    return this.amounts(year.id);
  }

  async copyAmounts(input: CopyInput): Promise<{ copied: number }> {
    const tx = this.db.tx;
    const from = await this.year(input.fromAcademicYearId);
    const to = await this.year(input.toAcademicYearId);
    const key = (r: { feeHeadId: string; classLevelId: string; studyGroupId: string | null }) =>
      `${r.feeHeadId}|${r.classLevelId}|${r.studyGroupId ?? ''}`;
    const taken = new Set(
      (await tx.feeAmount.findMany({ where: { academicYearId: to.id } })).map(key),
    );
    const source = await tx.feeAmount.findMany({ where: { academicYearId: from.id } });
    const missing = source.filter((r) => !taken.has(key(r)));
    if (missing.length > 0) {
      await tx.feeAmount.createMany({
        data: missing.map((r) => ({
          tenantId: this.tenantId,
          academicYearId: to.id,
          feeHeadId: r.feeHeadId,
          classLevelId: r.classLevelId,
          studyGroupId: r.studyGroupId,
          amountPaisa: r.amountPaisa,
        })),
      });
      await this.audit.record({
        entity: 'fee_amounts',
        entityId: to.id,
        action: 'CREATE',
        newValues: { copiedFrom: from.id, copied: missing.length },
      });
    }
    return { copied: missing.length };
  }

  // ─────────────────────────── Concessions ───────────────────────────

  async listConcessions(query: {
    studentId?: string;
    academicYearId?: string;
  }): Promise<FeeConcessionView[]> {
    const year = await this.year(query.academicYearId);
    const rows = await this.db.tx.feeConcession.findMany({
      where: {
        academicYearId: year.id,
        ...(query.studentId ? { studentId: query.studentId } : {}),
      },
      include: concessionInclude,
      orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toConcessionView);
  }

  async createConcession(input: ConcessionCreate): Promise<FeeConcessionView> {
    const tx = this.db.tx;
    const [student, head, year] = await Promise.all([
      tx.student.findFirst({
        where: { id: input.studentId, deletedAt: null },
        select: { id: true },
      }),
      tx.feeHead.findUnique({ where: { id: input.feeHeadId }, select: { id: true } }),
      this.year(input.academicYearId),
    ]);
    if (!student) throw new NotFoundException('Student not found');
    if (!head) throw new NotFoundException('Fee head not found');
    // Concessions never overlap on one head: an open one, or one ending after this one starts.
    const overlapping = await tx.feeConcession.findFirst({
      where: {
        studentId: student.id,
        feeHeadId: head.id,
        academicYearId: year.id,
        OR: [{ endedOn: null }, { endedOn: { gt: dateToDb(input.validFrom) } }],
      },
      select: { id: true },
    });
    if (overlapping) {
      throw apiError(
        409,
        'CONCESSION_OVERLAP',
        'This student already has a concession on this fee then',
        {
          concessionId: overlapping.id,
        },
      );
    }
    const row = await tx.feeConcession.create({
      data: {
        tenantId: this.tenantId,
        studentId: student.id,
        feeHeadId: head.id,
        academicYearId: year.id,
        category: input.category,
        type: input.type,
        value: input.value!,
        reason: input.reason,
        validFrom: dateToDb(input.validFrom),
        createdById: this.context.requirePrincipal().userId,
      },
      include: concessionInclude,
    });
    const view = toConcessionView(row);
    await this.audit.record({
      entity: 'fee_concession',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...view, student: view.student.id, feeHead: view.feeHead.id },
    });
    return view;
  }

  async endConcession(id: string, input: ConcessionEnd): Promise<FeeConcessionView> {
    const tx = this.db.tx;
    const row = await tx.feeConcession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Concession not found');
    if (row.endedOn) throw apiError(409, 'ALREADY_ENDED', 'This concession has already ended');
    const validFrom: IsoDate = dateFromDb(row.validFrom);
    if (input.endedOn < validFrom) {
      throw apiError(
        422,
        'INVALID_END',
        'To cancel a concession that has not started, end it on its start date',
      );
    }
    const updated = await tx.feeConcession.update({
      where: { id },
      data: {
        endedOn: dateToDb(input.endedOn),
        endedById: this.context.requirePrincipal().userId,
        endedReason: input.reason,
      },
      include: concessionInclude,
    });
    await this.audit.record({
      entity: 'fee_concession',
      entityId: id,
      action: 'UPDATE',
      oldValues: { endedOn: null },
      newValues: { endedOn: input.endedOn, reason: input.reason },
    });
    return toConcessionView(updated);
  }
}
