import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  dateToDb,
  planStudentDues,
  siblingRanks,
  todayIn,
  type ConcessionRule,
  type IsoDate,
  type PlanAmount,
  type PlanHead,
  type PlannedDue,
  type PeriodTerm,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { REDIS } from '../../redis/redis.constants.js';
import { Db } from '../../tenancy/db.service.js';
import { lockStudentFees, lockTenantFees } from '../fee-locks.js';

export const FEES_QUEUE = 'fees';
export const GENERATE_DUES_JOB = 'generate-dues';
/** Institutes that use fees (ZSET, score = last seen): the nightly run visits only these. */
export const FEES_TENANTS_KEY = 'fees:tenants';
const ensuredKey = (tenantId: string, today: IsoDate) => `fees:ensured:${tenantId}:${today}`;
const CHUNK = 500;

/** Everything the dues plan needs about an institute, loaded once per run. */
export interface PlanContext {
  today: IsoDate;
  timezone: string;
  duesFrom: IsoDate | null;
  sibling: (ConcessionRule & { fromChild: number }) | null;
  year: { id: string; startDate: IsoDate; endDate: IsoDate } | null;
  heads: PlanHead[];
  terms: PeriodTerm[];
  amounts: PlanAmount[];
}

export interface PlannedForStudent {
  studentId: string;
  dues: PlannedDue[];
}

/**
 * Dues (docs/fees.md → Dues): generated from the setup by the shared plan, idempotently
 * (INSERT … ON CONFLICT DO NOTHING on student + head + year + period), so a due is never created
 * twice. Correctness never depends on the nightly job: the ledger, the counter and the guardian
 * view generate a student's dues when they are looked at, and reports generate the institute's
 * once a day. Cached totals are written only by `recomputeDues`.
 */
@Injectable()
export class FeeDuesService implements OnModuleInit {
  constructor(
    @InjectQueue(FEES_QUEUE) private readonly queue: Queue,
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** One scheduler for all API instances (BullMQ upserts it by id). */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      GENERATE_DUES_JOB,
      { pattern: '30 0 * * *', tz: 'Asia/Dhaka' },
      { name: GENERATE_DUES_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  /** List the institute for the nightly run (after commit; a lost list heals on the next use). */
  async markTenant(): Promise<void> {
    const tenantId = this.context.requireTenantId();
    await this.context.afterCommit(() => this.redis.zadd(FEES_TENANTS_KEY, Date.now(), tenantId));
  }

  async planContext(): Promise<PlanContext> {
    const tx = this.db.tx;
    const [tenant, settings, year] = await Promise.all([
      tx.tenant.findFirstOrThrow({ select: { timezone: true } }),
      tx.feeSettings.findFirst(),
      tx.academicYear.findFirst({
        where: { isCurrent: true },
        select: { id: true, startDate: true, endDate: true },
      }),
    ]);
    const [heads, terms, amounts] = await Promise.all([
      tx.feeHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameBn: 'asc' }] }),
      year ? tx.feeTerm.findMany({ where: { academicYearId: year.id } }) : [],
      year
        ? tx.feeAmount.findMany({
            where: { academicYearId: year.id },
            select: { feeHeadId: true, classLevelId: true, studyGroupId: true, amountPaisa: true },
          })
        : [],
    ]);
    return {
      today: todayIn(tenant.timezone),
      timezone: tenant.timezone,
      duesFrom: settings?.duesFrom ? dateFromDb(settings.duesFrom) : null,
      sibling:
        settings?.siblingDiscountType && settings.siblingDiscountValue !== null
          ? {
              type: settings.siblingDiscountType,
              value: settings.siblingDiscountValue,
              fromChild: settings.siblingFromChild,
            }
          : null,
      year: year
        ? { id: year.id, startDate: dateFromDb(year.startDate), endDate: dateFromDb(year.endDate) }
        : null,
      heads: heads.map((h) => ({
        id: h.id,
        frequency: h.frequency,
        dueDay: h.dueDay,
        dueOffsetDays: h.dueOffsetDays,
        oneTimeFrom: h.oneTimeFrom ? dateFromDb(h.oneTimeFrom) : null,
        siblingEligible: h.siblingEligible,
        isActive: h.isActive,
        fine: { type: h.fineType, amountPaisa: h.fineAmountPaisa, capPaisa: h.fineCapPaisa },
      })),
      terms: terms.map((t) => ({
        id: t.id,
        opensOn: dateFromDb(t.opensOn),
        dueDate: dateFromDb(t.dueDate),
      })),
      amounts,
    };
  }

  /** Ranks inside confirmed families, for these students (missing = in no family). */
  async ranksFor(studentIds: string[], yearId: string): Promise<Map<string, number>> {
    const members = await this.db.tx.feeSiblingMember.findMany({
      where: {
        removedAt: null,
        group: { members: { some: { studentId: { in: studentIds }, removedAt: null } } },
      },
      select: {
        groupId: true,
        studentId: true,
        student: {
          select: {
            createdAt: true,
            enrolments: {
              where: { academicYearId: yearId },
              select: { classLevel: { select: { sortOrder: true } } },
            },
          },
        },
      },
    });
    const groups = new Map<string, typeof members>();
    for (const m of members) groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), m]);
    const ranks = new Map<string, number>();
    for (const group of groups.values()) {
      if (group.length < 2) continue; // a family of one is no family
      const ranked = siblingRanks(
        group.map((m) => ({
          studentId: m.studentId,
          classSortOrder: m.student.enrolments[0]?.classLevel.sortOrder ?? -1,
          admittedAt: m.student.createdAt,
        })),
      );
      for (const [id, rank] of ranked) ranks.set(id, rank);
    }
    return ranks;
  }

  /** The planned dues of these students (current year), as of today or up to `upTo`. */
  async plan(
    studentIds: string[],
    ctx: PlanContext,
    upTo: IsoDate | null = null,
  ): Promise<PlannedForStudent[]> {
    if (!ctx.year || !ctx.duesFrom || studentIds.length === 0) return [];
    const tx = this.db.tx;
    const year = ctx.year;
    const [students, concessions, ranks] = await Promise.all([
      tx.student.findMany({
        where: {
          id: { in: studentIds },
          deletedAt: null,
          status: 'ACTIVE',
          enrolments: { some: { academicYearId: year.id } },
        },
        select: {
          id: true,
          createdAt: true,
          enrolments: {
            where: { academicYearId: year.id },
            select: { classLevelId: true, studyGroupId: true },
          },
        },
      }),
      tx.feeConcession.findMany({
        where: { studentId: { in: studentIds }, academicYearId: year.id },
      }),
      this.ranksFor(studentIds, year.id),
    ]);
    return students.map((s) => ({
      studentId: s.id,
      dues: planStudentDues({
        asOf: ctx.today,
        upTo,
        duesFrom: ctx.duesFrom,
        sibling: ctx.sibling,
        year,
        heads: ctx.heads,
        terms: ctx.terms,
        amounts: ctx.amounts,
        student: {
          id: s.id,
          admittedOn: todayIn(ctx.timezone, s.createdAt),
          classLevelId: s.enrolments[0]!.classLevelId,
          studyGroupId: s.enrolments[0]!.studyGroupId,
          siblingRank: ranks.get(s.id) ?? null,
        },
        concessions: concessions
          .filter((c) => c.studentId === s.id)
          .map((c) => ({
            id: c.id,
            feeHeadId: c.feeHeadId,
            type: c.type,
            value: c.value,
            validFrom: dateFromDb(c.validFrom),
            endedOn: c.endedOn ? dateFromDb(c.endedOn) : null,
          })),
      }),
    }));
  }

  private toRow(tenantId: string, yearId: string, studentId: string, d: PlannedDue) {
    return {
      tenantId,
      studentId,
      feeHeadId: d.feeHeadId,
      academicYearId: yearId,
      periodKey: d.periodKey,
      feeTermId: d.termId,
      periodStart: dateToDb(d.periodStart),
      dueDate: dateToDb(d.dueDate),
      amountPaisa: d.amountPaisa,
      concessionPaisa: d.concessionPaisa,
      concessionSource: d.concessionSource,
      concessionId: d.concessionId,
      fineType: d.fine.type,
      fineAmountPaisa: d.fine.amountPaisa,
      fineCapPaisa: d.fine.capPaisa,
    } satisfies Prisma.FeeDueCreateManyInput;
  }

  /**
   * Create the dues these students should have by today (or up to `upTo` when paying ahead).
   * Idempotent: existing (and cancelled) dues are left alone. Returns how many were created.
   */
  async ensureForStudents(
    studentIds: string[],
    opts: { upTo?: IsoDate | null; ctx?: PlanContext; trigger?: string } = {},
  ): Promise<number> {
    const ctx = opts.ctx ?? (await this.planContext());
    if (!ctx.year) return 0;
    const tenantId = this.context.requireTenantId();
    const planned = await this.plan(studentIds, ctx, opts.upTo ?? null);
    const rows = planned.flatMap((p) =>
      p.dues.map((d) => this.toRow(tenantId, ctx.year!.id, p.studentId, d)),
    );
    let created = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const res = await this.db.tx.feeDue.createMany({
        data: rows.slice(i, i + 1000),
        skipDuplicates: true,
      });
      created += res.count;
    }
    if (created > 0) {
      await this.audit.record({
        entity: 'fee_dues_run',
        entityId: randomUUID(),
        action: 'CREATE',
        newValues: { created, students: studentIds.length, trigger: opts.trigger ?? 'view' },
      });
      await this.markTenant();
    }
    return created;
  }

  /** Active students enrolled in the current year (the nightly run works through them). */
  async activeStudentIds(): Promise<string[]> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    if (!year) return [];
    const rows = await tx.student.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        enrolments: { some: { academicYearId: year.id } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Is this institute running (ACTIVE or TRIAL)? Suspended institutes get no new dues. */
  async tenantIsLive(): Promise<boolean> {
    const tenant = await this.db.tx.tenant.findFirst({ select: { status: true } });
    return tenant?.status === 'ACTIVE' || tenant?.status === 'TRIAL';
  }

  /** All of the institute's dues up to today (one transaction; for "generate now"). */
  async ensureForTenant(trigger = 'admin'): Promise<number> {
    const ctx = await this.planContext();
    const ids = await this.activeStudentIds();
    let created = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      created += await this.ensureForStudents(ids.slice(i, i + CHUNK), { ctx, trigger });
    }
    await this.markTenant();
    return created;
  }

  /**
   * Before reports, reminders and the dashboard: the institute's dues once a day. A lost Redis
   * key only means one more (idempotent) run.
   */
  async ensureTenantToday(): Promise<void> {
    const tenantId = this.context.requireTenantId();
    const ctx = await this.planContext();
    const key = ensuredKey(tenantId, ctx.today);
    if (await this.redis.exists(key)) return;
    await this.ensureForTenant('daily');
    await this.context.afterCommit(() => this.redis.set(key, '1', 'EX', 2 * 86_400));
  }

  // ─────────────────────────── Admin corrections ───────────────────────────

  /**
   * Rewrite unpaid, untouched dues (nothing paid, no fine waived) of the current year from
   * today's setup: amount, concession and fine rule. The due date and the period never change.
   */
  async recalculateUnpaid(studentIds?: string[]): Promise<{ updated: number }> {
    const tx = this.db.tx;
    await lockTenantFees(tx, 'exclusive');
    const ctx = await this.planContext();
    if (!ctx.year) return { updated: 0 };
    const dues = await tx.feeDue.findMany({
      where: {
        academicYearId: ctx.year.id,
        status: 'OPEN',
        paidPrincipalPaisa: 0,
        paidFinePaisa: 0,
        fineWaivedPaisa: 0,
        fineWaivedAll: false,
        ...(studentIds ? { studentId: { in: studentIds } } : {}),
      },
    });
    const affected = [...new Set(dues.map((d) => d.studentId))];
    const planned = new Map<string, PlannedDue>();
    for (let i = 0; i < affected.length; i += CHUNK) {
      for (const p of await this.plan(affected.slice(i, i + CHUNK), ctx, ctx.year.endDate)) {
        for (const d of p.dues) planned.set(`${p.studentId}|${d.feeHeadId}|${d.periodKey}`, d);
      }
    }
    let updated = 0;
    for (const due of dues) {
      const p = planned.get(`${due.studentId}|${due.feeHeadId}|${due.periodKey}`);
      if (!p) continue; // no longer charged: an admin cancels it if needed
      const same =
        p.amountPaisa === due.amountPaisa &&
        p.concessionPaisa === due.concessionPaisa &&
        p.concessionSource === due.concessionSource &&
        p.concessionId === due.concessionId &&
        p.fine.type === due.fineType &&
        p.fine.amountPaisa === due.fineAmountPaisa &&
        p.fine.capPaisa === due.fineCapPaisa;
      if (same) continue;
      await tx.feeDue.update({
        where: { id: due.id },
        data: {
          amountPaisa: p.amountPaisa,
          concessionPaisa: p.concessionPaisa,
          concessionSource: p.concessionSource,
          concessionId: p.concessionId,
          fineType: p.fine.type,
          fineAmountPaisa: p.fine.amountPaisa,
          fineCapPaisa: p.fine.capPaisa,
        },
      });
      updated++;
    }
    await this.audit.record({
      entity: 'fee_dues_recalculation',
      entityId: randomUUID(),
      action: 'UPDATE',
      newValues: { updated, students: studentIds ?? 'all' },
    });
    return { updated };
  }

  private async openDue(id: string) {
    const due = await this.db.tx.feeDue.findUnique({ where: { id } });
    if (!due) throw new NotFoundException('Due not found');
    await lockStudentFees(this.db.tx, due.studentId);
    // Re-read under the student's lock: a payment may have just changed it.
    return this.db.tx.feeDue.findUniqueOrThrow({ where: { id } });
  }

  async cancelDue(id: string, reason: string): Promise<void> {
    const due = await this.openDue(id);
    if (due.status === 'CANCELLED')
      throw apiError(409, 'ALREADY_CANCELLED', 'This due is already cancelled');
    if (due.paidPrincipalPaisa > 0 || due.paidFinePaisa > 0) {
      throw apiError(409, 'DUE_PAID', 'Something was paid on this due: void the payment first');
    }
    await this.db.tx.feeDue.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: this.context.requirePrincipal().userId,
        cancelReason: reason,
      },
    });
    await this.audit.record({
      entity: 'fee_due',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'OPEN' },
      newValues: { status: 'CANCELLED', reason },
    });
  }

  async waiveFine(
    id: string,
    input: { amountPaisa: number | null; reason: string },
  ): Promise<void> {
    const due = await this.openDue(id);
    if (due.status === 'CANCELLED')
      throw apiError(409, 'ALREADY_CANCELLED', 'This due is cancelled');
    await this.db.tx.feeFineWaiver.create({
      data: {
        tenantId: this.context.requireTenantId(),
        dueId: id,
        studentId: due.studentId,
        amountPaisa: input.amountPaisa,
        reason: input.reason,
        createdById: this.context.requirePrincipal().userId,
      },
    });
    await this.recomputeDues([id]);
    await this.audit.record({
      entity: 'fee_due',
      entityId: id,
      action: 'UPDATE',
      oldValues: { fineWaivedPaisa: due.fineWaivedPaisa, fineWaivedAll: due.fineWaivedAll },
      newValues: { waived: input.amountPaisa ?? 'ALL', reason: input.reason },
    });
  }

  /**
   * The only writer of the cached totals, re-derived from scratch (never incremented): paid
   * principal and fine from the allocations of payments that are not void, the day the principal
   * was cleared (the payer's date of the payment that completed it, so the fine stops there;
   * a void reopens it), and the waived fine. Call with the student's lock held.
   */
  async recomputeDues(dueIds: string[]): Promise<void> {
    const tx = this.db.tx;
    for (const id of [...new Set(dueIds)]) {
      const due = await tx.feeDue.findUniqueOrThrow({
        where: { id },
        select: { amountPaisa: true, concessionPaisa: true },
      });
      const [allocations, waivers] = await Promise.all([
        tx.feePaymentAllocation.findMany({
          where: { dueId: id, payment: { status: 'ACTIVE' } },
          select: {
            principalPaisa: true,
            finePaisa: true,
            payment: { select: { paidOn: true, createdAt: true } },
          },
        }),
        tx.feeFineWaiver.findMany({ where: { dueId: id }, select: { amountPaisa: true } }),
      ]);
      allocations.sort(
        (a, b) =>
          a.payment.paidOn.getTime() - b.payment.paidOn.getTime() ||
          a.payment.createdAt.getTime() - b.payment.createdAt.getTime(),
      );
      const net = due.amountPaisa - due.concessionPaisa;
      let principal = 0;
      let clearedOn: Date | null = null;
      for (const a of allocations) {
        principal += a.principalPaisa;
        if (clearedOn === null && net > 0 && principal >= net) clearedOn = a.payment.paidOn;
      }
      await tx.feeDue.update({
        where: { id },
        data: {
          paidPrincipalPaisa: principal,
          paidFinePaisa: allocations.reduce((sum, a) => sum + a.finePaisa, 0),
          principalClearedOn: clearedOn,
          fineWaivedPaisa: waivers.reduce((sum, w) => sum + (w.amountPaisa ?? 0), 0),
          fineWaivedAll: waivers.some((w) => w.amountPaisa === null),
        },
      });
    }
  }

  /**
   * Paying ahead: create exactly these future periods (head + period key from the ledger's
   * upcoming list) for this student, and return their ids. 422 for a period the student does
   * not have this year.
   */
  async ensureAdvance(
    studentId: string,
    periods: { headId: string; periodKey: string }[],
    ctx: PlanContext,
  ): Promise<string[]> {
    if (periods.length === 0) return [];
    if (!ctx.year) throw apiError(422, 'NO_CURRENT_YEAR', 'Set a current academic year first');
    const wanted = new Set(periods.map((p) => `${p.headId}|${p.periodKey}`));
    const [planned] = await this.plan([studentId], ctx, ctx.year.endDate);
    const rows = (planned?.dues ?? []).filter((d) => wanted.has(`${d.feeHeadId}|${d.periodKey}`));
    if (rows.length !== wanted.size) {
      throw apiError(422, 'INVALID_ADVANCE', 'This period cannot be paid for this student');
    }
    const tenantId = this.context.requireTenantId();
    await this.db.tx.feeDue.createMany({
      data: rows.map((d) => this.toRow(tenantId, ctx.year!.id, studentId, d)),
      skipDuplicates: true,
    });
    const found = await this.db.tx.feeDue.findMany({
      where: {
        studentId,
        academicYearId: ctx.year.id,
        OR: periods.map((p) => ({ feeHeadId: p.headId, periodKey: p.periodKey })),
      },
      select: { id: true },
    });
    return found.map((f) => f.id);
  }
}
