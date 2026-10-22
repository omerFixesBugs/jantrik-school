import { Injectable } from '@nestjs/common';
import {
  addDays,
  dateFromDb,
  dateToDb,
  daysBetween,
  maskPhone,
  toCsv,
  type FeeCollections,
  type FeeDueList,
  type FeeDueListRow,
  type FeeSummary,
  type IsoDate,
} from '@jantrik/shared';
import type { z } from 'zod';
import type { feeCollectionsQuerySchema, feeDueListQuerySchema } from '@jantrik/shared';
import { staffNames } from '../../staff/staff.module.js';
import { Db } from '../../tenancy/db.service.js';
import { balanceOf } from '../due-balance.js';
import { FeeDuesService } from '../dues/fee-dues.service.js';
import { FeeStudentsService } from '../fee-students.service.js';

type DueListQuery = z.output<typeof feeDueListQuerySchema>;
type CollectionsQuery = z.output<typeof feeCollectionsQuerySchema>;

/** Paisa as taka with two decimals and ASCII digits (files people re-use in other software). */
const taka = (paisa: number) => (paisa / 100).toFixed(2);

/**
 * Fee reports (OWNER/ADMIN/ACCOUNTANT): who owes what by class and section (defaulters: overdue
 * only), collections by day/month/head/method/collector, their CSV, and the dashboard card.
 * Sums over many rows are taken in SQL as bigint (a year's collections pass 2³¹ paisa).
 */
@Injectable()
export class FeeReportsService {
  constructor(
    private readonly db: Db,
    private readonly dues: FeeDuesService,
    private readonly students: FeeStudentsService,
  ) {}

  async dueList(q: DueListQuery): Promise<FeeDueList> {
    const tx = this.db.tx;
    const ctx = await this.dues.planContext();
    await this.dues.ensureTenantToday();
    const today = ctx.today;
    const full = await this.students.seesPhones();
    if (!ctx.year) {
      return {
        today,
        rows: [],
        totals: { students: 0, principalPaisa: 0, finePaisa: 0, totalPaisa: 0, overduePaisa: 0 },
      };
    }
    const enrolments = await tx.enrolment.findMany({
      where: {
        academicYearId: ctx.year.id,
        ...(q.classLevelId ? { classLevelId: q.classLevelId } : {}),
        ...(q.sectionId ? { sectionId: q.sectionId } : {}),
        student: { deletedAt: null },
      },
      select: {
        roll: true,
        classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
        section: { select: { id: true, name: true } },
        student: {
          select: {
            id: true,
            studentCode: true,
            nameBn: true,
            nameEn: true,
            guardians: {
              where: { isPrimary: true },
              select: { guardian: { select: { nameBn: true, nameEn: true, phone: true } } },
            },
          },
        },
      },
    });
    const dues = await tx.feeDue.findMany({
      where: { status: 'OPEN', studentId: { in: enrolments.map((e) => e.student.id) } },
    });
    const byStudent = new Map<string, typeof dues>();
    for (const d of dues) byStudent.set(d.studentId, [...(byStudent.get(d.studentId) ?? []), d]);
    // Overdue for the report: past its due date by at least `minDays`.
    const overdueBefore = addDays(today, -Math.max(q.minDays, 1) + 1);

    const rows: (FeeDueListRow & { sort: [number, string, number, string] })[] = [];
    for (const e of enrolments) {
      let principal = 0;
      let fine = 0;
      let overdue = 0;
      let open = 0;
      let oldest: IsoDate | null = null;
      for (const d of byStudent.get(e.student.id) ?? []) {
        const dueDate = dateFromDb(d.dueDate);
        const b = balanceOf(d, today);
        if (b.total === 0) continue;
        open++;
        principal += b.principal;
        fine += b.fine;
        if (dueDate < overdueBefore) {
          overdue += b.total;
          if (!oldest || dueDate < oldest) oldest = dueDate;
        }
      }
      const total = principal + fine;
      if (total === 0) continue;
      if (q.overdueOnly && (overdue === 0 || overdue < q.minAmountPaisa)) continue;
      const g = e.student.guardians[0]?.guardian;
      rows.push({
        student: {
          id: e.student.id,
          studentCode: e.student.studentCode,
          nameBn: e.student.nameBn,
          nameEn: e.student.nameEn,
        },
        classLevel: {
          id: e.classLevel.id,
          nameBn: e.classLevel.nameBn,
          nameEn: e.classLevel.nameEn,
        },
        section: e.section,
        roll: e.roll,
        guardian: g
          ? { nameBn: g.nameBn, nameEn: g.nameEn, phone: full ? g.phone : maskPhone(g.phone) }
          : null,
        openDues: open,
        principalPaisa: principal,
        finePaisa: fine,
        totalPaisa: total,
        overduePaisa: overdue,
        oldestOverdue: oldest,
        sort: [
          e.classLevel.sortOrder,
          e.section?.name ?? '',
          e.roll ?? 99999,
          e.student.studentCode,
        ],
      });
    }
    rows.sort(
      (a, b) =>
        a.sort[0] - b.sort[0] ||
        a.sort[1].localeCompare(b.sort[1]) ||
        a.sort[2] - b.sort[2] ||
        a.sort[3].localeCompare(b.sort[3]),
    );
    const clean = rows.map(({ sort: _sort, ...r }) => r);
    const sum = (k: 'principalPaisa' | 'finePaisa' | 'totalPaisa' | 'overduePaisa') =>
      clean.reduce((s, r) => s + r[k], 0);
    return {
      today,
      rows: clean,
      totals: {
        students: clean.length,
        principalPaisa: sum('principalPaisa'),
        finePaisa: sum('finePaisa'),
        totalPaisa: sum('totalPaisa'),
        overduePaisa: sum('overduePaisa'),
      },
    };
  }

  async dueListCsv(q: DueListQuery): Promise<{ filename: string; csv: string }> {
    const list = await this.dueList(q);
    const bn = q.locale === 'bn';
    const name = (r: { nameBn: string | null; nameEn: string | null }) =>
      (bn ? (r.nameBn ?? r.nameEn) : (r.nameEn ?? r.nameBn)) ?? '';
    const header = bn
      ? [
          'আইডি',
          'নাম',
          'শ্রেণি',
          'শাখা',
          'রোল',
          'অভিভাবক',
          'ফোন',
          'বকেয়া ফি (সংখ্যা)',
          'মূল (টাকা)',
          'জরিমানা (টাকা)',
          'মোট (টাকা)',
          'মেয়াদোত্তীর্ণ (টাকা)',
          'পুরোনো বকেয়ার তারিখ',
        ]
      : [
          'ID',
          'Name',
          'Class',
          'Section',
          'Roll',
          'Guardian',
          'Phone',
          'Open dues',
          'Principal (Tk)',
          'Fine (Tk)',
          'Total (Tk)',
          'Overdue (Tk)',
          'Oldest overdue',
        ];
    const rows = list.rows.map((r) => [
      r.student.studentCode,
      name(r.student),
      r.classLevel ? name(r.classLevel) : '',
      r.section?.name ?? '',
      r.roll,
      r.guardian ? name(r.guardian) : '',
      r.guardian?.phone ?? '',
      r.openDues,
      taka(r.principalPaisa),
      taka(r.finePaisa),
      taka(r.totalPaisa),
      taka(r.overduePaisa),
      r.oldestOverdue ?? '',
    ]);
    const t = list.totals;
    const total = [
      bn ? 'মোট' : 'Total',
      '',
      '',
      '',
      '',
      '',
      '',
      t.students,
      taka(t.principalPaisa),
      taka(t.finePaisa),
      taka(t.totalPaisa),
      taka(t.overduePaisa),
      '',
    ];
    return {
      filename: `${q.overdueOnly ? 'defaulters' : 'dues'}-${list.today}.csv`,
      csv: toCsv([header, ...rows, total]),
    };
  }

  /** Money kept (void payments left out), recorded in the range, in one grouping. */
  async collections(q: CollectionsQuery): Promise<FeeCollections> {
    const tx = this.db.tx;
    const from = dateToDb(q.from);
    const to = dateToDb(q.to);
    type Row = { key: string; count: bigint; amount: bigint | null };
    let rows: Row[];
    switch (q.groupBy) {
      case 'day':
        rows = await tx.$queryRaw<Row[]>`
          SELECT to_char(recorded_on, 'YYYY-MM-DD') AS key, count(*)::bigint AS count,
                 sum(amount_paisa)::bigint AS amount
          FROM fee_payments WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${from} AND ${to}
          GROUP BY 1 ORDER BY 1`;
        break;
      case 'month':
        rows = await tx.$queryRaw<Row[]>`
          SELECT to_char(recorded_on, 'YYYY-MM') AS key, count(*)::bigint AS count,
                 sum(amount_paisa)::bigint AS amount
          FROM fee_payments WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${from} AND ${to}
          GROUP BY 1 ORDER BY 1`;
        break;
      case 'method':
        rows = await tx.$queryRaw<Row[]>`
          SELECT method::text AS key, count(*)::bigint AS count, sum(amount_paisa)::bigint AS amount
          FROM fee_payments WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${from} AND ${to}
          GROUP BY 1 ORDER BY 1`;
        break;
      case 'collector':
        rows = await tx.$queryRaw<Row[]>`
          SELECT collected_by_id::text AS key, count(*)::bigint AS count,
                 sum(amount_paisa)::bigint AS amount
          FROM fee_payments WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${from} AND ${to}
          GROUP BY 1 ORDER BY 3 DESC`;
        break;
      case 'head':
        rows = await tx.$queryRaw<Row[]>`
          SELECT d.fee_head_id::text AS key, count(DISTINCT p.id)::bigint AS count,
                 sum(a.principal_paisa + a.fine_paisa)::bigint AS amount
          FROM fee_payment_allocations a
          JOIN fee_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
          JOIN fee_dues d ON d.tenant_id = a.tenant_id AND d.id = a.due_id
          WHERE p.status = 'ACTIVE' AND p.recorded_on BETWEEN ${from} AND ${to}
          GROUP BY 1 ORDER BY 3 DESC`;
        break;
    }
    const [total] = await tx.$queryRaw<{ count: bigint; amount: bigint | null }[]>`
      SELECT count(*)::bigint AS count, sum(amount_paisa)::bigint AS amount
      FROM fee_payments WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${from} AND ${to}`;

    let names = new Map<string, { nameBn: string | null; nameEn: string | null }>();
    if (q.groupBy === 'head') {
      const heads = await tx.feeHead.findMany({
        where: { id: { in: rows.map((r) => r.key) } },
        select: { id: true, nameBn: true, nameEn: true },
      });
      names = new Map(heads.map((h) => [h.id, { nameBn: h.nameBn, nameEn: h.nameEn }]));
    } else if (q.groupBy === 'collector') {
      const staff = await staffNames(
        tx,
        rows.map((r) => r.key),
      );
      names = new Map([...staff].map(([id, n]) => [id, { nameBn: n.nameBn, nameEn: n.name }]));
    }
    return {
      from: q.from,
      to: q.to,
      groupBy: q.groupBy,
      rows: rows.map((r) => ({
        key: r.key,
        nameBn: names.get(r.key)?.nameBn ?? null,
        nameEn: names.get(r.key)?.nameEn ?? null,
        count: Number(r.count),
        amountPaisa: Number(r.amount ?? 0n),
      })),
      total: { count: Number(total!.count), amountPaisa: Number(total!.amount ?? 0n) },
    };
  }

  async collectionsCsv(q: CollectionsQuery): Promise<{ filename: string; csv: string }> {
    const c = await this.collections(q);
    const bn = q.locale === 'bn';
    const label = (r: FeeCollections['rows'][number]) =>
      (bn ? (r.nameBn ?? r.nameEn) : (r.nameEn ?? r.nameBn)) ?? r.key;
    const header = bn ? ['বিভাগ', 'রসিদ (সংখ্যা)', 'টাকা'] : ['Group', 'Receipts', 'Amount (Tk)'];
    return {
      filename: `collections-${q.groupBy}-${q.from}-${q.to}.csv`,
      csv: toCsv([
        header,
        ...c.rows.map((r) => [label(r), r.count, taka(r.amountPaisa)]),
        [bn ? 'মোট' : 'Total', c.total.count, taka(c.total.amountPaisa)],
      ]),
    };
  }

  /** The dashboard's fee card. */
  async summary(): Promise<FeeSummary> {
    const tx = this.db.tx;
    const ctx = await this.dues.planContext();
    await this.dues.ensureTenantToday();
    const today = ctx.today;
    const monthStart = `${today.slice(0, 7)}-01`;
    const prevStart = addDays(monthStart, -1).slice(0, 7) + '-01';
    const prevEnd = addDays(monthStart, -1);
    const sameDay = `${prevStart.slice(0, 8)}${today.slice(8)}`;
    const prevTo = sameDay <= prevEnd && daysBetween(prevStart, sameDay) >= 0 ? sameDay : prevEnd;
    const sumBetween = async (from: IsoDate, to: IsoDate) => {
      const [row] = await tx.$queryRaw<{ count: bigint; amount: bigint | null }[]>`
        SELECT count(*)::bigint AS count, sum(amount_paisa)::bigint AS amount
        FROM fee_payments
        WHERE status = 'ACTIVE' AND recorded_on BETWEEN ${dateToDb(from)} AND ${dateToDb(to)}`;
      return { count: Number(row!.count), amount: Number(row!.amount ?? 0n) };
    };
    const [month, previous, overdueDues, pending] = await Promise.all([
      sumBetween(monthStart, today),
      sumBetween(prevStart, prevTo),
      tx.feeDue.findMany({ where: { status: 'OPEN', dueDate: { lt: dateToDb(today) } } }),
      tx.feeMobileSubmission.count({ where: { status: 'PENDING' } }),
    ]);
    let overdue = 0;
    const students = new Set<string>();
    for (const d of overdueDues) {
      const b = balanceOf(d, today);
      if (b.total > 0) {
        overdue += b.total;
        students.add(d.studentId);
      }
    }
    return {
      today,
      month: { collectedPaisa: month.amount, count: month.count },
      previousMonthToDate: { collectedPaisa: previous.amount },
      overdue: { paisa: overdue, students: students.size },
      pendingSubmissions: pending,
    };
  }
}
