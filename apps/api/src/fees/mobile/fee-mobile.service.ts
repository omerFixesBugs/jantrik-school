import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  dateToDb,
  maskPhone,
  receiptNumber,
  type FeeGuardianView,
  type FeeMobileAccountView,
  type FeeReceipt,
  type FeeSubmissionView,
} from '@jantrik/shared';
import type { z } from 'zod';
import type {
  createMobileAccountSchema,
  guardianSubmissionSchema,
  staffSubmissionSchema,
  updateMobileAccountSchema,
  verifySubmissionSchema,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { RateLimiter } from '../../redis/rate-limiter.service.js';
import { Db } from '../../tenancy/db.service.js';
import { FeeCollectionService } from '../collection/fee-collection.service.js';
import { FeeDuesService } from '../dues/fee-dues.service.js';
import { FeeLedgerService } from '../dues/fee-ledger.service.js';
import { FeeStudentsService } from '../fee-students.service.js';
import { lockStudentFees, lockTenantFees, lockTrxId } from '../fee-locks.js';

type AccountCreate = z.output<typeof createMobileAccountSchema>;
type AccountUpdate = z.output<typeof updateMobileAccountSchema>;
type GuardianSubmission = z.output<typeof guardianSubmissionSchema>;
type StaffSubmission = z.output<typeof staffSubmissionSchema>;
type VerifyInput = z.output<typeof verifySubmissionSchema>;

/** At most this many submissions waiting per child, and per person per hour. */
const MAX_PENDING_PER_CHILD = 5;
const SUBMISSIONS_PER_HOUR = 20;

const submissionInclude = {
  student: {
    select: {
      id: true,
      studentCode: true,
      nameBn: true,
      nameEn: true,
      enrolments: {
        where: { academicYear: { isCurrent: true } },
        select: { classLevel: { select: { nameBn: true, nameEn: true } } },
      },
    },
  },
  account: { select: { id: true, phone: true, label: true } },
  payment: { select: { id: true, receiptYear: true, receiptNo: true } },
  dues: {
    select: {
      due: {
        select: {
          id: true,
          periodKey: true,
          feeHead: { select: { nameBn: true, nameEn: true } },
          feeTerm: { select: { nameBn: true, nameEn: true } },
        },
      },
    },
  },
} as const;
type SubmissionRow = Prisma.FeeMobileSubmissionGetPayload<{ include: typeof submissionInclude }>;

const toAccountView = (a: Prisma.FeeMobileAccountGetPayload<object>): FeeMobileAccountView => ({
  id: a.id,
  method: a.method as FeeMobileAccountView['method'],
  phone: a.phone,
  kind: a.kind,
  label: a.label,
  isActive: a.isActive,
  sortOrder: a.sortOrder,
});

/**
 * Manual bKash/Nagad (docs/fees.md): the institute's own numbers (OWNER), "I paid" submissions
 * with the TrxID (guardian or staff), and staff review: verify → a payment and receipt dated the
 * day it was sent, or reject with a reason. A TrxID is open once per method: checked against
 * open submissions and live payments under a per-TrxID lock (and by partial unique indexes).
 */
@Injectable()
export class FeeMobileService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly dues: FeeDuesService,
    private readonly ledgers: FeeLedgerService,
    private readonly collection: FeeCollectionService,
    private readonly students: FeeStudentsService,
    private readonly limiter: RateLimiter,
  ) {}

  // ─────────────────────────── The institute's numbers ───────────────────────────

  async listAccounts(): Promise<FeeMobileAccountView[]> {
    const rows = await this.db.tx.feeMobileAccount.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toAccountView);
  }

  async createAccount(input: AccountCreate): Promise<FeeMobileAccountView> {
    const tx = this.db.tx;
    const exists = await tx.feeMobileAccount.findFirst({
      where: { method: input.method, phone: input.phone },
      select: { id: true },
    });
    if (exists)
      throw apiError(409, 'DUPLICATE', 'This number is already listed', { field: 'phone' });
    const row = await tx.feeMobileAccount.create({
      data: { tenantId: this.context.requireTenantId(), ...input },
    });
    const view = toAccountView(row);
    await this.audit.record({
      entity: 'fee_mobile_account',
      entityId: row.id,
      action: 'CREATE',
      newValues: { ...view },
    });
    return view;
  }

  async updateAccount(id: string, input: AccountUpdate): Promise<FeeMobileAccountView> {
    const tx = this.db.tx;
    const row = await tx.feeMobileAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Account not found');
    const updated = await tx.feeMobileAccount.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    await this.audit.record({
      entity: 'fee_mobile_account',
      entityId: id,
      action: 'UPDATE',
      oldValues: { ...toAccountView(row) },
      newValues: { ...toAccountView(updated) },
    });
    return toAccountView(updated);
  }

  // ─────────────────────────── Guardians ───────────────────────────

  /** 404 unless the caller is a guardian of this child (and the child is not removed). */
  async assertChild(studentId: string): Promise<void> {
    const link = await this.db.tx.studentGuardian.findFirst({
      where: {
        studentId,
        guardian: { userId: this.context.requirePrincipal().userId },
        student: { deletedAt: null },
      },
      select: { id: true },
    });
    if (!link) throw new NotFoundException('Child not found');
  }

  async guardianView(studentId: string): Promise<FeeGuardianView> {
    await this.assertChild(studentId);
    const me = this.context.requirePrincipal().userId;
    const ledger = await this.ledgers.ledger(studentId);
    const [submissions, accounts] = await Promise.all([
      this.db.tx.feeMobileSubmission.findMany({
        where: { studentId },
        include: submissionInclude,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.db.tx.feeMobileAccount.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      today: ledger.today,
      ledger,
      // The sender's number in full only on the guardian's own submissions (another guardian
      // of the child, or staff, may have sent others).
      submissions: submissions.map((r) => this.toView(r, r.submittedById === me)),
      accounts: accounts.map((a) => {
        const v = toAccountView(a);
        return { id: v.id, method: v.method, phone: v.phone, kind: v.kind, label: v.label };
      }),
    };
  }

  async guardianReceipt(studentId: string, paymentId: string): Promise<FeeReceipt> {
    await this.assertChild(studentId);
    const payment = await this.db.tx.feePayment.findFirst({
      where: { id: paymentId, studentId },
      select: { id: true },
    });
    if (!payment) throw new NotFoundException('Receipt not found');
    return this.collection.receipt(payment.id);
  }

  async submitAsGuardian(studentId: string, input: GuardianSubmission): Promise<FeeSubmissionView> {
    await this.assertChild(studentId);
    const userId = this.context.requirePrincipal().userId;
    await this.limiter.consume({
      key: `fee-submissions:${userId}`,
      limit: SUBMISSIONS_PER_HOUR,
      windowSec: 3600,
    });
    return this.submit(studentId, input, 'GUARDIAN');
  }

  async submitAsStaff(input: StaffSubmission): Promise<FeeSubmissionView> {
    const student = await this.db.tx.student.findFirst({
      where: { id: input.studentId, deletedAt: null },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    return this.submit(student.id, input, 'STAFF');
  }

  /** Under the TrxID's lock: is it open somewhere (a waiting or verified submission, a live payment)? */
  private async assertTrxFree(
    method: 'BKASH' | 'NAGAD',
    trxId: string,
    exceptSubmissionId?: string,
  ) {
    const tx = this.db.tx;
    await lockTrxId(tx, method, trxId);
    const [submission, payment] = await Promise.all([
      tx.feeMobileSubmission.findFirst({
        where: {
          method,
          trxId,
          status: { in: ['PENDING', 'VERIFIED'] },
          ...(exceptSubmissionId ? { id: { not: exceptSubmissionId } } : {}),
        },
        select: { id: true },
      }),
      tx.feePayment.findFirst({ where: { method, trxId, status: 'ACTIVE' }, select: { id: true } }),
    ]);
    if (submission || payment) {
      throw apiError(409, 'TRX_ID_USED', 'This TrxID has already been used');
    }
  }

  private async submit(
    studentId: string,
    input: GuardianSubmission,
    submitter: 'GUARDIAN' | 'STAFF',
  ): Promise<FeeSubmissionView> {
    const tx = this.db.tx;
    await lockStudentFees(tx, studentId);
    const previous = await tx.feeMobileSubmission.findFirst({
      where: { clientRequestId: input.clientRequestId },
      include: submissionInclude,
    });
    if (previous) {
      // A retry (the answer was lost) is the same submission by the same person; anything else
      // reusing the id is refused, never answered with someone's saved submission.
      const me = this.context.requirePrincipal().userId;
      const sameDues =
        previous.dues.length === input.dueIds.length &&
        previous.dues.every((d) => input.dueIds.includes(d.due.id));
      const same =
        previous.submittedById === me &&
        previous.studentId === studentId &&
        previous.method === input.method &&
        previous.accountId === input.accountId &&
        previous.amountPaisa === input.amountPaisa &&
        previous.trxId === input.trxId &&
        previous.senderPhone === input.senderPhone &&
        sameDues;
      if (!same) {
        throw apiError(
          422,
          'IDEMPOTENCY_MISMATCH',
          'This request id was used for another submission',
        );
      }
      return this.toView(previous, true);
    }
    const account = await tx.feeMobileAccount.findUnique({ where: { id: input.accountId } });
    if (!account || account.method !== input.method)
      throw new NotFoundException('Account not found');
    if (!account.isActive) throw apiError(422, 'ACCOUNT_INACTIVE', 'This number is no longer used');
    const pending = await tx.feeMobileSubmission.count({ where: { studentId, status: 'PENDING' } });
    if (pending >= MAX_PENDING_PER_CHILD) {
      throw apiError(422, 'TOO_MANY_PENDING', 'Wait until the earlier payments are checked');
    }
    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([studentId], { ctx });
    const rows = await this.collection.openDues(studentId, input.dueIds);
    const outstanding = this.collection.outstanding(rows, ctx.today);
    if (input.amountPaisa > outstanding) {
      throw apiError(422, 'AMOUNT_EXCEEDS_DUE', 'More than these dues owe', {
        outstandingPaisa: outstanding,
      });
    }
    await this.assertTrxFree(input.method, input.trxId);
    const tenantId = this.context.requireTenantId();
    const row = await tx.feeMobileSubmission.create({
      data: {
        tenantId,
        studentId,
        method: input.method,
        accountId: account.id,
        amountPaisa: input.amountPaisa,
        trxId: input.trxId,
        senderPhone: input.senderPhone,
        sentOn: dateToDb(ctx.today),
        submittedById: this.context.requirePrincipal().userId,
        submitter,
        clientRequestId: input.clientRequestId,
      },
      select: { id: true },
    });
    await tx.feeMobileSubmissionDue.createMany({
      data: rows.map((d) => ({ tenantId, submissionId: row.id, studentId, dueId: d.id })),
    });
    await this.audit.record({
      entity: 'fee_submission',
      entityId: row.id,
      action: 'CREATE',
      newValues: {
        method: input.method,
        amountPaisa: input.amountPaisa,
        trxId: input.trxId,
        dues: rows.map((d) => d.id),
        submitter,
      },
    });
    const created = await tx.feeMobileSubmission.findUniqueOrThrow({
      where: { id: row.id },
      include: submissionInclude,
    });
    return this.toView(created, submitter === 'GUARDIAN' || (await this.students.seesPhones()));
  }

  // ─────────────────────────── Staff review ───────────────────────────

  async list(status?: FeeSubmissionView['status']): Promise<FeeSubmissionView[]> {
    const full = await this.students.seesPhones();
    const rows = await this.db.tx.feeMobileSubmission.findMany({
      where: status ? { status } : {},
      include: submissionInclude,
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toView(r, full));
  }

  /** Locks the submission's student and returns the submission as it is now. */
  private async lockSubmission(id: string) {
    const tx = this.db.tx;
    const found = await tx.feeMobileSubmission.findUnique({
      where: { id },
      select: { studentId: true },
    });
    if (!found) throw new NotFoundException('Submission not found');
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, found.studentId);
    return tx.feeMobileSubmission.findUniqueOrThrow({
      where: { id },
      include: { dues: { select: { dueId: true } } },
    });
  }

  /**
   * Checked in the institute's app: record the payment (dated the day it was sent, so a fine stops
   * there), the receipt and the SMS. The dues may be re-picked when the original ones were paid
   * meanwhile; a retried request returns the same receipt.
   */
  async verify(id: string, input: VerifyInput): Promise<FeeReceipt> {
    const sub = await this.lockSubmission(id);
    const replay = await this.collection.replay(
      input.clientRequestId,
      sub.studentId,
      sub.amountPaisa,
    );
    if (replay) return replay;
    if (sub.status !== 'PENDING') {
      throw apiError(409, 'ALREADY_REVIEWED', 'This payment has already been checked');
    }
    const method = sub.method as 'BKASH' | 'NAGAD';
    await this.assertTrxFree(method, sub.trxId, sub.id);
    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([sub.studentId], { ctx });
    const advanceIds = await this.dues.ensureAdvance(sub.studentId, input.advance, ctx);
    const dueIds = [...(input.dueIds ?? sub.dues.map((d) => d.dueId)), ...advanceIds];
    const rows = await this.collection.openDues(sub.studentId, dueIds);
    const sentOn = dateFromDb(sub.sentOn);
    const paymentId = await this.collection.recordPayment({
      studentId: sub.studentId,
      dues: rows,
      amountPaisa: sub.amountPaisa,
      method,
      channel: 'MOBILE_MANUAL',
      trxId: sub.trxId,
      senderPhone: sub.senderPhone,
      paidOn: sentOn,
      recordedOn: ctx.today,
      clientRequestId: input.clientRequestId,
    });
    await this.db.tx.feeMobileSubmission.update({
      where: { id },
      data: {
        status: 'VERIFIED',
        reviewedById: this.context.requirePrincipal().userId,
        reviewedAt: new Date(),
        paymentId,
      },
    });
    await this.audit.record({
      entity: 'fee_submission',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'PENDING' },
      newValues: { status: 'VERIFIED', paymentId },
    });
    return this.collection.receipt(paymentId);
  }

  async reject(id: string, reason: string): Promise<FeeSubmissionView> {
    const sub = await this.lockSubmission(id);
    if (sub.status !== 'PENDING') {
      throw apiError(409, 'ALREADY_REVIEWED', 'This payment has already been checked');
    }
    await this.db.tx.feeMobileSubmission.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: this.context.requirePrincipal().userId,
        reviewedAt: new Date(),
        rejectReason: reason,
      },
    });
    await this.audit.record({
      entity: 'fee_submission',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'PENDING' },
      newValues: { status: 'REJECTED', reason },
    });
    const row = await this.db.tx.feeMobileSubmission.findUniqueOrThrow({
      where: { id },
      include: submissionInclude,
    });
    return this.toView(row, await this.students.seesPhones());
  }

  private toView(r: SubmissionRow, fullPhone: boolean): FeeSubmissionView {
    return {
      id: r.id,
      student: {
        id: r.student.id,
        studentCode: r.student.studentCode,
        nameBn: r.student.nameBn,
        nameEn: r.student.nameEn,
        classLevel: r.student.enrolments[0]?.classLevel ?? null,
      },
      method: r.method as FeeSubmissionView['method'],
      account: r.account,
      amountPaisa: r.amountPaisa,
      trxId: r.trxId,
      senderPhone: fullPhone ? r.senderPhone : maskPhone(r.senderPhone),
      sentOn: dateFromDb(r.sentOn),
      submitter: r.submitter,
      status: r.status,
      dues: r.dues.map((d) => ({
        id: d.due.id,
        head: d.due.feeHead,
        periodKey: d.due.periodKey,
        term: d.due.feeTerm,
      })),
      rejectReason: r.rejectReason,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      receipt: r.payment
        ? {
            id: r.payment.id,
            receiptNumber: receiptNumber(r.payment.receiptYear, r.payment.receiptNo),
          }
        : null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
