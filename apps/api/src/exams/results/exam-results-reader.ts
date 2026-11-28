import { Injectable } from '@nestjs/common';
import { Db } from '../../tenancy/db.service.js';

export interface PublishedExam {
  id: string;
  nameBn: string;
  nameEn: string;
  kind: string;
  endsOn: Date;
}

export interface PublishedResult {
  passed: boolean;
  /** NULL: unranked (a failed student when the exam leaves them out of the merit list). */
  classPosition: number | null;
}

/**
 * Read-only access to published results for other modules (CLAUDE.md rule 4: modules talk through
 * services, not each other's tables). Promotion uses it for its defaults and the merit order (P5).
 * Only results of a class that is published now count, in that class's published version.
 */
@Injectable()
export class ExamResultsReader {
  constructor(private readonly db: Db) {}

  /** Exams of a year whose given class is published, latest end date first. */
  async publishedExams(
    academicYearId: string,
    classLevelId: string,
    kind?: 'ANNUAL',
  ): Promise<PublishedExam[]> {
    return this.db.tx.exam.findMany({
      where: {
        academicYearId,
        ...(kind ? { kind } : {}),
        classes: { some: { classLevelId, isPublished: true } },
      },
      orderBy: [{ endsOn: 'desc' }, { startsOn: 'desc' }, { id: 'desc' }],
      select: { id: true, nameBn: true, nameEn: true, kind: true, endsOn: true },
    });
  }

  /** Is this exam of that year published for that class? */
  async isPublishedFor(examId: string, academicYearId: string, classLevelId: string) {
    const found = await this.db.tx.examClass.findFirst({
      where: { examId, classLevelId, isPublished: true, exam: { academicYearId } },
      select: { id: true },
    });
    return found !== null;
  }

  /** The published results of one exam's class, by student. */
  async results(examId: string, classLevelId: string): Promise<Map<string, PublishedResult>> {
    const examClass = await this.db.tx.examClass.findFirst({
      where: { examId, classLevelId, isPublished: true },
      select: { id: true, publishedVersion: true },
    });
    if (!examClass) return new Map();
    const rows = await this.db.tx.examResult.findMany({
      where: { examClassId: examClass.id, publishedVersion: examClass.publishedVersion },
      select: { studentId: true, passed: true, classPosition: true },
    });
    return new Map(
      rows.map((r) => [r.studentId, { passed: r.passed, classPosition: r.classPosition }]),
    );
  }

  /** Classes of a year whose ANNUAL exam is published (any ANNUAL exam of the year). */
  async classesWithPublishedAnnual(academicYearId: string): Promise<Set<string>> {
    const rows = await this.db.tx.examClass.findMany({
      where: { isPublished: true, exam: { academicYearId, kind: 'ANNUAL' } },
      select: { classLevelId: true },
    });
    return new Set(rows.map((r) => r.classLevelId));
  }
}
