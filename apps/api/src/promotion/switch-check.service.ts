import { Injectable } from '@nestjs/common';
import type { SwitchCheck } from '@jantrik/shared';
import { ExamResultsReader } from '../exams/results/exam-results-reader.js';
import { Db } from '../tenancy/db.service.js';
import { PromotionService } from './promotion.service.js';

/**
 * What is left before switching the current year to `toYearId` (review focus 3). Advisory only
 * (P5-O): the switch itself (POST /setup/academic-years/:id/current) is unchanged, and nothing
 * here ever switches the year.
 */
@Injectable()
export class SwitchCheckService {
  constructor(
    private readonly db: Db,
    private readonly promotions: PromotionService,
    private readonly results: ExamResultsReader,
  ) {}

  async check(toYearId: string): Promise<SwitchCheck> {
    const tx = this.db.tx;
    const toYear = await this.promotions.year(toYearId);
    const fromYear = await this.promotions.previousYear(toYear);

    const runs = await tx.promotionRun.findMany({
      where: { toYearId },
      select: {
        id: true,
        status: true,
        lastError: true,
        classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
        _count: { select: { rows: { where: { appliedAt: null } } } },
      },
      orderBy: [{ classLevel: { sortOrder: 'asc' } }, { id: 'asc' }],
    });
    const runsNotApplied = runs
      .filter((r) => r.status !== 'APPLIED' || r._count.rows > 0)
      .map((r) => ({
        runId: r.id,
        classLevel: {
          id: r.classLevel.id,
          nameBn: r.classLevel.nameBn,
          nameEn: r.classLevel.nameEn,
        },
        status: r.status,
        pending: r._count.rows,
        lastError: r.lastError,
      }));

    let classesWithoutRun: SwitchCheck['classesWithoutRun'] = [];
    let classesWithoutPublishedAnnual: SwitchCheck['classesWithoutPublishedAnnual'] = [];
    let notCarriedOver = 0;
    if (fromYear) {
      classesWithoutRun = await this.promotions.classesWithoutRun(fromYear, toYearId);
      if (await this.promotions.examsEnabled()) {
        const published = await this.results.classesWithPublishedAnnual(fromYear.id);
        const withStudents = await tx.enrolment.groupBy({
          by: ['classLevelId'],
          where: { academicYearId: fromYear.id, student: { deletedAt: null } },
        });
        const missing = withStudents.map((g) => g.classLevelId).filter((id) => !published.has(id));
        classesWithoutPublishedAnnual = (
          await tx.classLevel.findMany({
            where: { id: { in: missing } },
            select: { id: true, nameBn: true, nameEn: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          })
        ).map((c) => ({ id: c.id, nameBn: c.nameBn, nameEn: c.nameEn }));
      }
      notCarriedOver = await tx.student.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          enrolments: { some: { academicYearId: fromYear.id }, none: { academicYearId: toYearId } },
        },
      });
    }
    const withoutRoll = await tx.enrolment.count({
      where: {
        academicYearId: toYearId,
        sectionId: { not: null },
        roll: null,
        student: { deletedAt: null, status: 'ACTIVE' },
      },
    });
    return {
      toYear: { id: toYear.id, name: toYear.name, isCurrent: toYear.isCurrent },
      fromYear: fromYear ? { id: fromYear.id, name: fromYear.name } : null,
      classesWithoutRun,
      runsNotApplied,
      classesWithoutPublishedAnnual,
      notCarriedOver,
      withoutRoll,
      clean:
        classesWithoutRun.length === 0 &&
        runsNotApplied.length === 0 &&
        classesWithoutPublishedAnnual.length === 0 &&
        notCarriedOver === 0 &&
        withoutRoll === 0,
    };
  }
}
