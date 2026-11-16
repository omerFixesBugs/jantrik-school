import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  assignRolls,
  type NumberRollsInput,
  type RollCandidate,
  type RollGroup,
  type RollStrategy,
  type RollsPreview,
  type RollsPreviewRow,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Db } from '../tenancy/db.service.js';
import { PromotionService } from './promotion.service.js';

/**
 * Rolls of a class in the new year, numbered after promotion (P5-A, S15): promoted students first
 * (the strategy of the run they came from), then repeaters (this class's own run), then everyone
 * else enrolled in the year (new admits: Bangla name). Rolls already set are kept and skipped;
 * nothing is ever renumbered. Saving sends back the preview's version (409 PREVIEW_CHANGED when
 * the class's enrolments or rolls changed meanwhile).
 */
@Injectable()
export class RollNumberingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly promotions: PromotionService,
  ) {}

  async preview(toYearId: string, classLevelId: string): Promise<RollsPreview> {
    const tx = this.db.tx;
    const toYear = await this.promotions.year(toYearId);
    const classLevel = await tx.classLevel.findUnique({
      where: { id: classLevelId },
      select: { id: true, nameBn: true, nameEn: true },
    });
    if (!classLevel) throw new NotFoundException('Class level not found');
    const enrolments = await tx.enrolment.findMany({
      // Leavers and deactivated students get no roll (review NIT 8).
      where: {
        academicYearId: toYearId,
        classLevelId,
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        id: true,
        studentId: true,
        sectionId: true,
        roll: true,
        student: { select: { studentCode: true, nameBn: true, nameEn: true } },
      },
      orderBy: { id: 'asc' },
    });
    const rows = await tx.promotionRunStudent.findMany({
      where: { toYearId, toEnrolmentId: { in: enrolments.map((e) => e.id) } },
      select: {
        toEnrolmentId: true,
        decision: true,
        fromRoll: true,
        meritPosition: true,
        run: { select: { id: true, rollStrategy: true, classLevelId: true } },
      },
    });
    const byEnrolment = new Map(rows.map((r) => [r.toEnrolmentId!, r]));
    const strategies = this.strategies(rows, classLevelId);

    const sectionIds = [
      ...new Set(enrolments.map((e) => e.sectionId).filter((s): s is string => s !== null)),
    ];
    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds } },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    // Every roll set in these sections counts as taken, deactivated students' too (the unique
    // index on rolls covers them).
    const taken = await tx.enrolment.findMany({
      where: { sectionId: { in: sectionIds }, roll: { not: null } },
      select: { sectionId: true, roll: true },
    });

    const out: RollsPreview['sections'] = [];
    for (const section of sections) {
      const inSection = enrolments.filter((e) => e.sectionId === section.id);
      const candidates: RollCandidate[] = inSection
        .filter((e) => e.roll === null)
        .map((e) => {
          const row = byEnrolment.get(e.id);
          return {
            id: e.id,
            group: groupOf(row?.decision),
            nameBn: e.student.nameBn,
            nameEn: e.student.nameEn,
            studentCode: e.student.studentCode,
            oldRoll: row?.fromRoll ?? null,
            meritPosition: row?.meritPosition ?? null,
          };
        });
      const proposed = assignRolls(
        candidates,
        strategies,
        new Set(taken.filter((t) => t.sectionId === section.id).map((t) => t.roll!)),
      );
      const previewRows: RollsPreviewRow[] = inSection.map((e) => {
        const row = byEnrolment.get(e.id);
        return {
          enrolmentId: e.id,
          studentId: e.studentId,
          studentCode: e.student.studentCode,
          nameBn: e.student.nameBn,
          nameEn: e.student.nameEn,
          group: groupOf(row?.decision),
          oldRoll: row?.fromRoll ?? null,
          meritPosition: row?.meritPosition ?? null,
          roll: e.roll,
          proposed: e.roll === null ? (proposed.get(e.id) ?? null) : null,
        };
      });
      previewRows.sort(
        (a, b) =>
          (a.roll ?? a.proposed ?? Infinity) - (b.roll ?? b.proposed ?? Infinity) ||
          (a.enrolmentId < b.enrolmentId ? -1 : 1),
      );
      out.push({ section, rows: previewRows });
    }
    // Runs with rows still to apply into this class (review SF3): numbering now would put the
    // students they bring after everyone numbered, against S15's order.
    const pending = await tx.promotionRunStudent.groupBy({
      by: ['runId'],
      where: {
        toYearId,
        targetClassLevelId: classLevelId,
        appliedAt: null,
        decision: { not: 'LEAVE' },
      },
      _count: { _all: true },
    });
    const pendingRuns =
      pending.length === 0
        ? []
        : (
            await tx.promotionRun.findMany({
              where: { id: { in: pending.map((p) => p.runId) } },
              select: {
                id: true,
                classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
              },
              orderBy: [{ classLevel: { sortOrder: 'asc' } }, { id: 'asc' }],
            })
          ).map((r) => ({
            runId: r.id,
            classLevel: {
              id: r.classLevel.id,
              nameBn: r.classLevel.nameBn,
              nameEn: r.classLevel.nameEn,
            },
            pending: pending.find((p) => p.runId === r.id)?._count._all ?? 0,
          }));
    return {
      toYear: { id: toYear.id, name: toYear.name },
      classLevel,
      strategies,
      pendingRuns,
      sections: out,
      withoutSection: enrolments.filter((e) => e.sectionId === null).length,
      version: versionOf(enrolments),
    };
  }

  /**
   * PROMOTED: the strategy of the run that promoted most of this class's students (the class
   * below, normally); REPEATER: this class's own run; NEW: Bangla name. NAME_BN when no run.
   */
  private strategies(
    rows: {
      decision: string;
      run: { id: string; rollStrategy: RollStrategy; classLevelId: string };
    }[],
    classLevelId: string,
  ): Record<RollGroup, RollStrategy> {
    const promotedBy = new Map<string, { n: number; strategy: RollStrategy }>();
    for (const r of rows.filter((x) => x.decision === 'PROMOTE')) {
      const c = promotedBy.get(r.run.id) ?? { n: 0, strategy: r.run.rollStrategy };
      c.n++;
      promotedBy.set(r.run.id, c);
    }
    const promoted = [...promotedBy.entries()].sort(
      (a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1),
    )[0];
    const own = rows.find((r) => r.run.classLevelId === classLevelId)?.run.rollStrategy;
    return {
      PROMOTED: promoted?.[1].strategy ?? 'NAME_BN',
      REPEATER: own ?? 'NAME_BN',
      NEW: 'NAME_BN',
    };
  }

  /**
   * Writes rolls of enrolments that have none (the proposed ones, or MANUAL edits). One class at
   * a time (an advisory lock), refused when the preview changed or a number is taken.
   */
  async save(input: NumberRollsInput): Promise<RollsPreview> {
    const tx = this.db.tx;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('promotion-rolls:' || ${input.toYearId} || ':' || ${input.classLevelId}, 0))`;
    const preview = await this.preview(input.toYearId, input.classLevelId);
    if (preview.version !== input.version)
      throw apiError(409, 'PREVIEW_CHANGED', 'The class changed; look at the numbers again');
    if (preview.pendingRuns.length > 0 && !input.force)
      throw apiError(409, 'RUNS_PENDING', 'Runs into this class are not applied yet', {
        runs: preview.pendingRuns.map((r) => ({ runId: r.runId, pending: r.pending })),
      });
    const written: { enrolmentId: string; sectionId: string; roll: number }[] = [];
    for (const s of input.sections) {
      const section = preview.sections.find((p) => p.section.id === s.sectionId);
      if (!section) throw apiError(409, 'PREVIEW_CHANGED', 'The class changed; look again');
      const taken = new Set(section.rows.filter((r) => r.roll !== null).map((r) => r.roll!));
      for (const t of await tx.enrolment.findMany({
        where: { sectionId: s.sectionId, roll: { in: s.rolls.map((r) => r.roll) } },
        select: { roll: true },
      }))
        taken.add(t.roll!);
      for (const r of s.rolls) {
        const row = section.rows.find((x) => x.enrolmentId === r.enrolmentId);
        if (!row || row.roll !== null)
          throw apiError(409, 'PREVIEW_CHANGED', 'The class changed; look again');
        if (taken.has(r.roll))
          throw apiError(409, 'ROLL_TAKEN', 'This roll is already taken in the section', {
            sectionId: s.sectionId,
            roll: r.roll,
          });
      }
      for (const r of s.rolls) {
        try {
          const { count } = await tx.enrolment.updateMany({
            where: { id: r.enrolmentId, sectionId: s.sectionId, roll: null },
            data: { roll: r.roll },
          });
          if (count === 0) throw apiError(409, 'PREVIEW_CHANGED', 'The class changed; look again');
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw apiError(409, 'ROLL_TAKEN', 'This roll is already taken in the section', {
              sectionId: s.sectionId,
              roll: r.roll,
            });
          throw error;
        }
        written.push({ enrolmentId: r.enrolmentId, sectionId: s.sectionId, roll: r.roll });
      }
    }
    if (written.length > 0)
      await this.audit.record({
        entity: 'class_level',
        entityId: input.classLevelId,
        action: 'UPDATE',
        newValues: { step: 'number_rolls', toYearId: input.toYearId, rolls: written },
      });
    return this.preview(input.toYearId, input.classLevelId);
  }
}

function groupOf(decision: string | undefined): RollGroup {
  if (decision === 'PROMOTE') return 'PROMOTED';
  if (decision === 'REPEAT') return 'REPEATER';
  return 'NEW';
}

function versionOf(enrolments: { id: string; sectionId: string | null; roll: number | null }[]) {
  return createHash('sha256')
    .update(JSON.stringify(enrolments.map((e) => [e.id, e.sectionId, e.roll])))
    .digest('hex')
    .slice(0, 32);
}
