import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ExamComponentView,
  ExamRoomInput,
  ExamRoomView,
  ExamSetupSubjects,
  GradeBandView,
  GradingRulesInput,
  GradingSchemeView,
  LoadTemplateMarksResult,
  SubjectMarksInput,
  SubjectMarksView,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { RequestContext } from '../../common/request-context.js';
import { Db } from '../../tenancy/db.service.js';

const subjectInclude = {
  studyGroup: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  components: { orderBy: { sortOrder: 'asc' } },
  passGroups: { orderBy: { kind: 'asc' } },
} as const;

type Decimalish = { toNumber(): number };

const toBand = (b: {
  minPercent: Decimalish;
  maxPercent: Decimalish;
  letter: string;
  gradePoint: Decimalish;
}): GradeBandView => ({
  minPercent: b.minPercent.toNumber(),
  maxPercent: b.maxPercent.toNumber(),
  letter: b.letter,
  gradePoint: b.gradePoint.toNumber(),
});

const toComponent = (c: {
  key: string;
  kind: ExamComponentView['kind'];
  nameBn: string;
  nameEn: string;
  fullMarks: number;
  passMarks: number | null;
}): ExamComponentView => ({
  key: c.key,
  kind: c.kind,
  nameBn: c.nameBn,
  nameEn: c.nameEn,
  fullMarks: c.fullMarks,
  passMarks: c.passMarks,
});

/**
 * Exams setup (OWNER/ADMIN, docs/exams.md): each subject's default parts and pass rule, the
 * grading schemes' GPA rules and the exam rooms. Every write is audited.
 */
@Injectable()
export class ExamSetupService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Subject marks ───────────────────────────

  async subjects(classLevelId: string): Promise<ExamSetupSubjects> {
    const tx = this.db.tx;
    const classLevel = await tx.classLevel.findUnique({
      where: { id: classLevelId },
      select: { id: true, code: true, nameBn: true, nameEn: true, gradingSchemeId: true },
    });
    if (!classLevel) throw new NotFoundException('Class not found');
    const scheme = await tx.gradingScheme.findFirst({
      where: classLevel.gradingSchemeId ? { id: classLevel.gradingSchemeId } : { isDefault: true },
      include: { bands: { orderBy: { minPercent: 'desc' } } },
    });
    const rows = await tx.subject.findMany({
      where: { classLevelId },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: subjectInclude,
    });
    return {
      classLevel: {
        id: classLevel.id,
        code: classLevel.code,
        nameBn: classLevel.nameBn,
        nameEn: classLevel.nameEn,
      },
      bands: scheme?.bands.map(toBand) ?? [],
      subjects: rows.map(toSubjectMarks),
    };
  }

  /** Replace a subject's default parts, pass rule and combined pass marks. */
  async saveSubjectMarks(subjectId: string, input: SubjectMarksInput): Promise<SubjectMarksView> {
    const tx = this.db.tx;
    const before = await this.subjectMarks(subjectId);
    const tenantId = this.tenantId;
    await tx.subjectComponent.deleteMany({ where: { subjectId } });
    await tx.subjectPassGroup.deleteMany({ where: { subjectId } });
    await tx.subjectComponent.createMany({
      data: input.components.map((c, i) => ({
        tenantId,
        subjectId,
        key: c.key,
        kind: c.kind,
        nameBn: c.nameBn,
        nameEn: c.nameEn,
        fullMarks: c.fullMarks,
        passMarks: c.passMarks,
        sortOrder: i,
      })),
    });
    if (input.passRule === 'COMBINED') {
      await tx.subjectPassGroup.createMany({
        data: input.passGroups.map((g) => ({
          tenantId,
          subjectId,
          kind: g.kind,
          passMarks: g.passMarks,
        })),
      });
    }
    await tx.subject.update({ where: { id: subjectId }, data: { passRule: input.passRule } });
    const after = await this.subjectMarks(subjectId);
    await this.audit.record({
      entity: 'subject_components',
      entityId: subjectId,
      action: 'UPDATE',
      oldValues: marksSnapshot(before),
      newValues: marksSnapshot(after),
    });
    return after;
  }

  /**
   * Copy the institute type's default parts into subjects that came from the template and have
   * none (institutes created before the exams module, or a subject an admin emptied).
   */
  async loadTemplateMarks(): Promise<LoadTemplateMarksResult> {
    const tx = this.db.tx;
    const tenantId = this.tenantId;
    const empty = await tx.subject.findMany({
      where: { sourceTemplateId: { not: null }, components: { none: {} } },
      select: { id: true, sourceTemplateId: true },
    });
    const templates = await tx.templateSubject.findMany({
      where: { id: { in: empty.map((s) => s.sourceTemplateId!) } },
      include: { components: { orderBy: { sortOrder: 'asc' } }, passGroups: true },
    });
    const byId = new Map(templates.map((t) => [t.id, t]));
    const filled: string[] = [];
    for (const subject of empty) {
      const template = byId.get(subject.sourceTemplateId!);
      if (!template || template.components.length === 0) continue;
      await tx.subjectPassGroup.deleteMany({ where: { subjectId: subject.id } });
      await tx.subjectComponent.createMany({
        data: template.components.map((c) => ({
          tenantId,
          subjectId: subject.id,
          key: c.key,
          kind: c.kind,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          fullMarks: c.fullMarks,
          passMarks: c.passMarks,
          sortOrder: c.sortOrder,
          sourceTemplateId: c.id,
        })),
      });
      await tx.subjectPassGroup.createMany({
        data: template.passGroups.map((g) => ({
          tenantId,
          subjectId: subject.id,
          kind: g.kind,
          passMarks: g.passMarks,
        })),
      });
      await tx.subject.update({ where: { id: subject.id }, data: { passRule: template.passRule } });
      filled.push(subject.id);
    }
    if (filled.length > 0) {
      await this.audit.record({
        entity: 'subject_components',
        // One entry for the run; the tenant id identifies it.
        entityId: tenantId,
        action: 'UPDATE',
        newValues: { loadedTemplateFor: filled },
      });
    }
    return { filled: filled.length };
  }

  private async subjectMarks(subjectId: string): Promise<SubjectMarksView> {
    const row = await this.db.tx.subject.findUnique({
      where: { id: subjectId },
      include: subjectInclude,
    });
    if (!row) throw new NotFoundException('Subject not found');
    return toSubjectMarks(row);
  }

  // ─────────────────────────── Grading ───────────────────────────

  async gradingSchemes(): Promise<GradingSchemeView[]> {
    const rows = await this.db.tx.gradingScheme.findMany({
      orderBy: [{ isDefault: 'desc' }, { nameEn: 'asc' }],
      include: {
        bands: { orderBy: { minPercent: 'desc' } },
        classLevels: {
          select: { id: true, nameBn: true, nameEn: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    return rows.map(toScheme);
  }

  async saveGradingRules(id: string, input: GradingRulesInput): Promise<GradingSchemeView> {
    const tx = this.db.tx;
    const before = (await this.gradingSchemes()).find((s) => s.id === id);
    if (!before) throw new NotFoundException('Grading scheme not found');
    await tx.gradingScheme.update({ where: { id }, data: { ...input } });
    const after = (await this.gradingSchemes()).find((s) => s.id === id)!;
    await this.audit.record({
      entity: 'grading_schemes',
      entityId: id,
      action: 'UPDATE',
      oldValues: rulesOf(before),
      newValues: rulesOf(after),
    });
    return after;
  }

  // ─────────────────────────── Rooms ───────────────────────────

  async rooms(): Promise<ExamRoomView[]> {
    const rows = await this.db.tx.examRoom.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toRoom);
  }

  async createRoom(input: ExamRoomInput): Promise<ExamRoomView> {
    const row = await this.db.tx.examRoom.create({
      data: { tenantId: this.tenantId, ...roomData(input) },
    });
    await this.audit.record({
      entity: 'exam_rooms',
      entityId: row.id,
      action: 'CREATE',
      newValues: roomData(input),
    });
    return toRoom(row);
  }

  async updateRoom(id: string, input: ExamRoomInput): Promise<ExamRoomView> {
    const before = await this.room(id);
    const row = await this.db.tx.examRoom.update({ where: { id }, data: roomData(input) });
    await this.audit.record({
      entity: 'exam_rooms',
      entityId: id,
      action: 'UPDATE',
      oldValues: roomData(before),
      newValues: roomData(input),
    });
    return toRoom(row);
  }

  async deleteRoom(id: string): Promise<void> {
    const before = await this.room(id);
    await this.db.tx.examRoom.delete({ where: { id } });
    await this.audit.record({
      entity: 'exam_rooms',
      entityId: id,
      action: 'DELETE',
      oldValues: roomData(before),
    });
  }

  private async room(id: string) {
    const row = await this.db.tx.examRoom.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Room not found');
    return row;
  }
}

function toSubjectMarks(s: {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  isOptional: boolean;
  isActive: boolean;
  passRule: SubjectMarksView['passRule'];
  sourceTemplateId: string | null;
  studyGroup: { id: string; code: string; nameBn: string; nameEn: string } | null;
  components: Parameters<typeof toComponent>[0][];
  passGroups: { kind: ExamComponentView['kind']; passMarks: number }[];
}): SubjectMarksView {
  return {
    id: s.id,
    code: s.code,
    nameBn: s.nameBn,
    nameEn: s.nameEn,
    isOptional: s.isOptional,
    isActive: s.isActive,
    studyGroup: s.studyGroup,
    passRule: s.passRule,
    components: s.components.map(toComponent),
    passGroups: s.passGroups.map((g) => ({ kind: g.kind, passMarks: g.passMarks })),
    fromTemplate: s.sourceTemplateId !== null,
  };
}

const marksSnapshot = (m: SubjectMarksView) => ({
  passRule: m.passRule,
  components: m.components.map((c) => ({ ...c })),
  passGroups: m.passGroups.map((g) => ({ ...g })),
});

function toScheme(s: {
  id: string;
  nameBn: string;
  nameEn: string;
  isDefault: boolean;
  roundingMode: GradingSchemeView['roundingMode'];
  gpaMax: Decimalish;
  optionalBonusAbove: Decimalish | null;
  gpaDecimals: number;
  gpaRounding: GradingSchemeView['gpaRounding'];
  compulsoryFailZero: boolean;
  bands: Parameters<typeof toBand>[0][];
  classLevels: { id: string; nameBn: string; nameEn: string }[];
}): GradingSchemeView {
  return {
    id: s.id,
    nameBn: s.nameBn,
    nameEn: s.nameEn,
    isDefault: s.isDefault,
    roundingMode: s.roundingMode,
    gpaMax: s.gpaMax.toNumber(),
    optionalBonusAbove: s.optionalBonusAbove?.toNumber() ?? null,
    gpaDecimals: s.gpaDecimals,
    gpaRounding: s.gpaRounding,
    compulsoryFailZero: s.compulsoryFailZero,
    bands: s.bands.map(toBand),
    classLevels: s.classLevels,
  };
}

const rulesOf = (s: GradingSchemeView) => ({
  roundingMode: s.roundingMode,
  gpaMax: s.gpaMax,
  optionalBonusAbove: s.optionalBonusAbove,
  gpaDecimals: s.gpaDecimals,
  gpaRounding: s.gpaRounding,
  compulsoryFailZero: s.compulsoryFailZero,
});

const roomData = (r: { name: string; rows: number; cols: number; isActive?: boolean }) => ({
  name: r.name,
  rows: r.rows,
  cols: r.cols,
  isActive: r.isActive ?? true,
});

const toRoom = (r: {
  id: string;
  name: string;
  rows: number;
  cols: number;
  isActive: boolean;
}): ExamRoomView => ({
  id: r.id,
  name: r.name,
  rows: r.rows,
  cols: r.cols,
  capacity: r.rows * r.cols,
  isActive: r.isActive,
});
