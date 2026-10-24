import { Injectable, NotFoundException } from '@nestjs/common';
import { dateFromDb, type ChildResultItem, type ReportCards } from '@jantrik/shared';
import { RequestContext } from '../../common/request-context.js';
import { Db } from '../../tenancy/db.service.js';
import { ExamResultsService } from '../results/exam-results.service.js';

/** A guardian's own child's published results (GUARDIAN); 404 for any other child. */
@Injectable()
export class ChildResultsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly results: ExamResultsService,
  ) {}

  async list(studentId: string): Promise<ChildResultItem[]> {
    await this.assertChild(studentId);
    const tx = this.db.tx;
    const rows = await tx.examResult.findMany({
      where: { studentId, examClass: { isPublished: true } },
      include: {
        examClass: {
          select: {
            id: true,
            publishedAt: true,
            gradingSnapshot: true,
            exam: {
              select: {
                id: true,
                nameBn: true,
                nameEn: true,
                kind: true,
                resultMode: true,
                startsOn: true,
                endsOn: true,
              },
            },
          },
        },
      },
    });
    const sizes = await tx.examResult.groupBy({
      by: ['examClassId'],
      where: { examClassId: { in: rows.map((r) => r.examClassId) } },
      _count: true,
    });
    const sizeOf = new Map(sizes.map((s) => [s.examClassId, s._count]));
    return rows
      .map((r) => {
        const exam = r.examClass.exam;
        const snapshot = r.examClass.gradingSnapshot as { rules?: { gpaDecimals?: number } } | null;
        return {
          examClassId: r.examClassId,
          exam: {
            ...exam,
            startsOn: dateFromDb(exam.startsOn),
            endsOn: dateFromDb(exam.endsOn),
          },
          publishedAt: r.examClass.publishedAt!.toISOString(),
          gpaH: r.gpaH,
          gpaDecimals: snapshot?.rules?.gpaDecimals ?? 2,
          letter: r.letter,
          totalH: r.totalH,
          fullMarks: r.fullMarks,
          percentH: r.percentH,
          passed: r.passed,
          classPosition: r.classPosition,
          classSize: sizeOf.get(r.examClassId) ?? 0,
        };
      })
      .sort((a, b) => b.exam.startsOn.localeCompare(a.exam.startsOn));
  }

  async card(studentId: string, examClassId: string): Promise<ReportCards> {
    await this.assertChild(studentId);
    return this.results.childReportCard(examClassId, studentId);
  }

  private async assertChild(studentId: string): Promise<void> {
    const userId = this.context.requirePrincipal().userId;
    const link = await this.db.tx.studentGuardian.findFirst({
      where: { studentId, guardian: { userId }, student: { deletedAt: null } },
      select: { id: true },
    });
    if (!link) throw new NotFoundException('Child not found');
  }
}
