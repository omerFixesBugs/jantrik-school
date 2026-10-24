import { Injectable, NotFoundException } from '@nestjs/common';
import {
  applicableSubjects,
  dateFromDb,
  type AdmitCards,
  type SeatPlan,
  type SeatPlanRoom,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { Db } from '../../tenancy/db.service.js';
import { ExamService } from '../structure/exam.service.js';

const studentName = (s: { nameBn: string | null; nameEn: string | null }) =>
  s.nameEn ?? s.nameBn ?? '';

/**
 * Seat plans and admit cards (OWNER/ADMIN). Seats are given room by room, seat by seat (row by
 * row), taking students from each class in turn, so neighbours on a bench sit different papers.
 */
@Injectable()
export class SeatPlanService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly exams: ExamService,
  ) {}

  async allocate(examId: string, roomIds: string[]): Promise<SeatPlan> {
    const tx = this.db.tx;
    const exam = await this.exams.lockExam(examId);
    if (exam.status !== 'OPEN')
      throw apiError(409, 'NOT_OPEN', 'Seats are given once the exam is open');
    const rooms = await tx.examRoom.findMany({ where: { id: { in: roomIds }, isActive: true } });
    if (rooms.length !== roomIds.length) {
      throw apiError(422, 'UNKNOWN_ROOM', 'A room is unknown or not in use');
    }
    const ordered = roomIds.map((id) => rooms.find((r) => r.id === id)!);
    const candidates = await tx.examCandidate.findMany({
      where: { examId, status: 'ENROLLED' },
      orderBy: [{ section: { name: 'asc' } }, { roll: 'asc' }],
      select: {
        id: true,
        classLevelId: true,
        examClass: { select: { classLevel: { select: { sortOrder: true } } } },
      },
    });
    const capacity = ordered.reduce((n, r) => n + r.rows * r.cols, 0);
    if (capacity < candidates.length) {
      throw apiError(409, 'CAPACITY_SHORT', 'The rooms have too few seats', {
        shortBy: candidates.length - capacity,
      });
    }
    // One queue per class (in class order), taken in turn.
    const queues = new Map<string, { id: string; sort: number }[]>();
    for (const c of candidates) {
      const q = queues.get(c.classLevelId) ?? [];
      q.push({ id: c.id, sort: c.examClass.classLevel.sortOrder });
      queues.set(c.classLevelId, q);
    }
    const lines = [...queues.values()].sort((a, b) => a[0]!.sort - b[0]!.sort);
    const sequence: string[] = [];
    while (lines.some((q) => q.length > 0)) {
      for (const q of lines) {
        const next = q.shift();
        if (next) sequence.push(next.id);
      }
    }
    await tx.examCandidate.updateMany({ where: { examId }, data: { roomId: null, seatNo: null } });
    let i = 0;
    for (const room of ordered) {
      for (let seat = 1; seat <= room.rows * room.cols && i < sequence.length; seat++, i++) {
        await tx.examCandidate.update({
          where: { id: sequence[i]! },
          data: { roomId: room.id, seatNo: seat },
        });
      }
    }
    await this.audit.record({
      entity: 'exam_candidates',
      entityId: examId,
      action: 'UPDATE',
      newValues: { seatPlan: roomIds, seated: sequence.length },
    });
    return this.plan(examId);
  }

  async clear(examId: string): Promise<void> {
    await this.exams.lockExam(examId);
    const cleared = await this.db.tx.examCandidate.updateMany({
      where: { examId, roomId: { not: null } },
      data: { roomId: null, seatNo: null },
    });
    await this.audit.record({
      entity: 'exam_candidates',
      entityId: examId,
      action: 'UPDATE',
      newValues: { seatPlan: [], cleared: cleared.count },
    });
  }

  async plan(examId: string): Promise<SeatPlan> {
    await this.exams.detail(examId);
    const tx = this.db.tx;
    const seated = await tx.examCandidate.findMany({
      where: { examId, status: 'ENROLLED', roomId: { not: null } },
      orderBy: { seatNo: 'asc' },
      include: {
        student: { select: { studentCode: true, nameBn: true, nameEn: true } },
        section: { select: { name: true } },
        examClass: {
          select: { classLevel: { select: { id: true, code: true, nameBn: true, nameEn: true } } },
        },
      },
    });
    const unseated = await tx.examCandidate.count({
      where: { examId, status: 'ENROLLED', roomId: null },
    });
    const roomIds = [...new Set(seated.map((s) => s.roomId!))];
    const rooms = await tx.examRoom.findMany({
      where: { id: { in: roomIds } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const out: SeatPlanRoom[] = rooms.map((room) => ({
      room: {
        id: room.id,
        name: room.name,
        rows: room.rows,
        cols: room.cols,
        capacity: room.rows * room.cols,
        isActive: room.isActive,
      },
      seats: seated
        .filter((s) => s.roomId === room.id)
        .map((s) => ({
          seatNo: s.seatNo!,
          candidateId: s.id,
          roll: s.roll,
          studentCode: s.student.studentCode,
          name: studentName(s.student),
          classLevel: s.examClass.classLevel,
          sectionName: s.section.name,
        })),
    }));
    return { rooms: out, unseated };
  }

  /** One card per enrolled candidate: who, where they sit, and their own papers' routine. */
  async admitCards(
    examId: string,
    filter: { sectionId?: string; classLevelId?: string },
  ): Promise<AdmitCards> {
    const tx = this.db.tx;
    await this.exams.detail(examId);
    const exam = await tx.exam.findUnique({
      where: { id: examId },
      include: {
        tenant: { select: { name: true } },
        classes: {
          include: {
            subjects: {
              orderBy: { sortOrder: 'asc' },
              include: {
                subject: { select: { id: true, code: true, nameBn: true, nameEn: true } },
              },
            },
          },
        },
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    const candidates = await tx.examCandidate.findMany({
      where: {
        examId,
        status: 'ENROLLED',
        ...(filter.sectionId ? { sectionId: filter.sectionId } : {}),
        ...(filter.classLevelId ? { classLevelId: filter.classLevelId } : {}),
      },
      orderBy: [{ section: { name: 'asc' } }, { roll: 'asc' }],
      include: {
        student: { select: { studentCode: true, nameBn: true, nameEn: true, photoUrl: true } },
        section: { select: { id: true, name: true } },
        studyGroup: { select: { id: true, code: true, nameBn: true, nameEn: true } },
        room: { select: { name: true } },
        examClass: {
          select: { classLevel: { select: { id: true, code: true, nameBn: true, nameEn: true } } },
        },
      },
    });
    const choices = await tx.studentSubjectChoice.findMany({
      where: {
        academicYearId: exam.academicYearId,
        studentId: { in: candidates.map((c) => c.studentId) },
      },
      select: { studentId: true, subjectId: true, kind: true },
    });
    return {
      institute: { name: exam.tenant.name },
      exam: {
        id: exam.id,
        nameBn: exam.nameBn,
        nameEn: exam.nameEn,
        startsOn: dateFromDb(exam.startsOn),
        endsOn: dateFromDb(exam.endsOn),
      },
      cards: candidates.map((c) => {
        const subjects =
          exam.classes.find((ec) => ec.classLevelId === c.classLevelId)?.subjects ?? [];
        const taken = new Set(
          applicableSubjects(
            subjects.map((s) => ({
              subjectId: s.subjectId,
              studyGroupId: s.studyGroupId,
              isElective: s.isElective,
            })),
            { studyGroupId: c.studyGroupId },
            choices.filter((x) => x.studentId === c.studentId),
          ).map((a) => a.subjectId),
        );
        return {
          candidateId: c.id,
          student: c.student,
          classLevel: c.examClass.classLevel,
          section: c.section,
          studyGroup: c.studyGroup,
          roll: c.roll,
          seat: c.room && c.seatNo ? { roomName: c.room.name, seatNo: c.seatNo } : null,
          routine: subjects
            .filter((s) => taken.has(s.subjectId))
            .map((s) => ({
              subject: s.subject,
              examDate: s.examDate ? dateFromDb(s.examDate) : null,
              startTime: s.startTime,
            }))
            .sort((a, b) => (a.examDate ?? '9999').localeCompare(b.examDate ?? '9999')),
        };
      }),
    };
  }
}
