import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ADMISSION_APPROVAL_PROBLEMS,
  approvableStatuses,
  dateFromDb,
  type AdmissionApprovalProblem,
  type AdmissionBulkApproveStatus,
  type ApproveAdmission,
  type StudentProfile,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { FILE_STORE, type FileStore } from '../files/file-store.js';
import { StudentAdminService } from '../students/student-admin.service.js';
import { Db } from '../tenancy/db.service.js';
import { AdmissionApplicationsService } from './applications.service.js';

export const ADMISSION_QUEUE = 'admission';
export const BULK_APPROVE_JOB = 'bulk-approve';

export interface BulkApproveJob {
  tenantId: string;
  cycleClassId: string;
  sectionId: string;
  /** The admin who started it (from the request's own principal); checked again per row. */
  actorUserId: string;
}

/** Problems that stop a bulk run: every later application would fail the same way (P3-T). */
const STOPPING: AdmissionApprovalProblem[] = ['STUDENT_LIMIT', 'SECTION_FULL', 'INACTIVE'];

export type PhotoOutcome = 'MOVED' | 'NONE' | 'STORAGE_FULL';

export interface ApproveResult {
  studentId: string;
  studentCode: string;
  /** The applicant's photo became the student's photo, there was none, or storage was full (P3-V). */
  photo: PhotoOutcome;
}

/** BullMQ job ids may not contain ':'. */
export const bulkJobId = (cycleClassId: string) => `admission-approve-${cycleClassId}`;

/**
 * Approval (sprint 1 P3a): an application becomes a student and guardian through
 * StudentAdminService.admit(), unchanged, in the caller's transaction. The application row is
 * locked first, so two approvals of one application (two admins, or an admin and the bulk job)
 * make one student; the other gets 409 (review focus 5).
 */
@Injectable()
export class AdmissionApprovalService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    private readonly students: StudentAdminService,
    private readonly applications: AdmissionApplicationsService,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @InjectQueue(ADMISSION_QUEUE) private readonly queue: Queue<BulkApproveJob>,
  ) {}

  async approve(id: string, input: ApproveAdmission): Promise<ApproveResult> {
    const tx = this.db.tx;
    const app = await this.applications.lockRow(id);
    if (app.studentId) {
      throw apiError(409, 'ALREADY_ADMITTED', 'This application is already a student');
    }
    const ctx = await tx.admissionApplication.findUniqueOrThrow({
      where: { id },
      select: {
        cycle: { select: { requiresTest: true, academicYearId: true } },
        cycleClass: { select: { classLevelId: true, studyGroupId: true } },
      },
    });
    if (!approvableStatuses(ctx.cycle.requiresTest).includes(app.status)) {
      throw apiError(409, 'APPLICATION_NOT_APPROVABLE', 'This application cannot be approved', {
        status: app.status,
      });
    }
    const profile: StudentProfile = await this.students.admit({
      nameBn: app.nameBn,
      nameEn: app.nameEn,
      dateOfBirth: dateFromDb(app.dateOfBirth),
      gender: app.gender,
      religion: app.religion,
      bloodGroup: app.bloodGroup,
      birthRegistrationNo: app.birthRegistrationNo,
      fatherNameBn: app.fatherNameBn,
      fatherNameEn: app.fatherNameEn,
      motherNameBn: app.motherNameBn,
      motherNameEn: app.motherNameEn,
      presentAddress: app.presentAddress,
      permanentAddress: app.permanentAddress,
      studentCode: input.studentCode ?? null,
      guardians: [
        {
          phone: app.phone,
          nameBn: app.guardianNameBn,
          nameEn: app.guardianNameEn,
          relation: app.guardianRelation,
          isPrimary: true,
          occupation: app.guardianOccupation,
          guardianId: input.guardianId ?? null,
          createNew: input.createNew ?? false,
        },
      ],
      enrolment: {
        academicYearId: ctx.cycle.academicYearId,
        classLevelId: ctx.cycleClass.classLevelId,
        studyGroupId: ctx.cycleClass.studyGroupId,
        sectionId: input.sectionId ?? null,
        roll: input.roll ?? null,
      },
    });
    const photo = await this.movePhoto(id, profile.id);
    await tx.admissionApplication.update({
      where: { id },
      data: {
        status: 'ADMITTED',
        studentId: profile.id,
        statusBy: this.context.requirePrincipal().userId,
        statusAt: this.clock.now(),
        statusReason: null,
        approvalProblem: null,
        approvalProblemAt: null,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_application',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: app.status, studentId: null },
      newValues: { status: 'ADMITTED', studentId: profile.id, photo },
    });
    return { studentId: profile.id, studentCode: profile.studentCode, photo };
  }

  /**
   * The applicant's photo becomes the student's (decision P3-B); when the institute's storage is
   * full the student is made without it and the photo stays on the application (P3-V).
   */
  private async movePhoto(applicationId: string, studentId: string): Promise<PhotoOutcome> {
    const tx = this.db.tx;
    const key = { tenantId: this.context.requireTenantId(), applicationId };
    const photo = await tx.admissionApplicationPhoto.findUnique({
      where: { tenantId_applicationId: key },
      select: { bytes: true, width: true, height: true },
    });
    if (!photo) return 'NONE';
    let storedId: string;
    try {
      const stored = await this.files.put({
        kind: 'STUDENT_PHOTO',
        mime: 'image/jpeg',
        bytes: Buffer.from(photo.bytes),
        width: photo.width,
        height: photo.height,
      });
      storedId = stored.id;
    } catch (error) {
      if (problemCode(error) === 'STORAGE_FULL') return 'STORAGE_FULL';
      throw error;
    }
    await tx.student.update({
      where: { id: studentId },
      data: { photoFileId: storedId },
      select: { id: true },
    });
    await tx.admissionApplicationPhoto.delete({ where: { tenantId_applicationId: key } });
    await this.audit.record({
      entity: 'student',
      entityId: studentId,
      action: 'UPDATE',
      oldValues: { photoFileId: null },
      newValues: { photoFileId: storedId, fromApplication: applicationId },
    });
    return 'MOVED';
  }

  // ─────────────────────────── Bulk approval (a queue job, decision P3-T) ───────────────────────────

  async startBulk(cycleClassId: string, sectionId: string): Promise<AdmissionBulkApproveStatus> {
    const tx = this.db.tx;
    const cc = await tx.admissionCycleClass.findUnique({
      where: { id: cycleClassId },
      select: { classLevelId: true, cycle: { select: { academicYearId: true } } },
    });
    if (!cc) throw new NotFoundException('Admission class not found');
    const section = await tx.section.findUnique({
      where: { id: sectionId },
      select: { academicYearId: true, classLevelId: true, isActive: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (
      section.academicYearId !== cc.cycle.academicYearId ||
      section.classLevelId !== cc.classLevelId
    ) {
      throw apiError(422, 'SECTION_MISMATCH', 'The section is not in that year and class', {
        field: 'sectionId',
      });
    }
    if (!section.isActive) {
      throw apiError(422, 'INACTIVE', 'This section is deactivated', { field: 'sectionId' });
    }
    if (await this.running(cycleClassId)) {
      throw apiError(409, 'BULK_RUNNING', 'Bulk approval is already running for this class');
    }
    const principal = this.context.requirePrincipal();
    await this.audit.record({
      entity: 'admission_cycle_class',
      entityId: cycleClassId,
      action: 'UPDATE',
      newValues: { bulkApprove: { sectionId } },
    });
    const data: BulkApproveJob = {
      tenantId: this.context.requireTenantId(),
      cycleClassId,
      sectionId,
      actorUserId: principal.userId,
    };
    await this.context.afterCommit(() =>
      this.queue.add(BULK_APPROVE_JOB, data, {
        jobId: bulkJobId(cycleClassId),
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    return { ...(await this.bulkStatus(cycleClassId)), running: true };
  }

  async bulkStatus(cycleClassId: string): Promise<AdmissionBulkApproveStatus> {
    const tx = this.db.tx;
    const cc = await tx.admissionCycleClass.findUnique({
      where: { id: cycleClassId },
      select: { id: true },
    });
    if (!cc) throw new NotFoundException('Admission class not found');
    const [admitted, problems] = await Promise.all([
      tx.admissionApplication.count({ where: { cycleClassId, status: 'ADMITTED' } }),
      tx.admissionApplication.findMany({
        where: {
          cycleClassId,
          approvalProblem: { not: null },
          studentId: null,
          status: { notIn: ['REJECTED', 'WITHDRAWN'] },
        },
        orderBy: { applicationNo: 'asc' },
        select: { id: true, applicationNo: true, approvalProblem: true },
      }),
    ]);
    return {
      running: await this.running(cycleClassId),
      admitted,
      problems: problems.map((p) => ({
        applicationId: p.id,
        applicationNo: p.applicationNo,
        code: p.approvalProblem as AdmissionApprovalProblem,
      })),
    };
  }

  private async running(cycleClassId: string): Promise<boolean> {
    const job = await this.queue.getJob(bulkJobId(cycleClassId));
    if (!job) return false;
    const state = await job.getState();
    return (
      state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized'
    );
  }

  /** Job, step 1 (acting as the admin): the applications to approve, or none if they lost the role. */
  async bulkCandidates(cycleClassId: string, actorUserId: string): Promise<string[]> {
    const tx = this.db.tx;
    if (!(await this.actorAllowed(actorUserId))) return [];
    const cc = await tx.admissionCycleClass.findUnique({
      where: { id: cycleClassId },
      select: { id: true },
    });
    if (!cc) return [];
    // Only applications staff (or the merit list) SELECTED: the approved sprint plan's "bulk
    // approve for SELECTED rows" (review S2). One at a time keeps P3-H.
    const rows = await tx.admissionApplication.findMany({
      where: { cycleClassId, studentId: null, status: 'SELECTED' },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Job, step 2 (one transaction per application, acting as the admin): approve it into the
   * section unless it was approved, withdrawn or rejected meanwhile, or the admin lost the role.
   * Returns false when the run must stop (the role).
   */
  async approveInBulk(id: string, sectionId: string, actorUserId: string): Promise<boolean> {
    if (!(await this.actorAllowed(actorUserId))) return false;
    const app = await this.db.tx.admissionApplication.findUnique({
      where: { id },
      select: { studentId: true, status: true },
    });
    if (!app || app.studentId || app.status !== 'SELECTED') return true;
    try {
      await this.approve(id, {
        sectionId,
        roll: null,
        studentCode: null,
        guardianId: null,
        createNew: false,
      });
    } catch (error) {
      // ALREADY_ADMITTED / NOT_APPROVABLE under the lock: someone else got there first.
      const code = (error as HttpException).getResponse?.() as { code?: string } | undefined;
      if (code?.code === 'ALREADY_ADMITTED' || code?.code === 'APPLICATION_NOT_APPROVABLE') {
        return true;
      }
      throw error;
    }
    return true;
  }

  /** Job: remember why an application was skipped (its own transaction, after the rollback). */
  async markProblem(ids: string[], code: AdmissionApprovalProblem): Promise<void> {
    if (ids.length === 0) return;
    await this.db.tx.admissionApplication.updateMany({
      where: { id: { in: ids }, studentId: null },
      data: { approvalProblem: code, approvalProblemAt: this.clock.now() },
    });
    for (const id of ids) {
      await this.audit.record({
        entity: 'admission_application',
        entityId: id,
        action: 'UPDATE',
        newValues: { approvalProblem: code },
      });
    }
  }

  private async actorAllowed(userId: string): Promise<boolean> {
    const m = await this.db.tx.membership.findFirst({
      where: { userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { id: true },
    });
    return m !== null;
  }
}

/** The problem code of an approval error, or null when it is not one we record. */
export function problemCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? String((body as { code: unknown }).code)
    : null;
}

/** Maps an approval error to what the application records (P3-T); unknown errors: INVALID. */
export function approvalProblem(error: unknown): AdmissionApprovalProblem {
  const code = problemCode(error);
  if (code && (ADMISSION_APPROVAL_PROBLEMS as readonly string[]).includes(code)) {
    return code as AdmissionApprovalProblem;
  }
  return 'INVALID';
}

export const stopsBulk = (p: AdmissionApprovalProblem) => STOPPING.includes(p);
