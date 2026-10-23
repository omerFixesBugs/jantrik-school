import { Injectable } from '@nestjs/common';
import { dateFromDb, dateToDb, todayIn, type ExamsSummary } from '@jantrik/shared';
import { Db } from '../../tenancy/db.service.js';
import { ExamAccessService } from '../exam-access.service.js';
import { MarkSheetService } from '../marks/mark-sheet.service.js';

/** The dashboard's exam card: the open exam's progress, upcoming exams, the caller's own sheets. */
@Injectable()
export class ExamSummaryService {
  constructor(
    private readonly db: Db,
    private readonly access: ExamAccessService,
    private readonly sheets: MarkSheetService,
  ) {}

  async summary(): Promise<ExamsSummary> {
    const tx = this.db.tx;
    const caller = await this.access.caller();
    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const today = todayIn(tenant.timezone);
    const open = await tx.exam.findFirst({
      where: { status: 'OPEN' },
      orderBy: [{ endsOn: 'asc' }, { createdAt: 'asc' }],
      include: { classes: { select: { isPublished: true } } },
    });
    let current: ExamsSummary['current'] = null;
    if (open) {
      const grid = await this.sheets.grid(open.id);
      const cells = grid.classes.flatMap((c) => c.cells).filter((c) => c.total > 0);
      current = {
        id: open.id,
        nameBn: open.nameBn,
        nameEn: open.nameEn,
        endsOn: dateFromDb(open.endsOn),
        sheets: {
          total: cells.length,
          draft: cells.filter((c) => c.status === 'DRAFT').length,
          submitted: cells.filter((c) => c.status === 'SUBMITTED').length,
          locked: cells.filter((c) => c.status === 'LOCKED').length,
        },
        publishedClasses: open.classes.filter((c) => c.isPublished).length,
        classes: open.classes.length,
      };
    }
    const upcoming = await tx.exam.findMany({
      where: {
        academicYear: { isCurrent: true },
        endsOn: { gte: dateToDb(today) },
        ...(caller.isAdmin ? {} : { status: { not: 'SETUP' } }),
      },
      orderBy: { startsOn: 'asc' },
      take: 6,
      select: { id: true, kind: true, nameBn: true, nameEn: true, startsOn: true, endsOn: true },
    });
    const mine = await this.sheets.mySheets();
    return {
      current,
      upcoming: upcoming.map((e) => ({
        ...e,
        startsOn: dateFromDb(e.startsOn),
        endsOn: dateFromDb(e.endsOn),
      })),
      myPendingSheets: mine.filter((m) => m.status === 'DRAFT' && m.total > 0).length,
    };
  }
}
