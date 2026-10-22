import { Injectable, NotFoundException } from '@nestjs/common';
import {
  dateFromDb,
  dueBalance,
  type FeeDueView,
  type FeeLedger,
  type FeeUpcomingDue,
  type IsoDate,
} from '@jantrik/shared';
import { Db } from '../../tenancy/db.service.js';
import { FeeStudentsService } from '../fee-students.service.js';
import { FeeSetupService } from '../setup/fee-setup.service.js';
import { FeeDuesService } from './fee-dues.service.js';

const dueInclude = {
  feeHead: { select: { id: true, nameBn: true, nameEn: true, kind: true, sortOrder: true } },
  academicYear: { select: { id: true, name: true } },
  feeTerm: { select: { nameBn: true, nameEn: true } },
} as const;

/**
 * One student's fee ledger: every due (earlier years' arrears too) with what is still owed
 * today, the periods that can be paid ahead, concessions, fine waivers and totals. Looking at
 * it generates the student's dues up to today (never future ones: paying ahead creates those
 * inside the payment).
 */
@Injectable()
export class FeeLedgerService {
  constructor(
    private readonly db: Db,
    private readonly dues: FeeDuesService,
    private readonly students: FeeStudentsService,
    private readonly setup: FeeSetupService,
  ) {}

  async ledger(studentId: string, opts: { upTo?: IsoDate } = {}): Promise<FeeLedger> {
    const tx = this.db.tx;
    const student = await this.students.hit(studentId);
    if (!student) throw new NotFoundException('Student not found');
    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([studentId], { ctx });
    const today = ctx.today;

    const [rows, waivers, membership] = await Promise.all([
      tx.feeDue.findMany({
        where: { studentId },
        include: dueInclude,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.feeFineWaiver.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }),
      tx.feeSiblingMember.findFirst({
        where: { studentId, removedAt: null },
        select: { groupId: true },
      }),
    ]);
    const dues: FeeDueView[] = rows
      .sort(
        (a, b) =>
          a.dueDate.getTime() - b.dueDate.getTime() || a.feeHead.sortOrder - b.feeHead.sortOrder,
      )
      .map((d) => {
        const dueDate = dateFromDb(d.dueDate);
        const balance = dueBalance(
          {
            status: d.status,
            amountPaisa: d.amountPaisa,
            concessionPaisa: d.concessionPaisa,
            paidPrincipalPaisa: d.paidPrincipalPaisa,
            paidFinePaisa: d.paidFinePaisa,
            principalClearedOn: d.principalClearedOn ? dateFromDb(d.principalClearedOn) : null,
            dueDate,
            fine: { type: d.fineType, amountPaisa: d.fineAmountPaisa, capPaisa: d.fineCapPaisa },
            fineWaivedPaisa: d.fineWaivedPaisa,
            fineWaivedAll: d.fineWaivedAll,
          },
          today,
        );
        return {
          id: d.id,
          head: {
            id: d.feeHead.id,
            nameBn: d.feeHead.nameBn,
            nameEn: d.feeHead.nameEn,
            kind: d.feeHead.kind,
          },
          academicYear: d.academicYear,
          periodKey: d.periodKey,
          term: d.feeTerm,
          periodStart: dateFromDb(d.periodStart),
          dueDate,
          amountPaisa: d.amountPaisa,
          concessionPaisa: d.concessionPaisa,
          concessionSource: d.concessionSource,
          paidPrincipalPaisa: d.paidPrincipalPaisa,
          paidFinePaisa: d.paidFinePaisa,
          fineWaivedPaisa: d.fineWaivedPaisa,
          fineWaivedAll: d.fineWaivedAll,
          principalClearedOn: d.principalClearedOn ? dateFromDb(d.principalClearedOn) : null,
          balance,
          status: d.status,
          cancelReason: d.cancelReason,
          overdue: balance.total > 0 && dueDate < today,
        };
      });

    // Periods of this year not generated yet, in the order they come.
    let upcoming: FeeUpcomingDue[] = [];
    if (ctx.year) {
      const existing = new Set(
        rows
          .filter((r) => r.academicYearId === ctx.year!.id)
          .map((r) => `${r.feeHeadId}|${r.periodKey}`),
      );
      const [planned] = await this.dues.plan([studentId], ctx, opts.upTo ?? ctx.year.endDate);
      const heads = new Map(
        (await tx.feeHead.findMany({ select: { id: true, nameBn: true, nameEn: true } })).map(
          (h) => [h.id, h],
        ),
      );
      const terms = new Map(
        (await tx.feeTerm.findMany({ where: { academicYearId: ctx.year.id } })).map((t) => [
          t.id,
          t,
        ]),
      );
      upcoming = (planned?.dues ?? [])
        .filter((d) => !existing.has(`${d.feeHeadId}|${d.periodKey}`) && d.periodStart > today)
        .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
        .map((d) => {
          const head = heads.get(d.feeHeadId)!;
          const term = d.termId ? terms.get(d.termId) : undefined;
          return {
            headId: d.feeHeadId,
            head: { nameBn: head.nameBn, nameEn: head.nameEn },
            periodKey: d.periodKey,
            term: term ? { nameBn: term.nameBn, nameEn: term.nameEn } : null,
            periodStart: d.periodStart,
            dueDate: d.dueDate,
            amountPaisa: d.amountPaisa,
            concessionPaisa: d.concessionPaisa,
          };
        });
    }

    const open = dues.filter((d) => d.status === 'OPEN');
    const rank =
      membership && ctx.year
        ? ((await this.dues.ranksFor([studentId], ctx.year.id)).get(studentId) ?? null)
        : null;
    return {
      today,
      student,
      family: membership && rank ? { groupId: membership.groupId, rank } : null,
      dues,
      upcoming,
      concessions: ctx.year
        ? await this.setup.listConcessions({ studentId, academicYearId: ctx.year.id })
        : [],
      waivers: waivers.map((w) => ({
        id: w.id,
        dueId: w.dueId,
        amountPaisa: w.amountPaisa,
        reason: w.reason,
        createdAt: w.createdAt.toISOString(),
      })),
      totals: {
        charged: open.reduce((s, d) => s + d.amountPaisa, 0),
        concession: open.reduce((s, d) => s + d.concessionPaisa, 0),
        paid: open.reduce((s, d) => s + d.paidPrincipalPaisa + d.paidFinePaisa, 0),
        balance: open.reduce((s, d) => s + d.balance.total, 0),
        overdue: open.filter((d) => d.overdue).reduce((s, d) => s + d.balance.total, 0),
      },
    };
  }
}
