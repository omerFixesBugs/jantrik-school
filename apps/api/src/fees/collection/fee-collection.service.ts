import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  allocate,
  dateFromDb,
  dateToDb,
  dueBalance,
  formatDate,
  maskPhone,
  receiptNumber,
  receiptSmsText,
  todayIn,
  type FeeClosing,
  type FeeClosingCollector,
  type FeePaymentMethod,
  type FeeReceipt,
  type IsoDate,
} from '@jantrik/shared';
import type { z } from 'zod';
import type { collectFeeSchema } from '@jantrik/shared';
import { AttendanceSettingsService } from '../../attendance/attendance-settings.service.js';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { TenantSmsService } from '../../sms/tenant-sms.service.js';
import { staffNames, staffRef } from '../../staff/staff.module.js';
import { Db } from '../../tenancy/db.service.js';
import { TenantAccessService } from '../../tenancy/tenant-access.service.js';
import { FeeDuesService } from '../dues/fee-dues.service.js';
import { lockStudentFees, lockTenantFees } from '../fee-locks.js';

type CollectInput = z.output<typeof collectFeeSchema>;

const paymentInclude = {
  student: {
    select: {
      id: true,
      studentCode: true,
      nameBn: true,
      nameEn: true,
      guardians: {
        where: { isPrimary: true },
        select: { guardian: { select: { phone: true } } },
      },
    },
  },
  allocations: {
    include: {
      due: {
        select: {
          id: true,
          periodKey: true,
          dueDate: true,
          feeHead: { select: { nameBn: true, nameEn: true, sortOrder: true } },
          feeTerm: { select: { nameBn: true, nameEn: true } },
        },
      },
    },
  },
} as const;
type PaymentRow = Prisma.FeePaymentGetPayload<{ include: typeof paymentInclude }>;
export type DueRow = Prisma.FeeDueGetPayload<{
  include: { feeHead: { select: { sortOrder: true } } };
}>;

const METHOD_ORDER: FeePaymentMethod[] = ['CASH', 'BKASH', 'NAGAD'];

/**
 * The fee counter (docs/fees.md → Collection): cash for one or several dues of one student,
 * partial payments allowed, a receipt number per tenant and calendar year with no gaps, the
 * receipt SMS after commit, voids (OWNER/ADMIN) and the daily closing per collector.
 *
 * Locks (fee-locks.ts): the tenant's fee lock (shared), then the student's, then the receipt
 * counter row, then the SMS lock. Every writer of a student's dues holds the student's lock, so
 * the dues read here cannot change before this transaction commits.
 */
@Injectable()
export class FeeCollectionService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly dues: FeeDuesService,
    private readonly sms: TenantSmsService,
    private readonly smsCap: AttendanceSettingsService,
    private readonly access: TenantAccessService,
  ) {}

  /** A receipt SMS goes out only while its payment is still valid (a void cancels it). */
  onModuleInit(): void {
    this.sms.registerRelevanceCheck('FEE_RECEIPT', async ({ relatedId }) => {
      if (!relatedId) return false;
      const payment = await this.db.tx.feePayment.findUnique({
        where: { id: relatedId },
        select: { status: true },
      });
      return payment?.status === 'ACTIVE';
    });
  }

  /** The next receipt number of the year: rolls back with the payment, so there are no gaps. */
  private async nextReceiptNo(year: number): Promise<number> {
    const [row] = await this.db.tx.$queryRaw<{ seq: number }[]>`
      INSERT INTO fee_receipt_counters (id, tenant_id, year, next_value, updated_at)
      VALUES (gen_random_uuid(), app_current_tenant_id(), ${year}, 2, now())
      ON CONFLICT (tenant_id, year)
        DO UPDATE SET next_value = fee_receipt_counters.next_value + 1, updated_at = now()
      RETURNING next_value - 1 AS seq`;
    return Number(row!.seq);
  }

  /** The student's balance today over every open due. */
  async balanceToday(studentId: string, today: IsoDate): Promise<number> {
    const rows = await this.db.tx.feeDue.findMany({ where: { studentId, status: 'OPEN' } });
    return rows.reduce((sum, d) => sum + dueBalance(this.balanceInput(d), today).total, 0);
  }

  private balanceInput(d: Prisma.FeeDueGetPayload<object>) {
    return {
      status: d.status,
      amountPaisa: d.amountPaisa,
      concessionPaisa: d.concessionPaisa,
      paidPrincipalPaisa: d.paidPrincipalPaisa,
      paidFinePaisa: d.paidFinePaisa,
      principalClearedOn: d.principalClearedOn ? dateFromDb(d.principalClearedOn) : null,
      dueDate: dateFromDb(d.dueDate),
      fine: { type: d.fineType, amountPaisa: d.fineAmountPaisa, capPaisa: d.fineCapPaisa },
      fineWaivedPaisa: d.fineWaivedPaisa,
      fineWaivedAll: d.fineWaivedAll,
    };
  }

  async collect(input: CollectInput): Promise<FeeReceipt> {
    const tx = this.db.tx;
    const student = await tx.student.findFirst({
      where: { id: input.studentId, deletedAt: null },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, student.id);

    // A retry of a request that already succeeded gets the same receipt (checked under the lock).
    const replay = await this.replay(input.clientRequestId, student.id, input.amountPaisa);
    if (replay) return replay;

    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([student.id], { ctx });
    const advanceIds = await this.dues.ensureAdvance(student.id, input.advance, ctx);
    const rows = await this.openDues(student.id, [...input.dueIds, ...advanceIds]);
    const outstanding = this.outstanding(rows, ctx.today);
    if (outstanding !== input.expectedOutstandingPaisa) {
      throw apiError(409, 'DUES_CHANGED', 'These dues changed: check the amount again', {
        outstandingPaisa: outstanding,
      });
    }
    const paymentId = await this.recordPayment({
      studentId: student.id,
      dues: rows,
      amountPaisa: input.amountPaisa,
      method: 'CASH',
      channel: 'COUNTER',
      trxId: null,
      senderPhone: null,
      paidOn: ctx.today,
      recordedOn: ctx.today,
      clientRequestId: input.clientRequestId,
    });
    return this.receipt(paymentId);
  }

  /** The receipt of an earlier request with this id, or null; 422 when it was another payment. */
  async replay(
    clientRequestId: string,
    studentId: string,
    amountPaisa: number,
  ): Promise<FeeReceipt | null> {
    const previous = await this.db.tx.feePayment.findFirst({
      where: { clientRequestId },
      select: { id: true, studentId: true, amountPaisa: true },
    });
    if (!previous) return null;
    if (previous.studentId !== studentId || previous.amountPaisa !== amountPaisa) {
      throw apiError(422, 'IDEMPOTENCY_MISMATCH', 'This request id was used for another payment');
    }
    return { ...(await this.receipt(previous.id)), replayed: true };
  }

  /** These dues of the student, all open (404 for anything else). */
  async openDues(studentId: string, ids: string[]): Promise<DueRow[]> {
    const unique = [...new Set(ids)];
    const rows = await this.db.tx.feeDue.findMany({
      where: { id: { in: unique }, studentId, status: 'OPEN' },
      include: { feeHead: { select: { sortOrder: true } } },
    });
    if (rows.length !== unique.length) throw new NotFoundException('Due not found');
    return rows;
  }

  /** What these dues owe on a day (fines counted to that day). */
  outstanding(rows: DueRow[], asOf: IsoDate): number {
    return rows.reduce((sum, d) => sum + dueBalance(this.balanceInput(d), asOf).total, 0);
  }

  /**
   * Record money for these dues (the caller holds the student's lock): allocate it as owed on the
   * day it was paid, take the next receipt number, write the payment and its allocations,
   * re-derive the dues' totals, audit, and queue the receipt SMS. Returns the payment's id.
   */
  async recordPayment(input: {
    studentId: string;
    dues: DueRow[];
    amountPaisa: number;
    method: FeePaymentMethod;
    channel: 'COUNTER' | 'MOBILE_MANUAL';
    trxId: string | null;
    senderPhone: string | null;
    paidOn: IsoDate;
    recordedOn: IsoDate;
    clientRequestId: string;
  }): Promise<string> {
    const tx = this.db.tx;
    const owed = input.dues.map((d) => ({
      row: d,
      balance: dueBalance(this.balanceInput(d), input.paidOn),
    }));
    const outstanding = owed.reduce((sum, d) => sum + d.balance.total, 0);
    if (outstanding === 0) throw apiError(422, 'NOTHING_DUE', 'Nothing is owed on these dues');
    if (input.amountPaisa > outstanding) {
      throw apiError(422, 'AMOUNT_EXCEEDS_DUE', 'More than these dues owe', {
        outstandingPaisa: outstanding,
      });
    }
    const allocations = allocate(
      owed.map(({ row, balance }) => ({
        id: row.id,
        dueDate: dateFromDb(row.dueDate),
        sortOrder: row.feeHead.sortOrder,
        principal: balance.principal,
        fine: balance.fine,
      })),
      input.amountPaisa,
    );

    const tenantId = this.context.requireTenantId();
    const year = Number(input.recordedOn.slice(0, 4));
    const payment = await tx.feePayment.create({
      data: {
        tenantId,
        studentId: input.studentId,
        receiptYear: year,
        receiptNo: await this.nextReceiptNo(year),
        method: input.method,
        channel: input.channel,
        amountPaisa: input.amountPaisa,
        paidOn: dateToDb(input.paidOn),
        recordedOn: dateToDb(input.recordedOn),
        trxId: input.trxId,
        senderPhone: input.senderPhone,
        collectedById: this.context.requirePrincipal().userId,
        clientRequestId: input.clientRequestId,
      },
      select: { id: true, receiptYear: true, receiptNo: true },
    });
    await tx.feePaymentAllocation.createMany({
      data: allocations.map((a) => ({
        tenantId,
        paymentId: payment.id,
        studentId: input.studentId,
        dueId: a.dueId,
        principalPaisa: a.principalPaisa,
        finePaisa: a.finePaisa,
      })),
    });
    await this.dues.recomputeDues(allocations.map((a) => a.dueId));
    await this.audit.record({
      entity: 'fee_payment',
      entityId: payment.id,
      action: 'CREATE',
      newValues: {
        receiptNumber: receiptNumber(payment.receiptYear, payment.receiptNo),
        amountPaisa: input.amountPaisa,
        method: input.method,
        channel: input.channel,
        trxId: input.trxId,
        paidOn: input.paidOn,
        allocations: allocations.map((a) => ({ ...a })),
      },
    });
    await this.queueReceiptSms(payment.id, input.recordedOn);
    return payment.id;
  }

  /** The receipt SMS to the primary guardian (queued after commit; the daily cap applies). */
  async queueReceiptSms(paymentId: string, today: IsoDate): Promise<void> {
    const tx = this.db.tx;
    const settings = await tx.feeSettings.findFirst({ select: { receiptSmsEnabled: true } });
    if (settings && !settings.receiptSmsEnabled) return;
    const payment = await tx.feePayment.findUniqueOrThrow({
      where: { id: paymentId },
      include: paymentInclude,
    });
    const phone = payment.student.guardians[0]?.guardian.phone;
    if (!phone) return;
    const tenant = await tx.tenant.findFirstOrThrow({ select: { name: true } });
    await this.sms.queue({
      purpose: 'FEE_RECEIPT',
      phone,
      body: receiptSmsText({
        institute: tenant.name,
        student: payment.student.nameBn ?? payment.student.nameEn ?? payment.student.studentCode,
        amountPaisa: payment.amountPaisa,
        receiptNumber: receiptNumber(payment.receiptYear, payment.receiptNo),
        date: formatDate(dateToDb(today), 'bn'),
        balancePaisa: await this.balanceToday(payment.studentId, today),
      }),
      localDate: today,
      dedupeKey: `receipt:${payment.id}`,
      relatedEntity: 'fee_payment',
      relatedId: payment.id,
      delayMs: 0,
      dailyCap: await this.smsCap.smsDailyCap(),
    });
  }

  async receipt(id: string): Promise<FeeReceipt> {
    const tx = this.db.tx;
    const p: PaymentRow | null = await tx.feePayment.findUnique({
      where: { id },
      include: paymentInclude,
    });
    if (!p) throw new NotFoundException('Receipt not found');
    const [tenant, settings, enrolment, ctx] = await Promise.all([
      tx.tenant.findFirstOrThrow({ select: { name: true } }),
      tx.feeSettings.findFirst({ select: { receiptNote: true } }),
      tx.enrolment.findFirst({
        where: { studentId: p.studentId, academicYear: { isCurrent: true } },
        select: {
          roll: true,
          classLevel: { select: { nameBn: true, nameEn: true } },
          section: { select: { name: true } },
        },
      }),
      this.dues.planContext(),
    ]);
    const names = await staffNames(
      tx,
      [p.collectedById, p.voidedById].filter((v): v is string => !!v),
    );
    return {
      id: p.id,
      receiptNumber: receiptNumber(p.receiptYear, p.receiptNo),
      status: p.status,
      void:
        p.status === 'VOID'
          ? {
              at: p.voidedAt!.toISOString(),
              reason: p.voidReason!,
              by: staffRef(names, p.voidedById!),
            }
          : null,
      method: p.method,
      channel: p.channel,
      trxId: p.trxId,
      senderPhone: p.senderPhone ? maskPhone(p.senderPhone) : null,
      amountPaisa: p.amountPaisa,
      paidOn: dateFromDb(p.paidOn),
      recordedOn: dateFromDb(p.recordedOn),
      createdAt: p.createdAt.toISOString(),
      institute: { name: tenant.name, receiptNote: settings?.receiptNote ?? null },
      student: {
        id: p.student.id,
        studentCode: p.student.studentCode,
        nameBn: p.student.nameBn,
        nameEn: p.student.nameEn,
        classLevel: enrolment?.classLevel ?? null,
        section: enrolment?.section?.name ?? null,
        roll: enrolment?.roll ?? null,
      },
      lines: [...p.allocations]
        .sort(
          (a, b) =>
            a.due.dueDate.getTime() - b.due.dueDate.getTime() ||
            a.due.feeHead.sortOrder - b.due.feeHead.sortOrder,
        )
        .map((a) => ({
          dueId: a.dueId,
          head: { nameBn: a.due.feeHead.nameBn, nameEn: a.due.feeHead.nameEn },
          periodKey: a.due.periodKey,
          term: a.due.feeTerm,
          principalPaisa: a.principalPaisa,
          finePaisa: a.finePaisa,
        })),
      collectedBy: p.collectedById ? staffRef(names, p.collectedById) : null,
      balanceTodayPaisa: await this.balanceToday(p.studentId, ctx.today),
    };
  }

  /** OWNER/ADMIN: a payment is voided (never edited or deleted); its dues owe again. */
  async void(id: string, reason: string): Promise<FeeReceipt> {
    const tx = this.db.tx;
    const found = await tx.feePayment.findUnique({ where: { id }, select: { studentId: true } });
    if (!found) throw new NotFoundException('Receipt not found');
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, found.studentId);
    const payment = await tx.feePayment.findUniqueOrThrow({
      where: { id },
      include: { allocations: { select: { dueId: true } } },
    });
    if (payment.status === 'VOID')
      throw apiError(409, 'ALREADY_VOID', 'This payment is already void');
    await tx.feePayment.update({
      where: { id },
      data: {
        status: 'VOID',
        voidedAt: new Date(),
        voidedById: this.context.requirePrincipal().userId,
        voidReason: reason,
      },
    });
    await this.dues.recomputeDues(payment.allocations.map((a) => a.dueId));
    // A verified bKash/Nagad submission goes with its payment: its TrxID is free again.
    await tx.feeMobileSubmission.updateMany({
      where: { paymentId: id, status: 'VERIFIED' },
      data: { status: 'VOIDED' },
    });
    await this.audit.record({
      entity: 'fee_payment',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'ACTIVE' },
      newValues: { status: 'VOID', reason },
    });
    return this.receipt(id);
  }

  /**
   * One day per collector and method (docs/fees.md → Daily closing). A payment counts on the day
   * it was recorded; a void is deducted on the day it is made (never on the payment's own day),
   * so a closed day never changes afterwards. An accountant sees only their own closing.
   */
  async closing(query: { date?: IsoDate; collectorId?: string }): Promise<FeeClosing> {
    const tx = this.db.tx;
    const me = this.context.requirePrincipal();
    const roles = await this.access.getRoles(me.tenantId!, me.userId);
    const admin = roles.includes('OWNER') || roles.includes('ADMIN');
    if (!admin && query.collectorId && query.collectorId !== me.userId) {
      throw apiError(403, 'OWN_CLOSING_ONLY', 'You can see your own closing only');
    }
    const collectorId = admin ? query.collectorId : me.userId;
    const ctx = await this.dues.planContext();
    const date = query.date ?? ctx.today;
    const who = collectorId ? { collectedById: collectorId } : {};
    // Voided that day in the institute's timezone: look a day either side, then keep that day.
    const day = dateToDb(date).getTime();
    const [recorded, voidedNear] = await Promise.all([
      tx.feePayment.findMany({
        where: { recordedOn: dateToDb(date), ...who },
        orderBy: [{ receiptNo: 'asc' }],
      }),
      tx.feePayment.findMany({
        where: {
          status: 'VOID',
          voidedAt: { gte: new Date(day - 86_400_000), lt: new Date(day + 2 * 86_400_000) },
          ...who,
        },
      }),
    ]);
    const voided = voidedNear.filter((p) => todayIn(ctx.timezone, p.voidedAt!) === date);
    const ids = [...new Set([...recorded, ...voided].map((r) => r.collectedById))];
    const names = await staffNames(tx, ids);
    const sum = (rows: { amountPaisa: number }[]) => rows.reduce((s, r) => s + r.amountPaisa, 0);
    const collectors: FeeClosingCollector[] = ids.map((id) => {
      const mine = recorded.filter((r) => r.collectedById === id);
      const voids = voided.filter((r) => r.collectedById === id);
      const byMethod = METHOD_ORDER.map((method) => ({
        method,
        count: mine.filter((r) => r.method === method).length,
        amountPaisa:
          sum(mine.filter((r) => r.method === method)) -
          sum(voids.filter((r) => r.method === method)),
      })).filter((m) => m.count > 0 || m.amountPaisa !== 0);
      return {
        collector: staffRef(names, id),
        collected: { count: mine.length, amountPaisa: sum(mine) },
        voided: voids.map((r) => ({
          id: r.id,
          receiptNumber: receiptNumber(r.receiptYear, r.receiptNo),
          amountPaisa: r.amountPaisa,
          reason: r.voidReason!,
          recordedOn: dateFromDb(r.recordedOn),
        })),
        byMethod,
        net: { amountPaisa: sum(mine) - sum(voids) },
        cashInHandPaisa:
          sum(mine.filter((r) => r.method === 'CASH')) -
          sum(voids.filter((r) => r.method === 'CASH')),
        receipts:
          mine.length > 0
            ? {
                first: receiptNumber(mine[0]!.receiptYear, mine[0]!.receiptNo),
                last: receiptNumber(mine.at(-1)!.receiptYear, mine.at(-1)!.receiptNo),
              }
            : null,
      };
    });
    const collected = collectors.reduce((s, c) => s + c.collected.amountPaisa, 0);
    const net = collectors.reduce((s, c) => s + c.net.amountPaisa, 0);
    return {
      date,
      collectors,
      total: {
        collectedPaisa: collected,
        voidedPaisa: collected - net,
        netPaisa: net,
        cashInHandPaisa: collectors.reduce((s, c) => s + c.cashInHandPaisa, 0),
      },
    };
  }
}
