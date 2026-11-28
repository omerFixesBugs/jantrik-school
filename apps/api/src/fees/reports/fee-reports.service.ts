import { Injectable } from '@nestjs/common';
import {
  addDays,
  dateFromDb,
  dateToDb,
  daysBetween,
  FEE_PAYMENT_METHOD_LABELS,
  maskPhone,
  toCsv,
  type FeePaymentMethod,
  type FeeCollections,
  type FeeDueList,
  type FeeDueListRow,
  type FeeLeaverKind,
  type FeeLeaverRow,
  type FeeLeaversReport,
  type FeeSummary,
  type IsoDate,
} from '@jantrik/shared';
import type { z } from 'zod';
import type { feeCollectionsQuerySchema, feeDueListQuerySchema } from '@jantrik/shared';
import { staffNames } from '../../staff/staff.module.js';
import { Db } from '../../tenancy/db.service.js';
import { balanceOf } from '../due-balance.js';
import { FeeDuesService } from '../dues/fee-dues.service.js';
import { FeeOnlineHooks } from '../fee-online-hooks.js';
import { FeeStudentsService } from '../fee-students.service.js';

/** The collections report's line for online payments (grouped by collector). */
const ONLINE_KEY = 'ONLINE';
const ONLINE_NAME = { nameBn: 'অনলাইনে (SSLCommerz)', nameEn: 'Online (SSLCommerz)' };

type DueListQuery = z.output<typeof feeDueListQuerySchema>;
type CollectionsQuery = z.output<typeof feeCollectionsQuerySchema>;

/** Paisa as taka with two decimals and ASCII digits (files people re-use in other software). */
const taka = (paisa: number) => (paisa / 100).toFixed(2);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Who the due list and the dashboard's overdue count are about: students still here (active, not
 * deleted; both also need a current-year enrolment). A student who left keeps their arrears on
 * their own ledger.
 */
const STILL_HERE = { status: 'ACTIVE', deletedAt: null } as const;

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
    private readonly online: FeeOnlineHooks,
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
        totals: {
          students: 0,
          principalPaisa: 0,
          finePaisa: 0,
          totalPaisa: 0,
          overduePaisa: 0,
          previousYearsPaisa: 0,
        },
      };
    }
    const enrolments = await tx.enrolment.findMany({
      where: {
        academicYearId: ctx.year.id,
        ...(q.classLevelId ? { classLevelId: q.classLevelId } : {}),
        ...(q.sectionId ? { sectionId: q.sectionId } : {}),
        student: STILL_HERE,
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
      let previous = 0;
      let open = 0;
      let oldest: IsoDate | null = null;
      for (const d of byStudent.get(e.student.id) ?? []) {
        const dueDate = dateFromDb(d.dueDate);
        const b = balanceOf(d, today);
        if (b.total === 0) continue;
        open++;
        principal += b.principal;
        fine += b.fine;
        // S17: dues of other years stay where they are, shown as previous years.
        if (d.academicYearId !== ctx.year.id) previous += b.total;
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
        previousYearsPaisa: previous,
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
    const sum = (
      k: 'principalPaisa' | 'finePaisa' | 'totalPaisa' | 'overduePaisa' | 'previousYearsPaisa',
    ) => clean.reduce((s, r) => s + r[k], 0);
    return {
      today,
      rows: clean,
      totals: {
        students: clean.length,
        principalPaisa: sum('principalPaisa'),
        finePaisa: sum('finePaisa'),
        totalPaisa: sum('totalPaisa'),
        overduePaisa: sum('overduePaisa'),
        previousYearsPaisa: sum('previousYearsPaisa'),
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
          'আগের বছরের (টাকা)',
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
          'Previous years (Tk)',
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
      taka(r.previousYearsPaisa),
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
      taka(t.previousYearsPaisa),
      '',
    ];
    return {
      filename: `${q.overdueOnly ? 'defaulters' : 'dues'}-${list.today}.csv`,
      csv: toCsv([header, ...rows, total]),
    };
  }

  /**
   * P5-K: everyone who still owes but is not on the due list: leavers (not ACTIVE, not deleted),
   * ACTIVE students without an enrolment in the current year ("not carried over"), and
   * deactivated students, each with the balance of all their open dues (every year).
   */
  async leaversWithDues(): Promise<FeeLeaversReport> {
    const tx = this.db.tx;
    const ctx = await this.dues.planContext();
    const today = ctx.today;
    const full = await this.students.seesPhones();
    const yearId = ctx.year?.id ?? NIL_UUID;
    const owing = await tx.feeDue.groupBy({
      by: ['studentId'],
      where: {
        status: 'OPEN',
        student: {
          OR: [
            { deletedAt: { not: null } },
            { status: { not: 'ACTIVE' } },
            { enrolments: { none: { academicYearId: yearId } } },
          ],
        },
      },
    });
    const ids = owing.map((o) => o.studentId);
    if (ids.length === 0)
      return { today, rows: [], totals: { students: 0, totalPaisa: 0, overduePaisa: 0 } };
    const [students, dues] = await Promise.all([
      tx.student.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          studentCode: true,
          nameBn: true,
          nameEn: true,
          status: true,
          leftOn: true,
          deletedAt: true,
          guardians: {
            where: { isPrimary: true },
            select: { guardian: { select: { nameBn: true, nameEn: true, phone: true } } },
          },
          enrolments: {
            orderBy: { academicYear: { startDate: 'desc' } },
            take: 1,
            select: {
              roll: true,
              academicYear: { select: { id: true, name: true } },
              classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
              section: { select: { id: true, name: true } },
            },
          },
        },
      }),
      tx.feeDue.findMany({ where: { status: 'OPEN', studentId: { in: ids } } }),
    ]);
    const rows: FeeLeaverRow[] = [];
    for (const st of students) {
      let total = 0;
      let overdue = 0;
      let open = 0;
      for (const d of dues.filter((x) => x.studentId === st.id)) {
        const b = balanceOf(d, today);
        if (b.total === 0) continue;
        open++;
        total += b.total;
        if (dateFromDb(d.dueDate) < today) overdue += b.total;
      }
      if (total === 0) continue;
      const kind: FeeLeaverKind = st.deletedAt
        ? 'DEACTIVATED'
        : st.status !== 'ACTIVE'
          ? 'LEFT'
          : 'NOT_CARRIED_OVER';
      const e = st.enrolments[0];
      const g = st.guardians[0]?.guardian;
      rows.push({
        student: { id: st.id, studentCode: st.studentCode, nameBn: st.nameBn, nameEn: st.nameEn },
        kind,
        status: st.status,
        leftOn: st.leftOn ? dateFromDb(st.leftOn) : null,
        deactivated: st.deletedAt !== null,
        lastYear: e?.academicYear ?? null,
        classLevel: e
          ? { id: e.classLevel.id, nameBn: e.classLevel.nameBn, nameEn: e.classLevel.nameEn }
          : null,
        section: e?.section ?? null,
        roll: e?.roll ?? null,
        guardian: g
          ? { nameBn: g.nameBn, nameEn: g.nameEn, phone: full ? g.phone : maskPhone(g.phone) }
          : null,
        openDues: open,
        totalPaisa: total,
        overduePaisa: overdue,
      });
    }
    const order: Record<FeeLeaverKind, number> = { LEFT: 0, NOT_CARRIED_OVER: 1, DEACTIVATED: 2 };
    rows.sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        (a.lastYear?.name ?? '').localeCompare(b.lastYear?.name ?? '') ||
        a.student.studentCode.localeCompare(b.student.studentCode),
    );
    return {
      today,
      rows,
      totals: {
        students: rows.length,
        totalPaisa: rows.reduce((s, r) => s + r.totalPaisa, 0),
        overduePaisa: rows.reduce((s, r) => s + r.overduePaisa, 0),
      },
    };
  }

  async leaversCsv(locale: 'bn' | 'en'): Promise<{ filename: string; csv: string }> {
    const report = await this.leaversWithDues();
    const bn = locale === 'bn';
    const name = (r: { nameBn: string | null; nameEn: string | null }) =>
      (bn ? (r.nameBn ?? r.nameEn) : (r.nameEn ?? r.nameBn)) ?? '';
    const kinds: Record<FeeLeaverKind, [string, string]> = {
      LEFT: ['প্রতিষ্ঠান ছেড়েছে', 'Left'],
      NOT_CARRIED_OVER: ['নতুন বছরে ভর্তি হয়নি', 'Not carried over'],
      DEACTIVATED: ['নিষ্ক্রিয়', 'Deactivated'],
    };
    const header = bn
      ? [
          'আইডি',
          'নাম',
          'অবস্থা',
          'অবস্থা (কোড)',
          'ছেড়েছে',
          'শেষ বছর',
          'শ্রেণি',
          'শাখা',
          'রোল',
          'অভিভাবক',
          'ফোন',
          'বকেয়া ফি (সংখ্যা)',
          'মোট (টাকা)',
          'মেয়াদোত্তীর্ণ (টাকা)',
        ]
      : [
          'ID',
          'Name',
          'Kind',
          'Status',
          'Left on',
          'Last year',
          'Class',
          'Section',
          'Roll',
          'Guardian',
          'Phone',
          'Open dues',
          'Total (Tk)',
          'Overdue (Tk)',
        ];
    const rows = report.rows.map((r) => [
      r.student.studentCode,
      name(r.student),
      kinds[r.kind][bn ? 0 : 1],
      r.status,
      r.leftOn ?? '',
      r.lastYear?.name ?? '',
      r.classLevel ? name(r.classLevel) : '',
      r.section?.name ?? '',
      r.roll,
      r.guardian ? name(r.guardian) : '',
      r.guardian?.phone ?? '',
      r.openDues,
      taka(r.totalPaisa),
      taka(r.overduePaisa),
    ]);
    const t = report.totals;
    const total = [
      bn ? 'মোট' : 'Total',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      t.students,
      taka(t.totalPaisa),
      taka(t.overduePaisa),
    ];
    return {
      filename: `leavers-with-dues-${report.today}.csv`,
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
        // Online payments were paid by guardians, not collected by staff: one line of their own
        // (P7a-V), never a guardian as a collector.
        rows = await tx.$queryRaw<Row[]>`
          SELECT CASE WHEN channel = 'GATEWAY' THEN ${ONLINE_KEY} ELSE collected_by_id::text END AS key,
                 count(*)::bigint AS count, sum(amount_paisa)::bigint AS amount
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
        rows.map((r) => r.key).filter((key) => key !== ONLINE_KEY),
      );
      names = new Map([...staff].map(([id, n]) => [id, { nameBn: n.nameBn, nameEn: n.name }]));
      names.set(ONLINE_KEY, ONLINE_NAME);
    } else if (q.groupBy === 'method') {
      names = new Map(
        rows.map((r) => {
          const label = FEE_PAYMENT_METHOD_LABELS[r.key as FeePaymentMethod];
          return [r.key, { nameBn: label?.bn ?? null, nameEn: label?.en ?? null }] as const;
        }),
      );
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
      tx.feeDue.findMany({
        where: {
          status: 'OPEN',
          dueDate: { lt: dateToDb(today) },
          student: {
            ...STILL_HERE,
            enrolments: { some: { academicYearId: ctx.year?.id ?? NIL_UUID } },
          },
        },
      }),
      tx.feeMobileSubmission.count({ where: { status: 'PENDING' } }),
    ]);
    const onlineToReview = await this.online.toReviewCount();
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
      onlineToReview,
    };
  }
}
