import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  dateToDb,
  resultSmsText,
  smsLength,
  type ResultSmsPreview,
  type ResultSmsRun,
  type ResultSmsStatus,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AttendanceSettingsService } from '../../attendance/attendance-settings.service.js';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { TenantSmsService } from '../../sms/tenant-sms.service.js';
import { Db } from '../../tenancy/db.service.js';

export const EXAMS_QUEUE = 'exams';
export const SEND_RESULT_SMS_JOB = 'send-result-sms';

export interface ResultSmsJobData {
  tenantId: string;
  actorUserId: string;
  runId: string;
  examClassId: string;
  version: number;
}

/** The SMS of one published version of a class (sms_logs.related_entity). */
const versionEntity = (examClassId: string, version: number) =>
  `exam_result:${examClassId}:v${version}`;
const dedupeKey = (examClassId: string, version: number, studentId: string) =>
  `exam-result:${examClassId}:v${version}:${studentId}`;
const VERSION_ENTITY_RE = /^exam_result:([0-9a-f-]{36}):v(\d+)$/;

interface Recipient {
  studentId: string;
  name: string;
  phone: string | null;
  text: string;
}

/**
 * Result SMS (OWNER/ADMIN, docs/exams.md): never automatic. A preview gives the count and the
 * cost; the confirmation must match it; a background job (25 students per transaction, acting as
 * the admin) queues one SMS per student per published version through TenantSmsService. Over the
 * shared daily cap an SMS is skipped (no row), so it can go out another day. Just before sending,
 * an SMS is cancelled if that version is no longer the published one.
 */
@Injectable()
export class ResultSmsService implements OnModuleInit {
  constructor(
    @InjectQueue(EXAMS_QUEUE) private readonly queue: Queue<ResultSmsJobData>,
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly sms: TenantSmsService,
    private readonly settings: AttendanceSettingsService,
  ) {}

  onModuleInit(): void {
    this.sms.registerRelevanceCheck('EXAM_RESULT', async ({ relatedEntity }) => {
      const m = relatedEntity ? VERSION_ENTITY_RE.exec(relatedEntity) : null;
      if (!m) return false;
      const examClass = await this.db.tx.examClass.findUnique({
        where: { id: m[1]! },
        select: { isPublished: true, publishedVersion: true },
      });
      return !!examClass?.isPublished && examClass.publishedVersion === Number(m[2]);
    });
  }

  async preview(examId: string, examClassId: string): Promise<ResultSmsPreview> {
    const tx = this.db.tx;
    const examClass = await this.publishedClass(examId, examClassId);
    const recipients = await this.recipients(examClass);
    const sent = await this.alreadySent(examClassId, examClass.publishedVersion, recipients);
    const toSend = recipients.filter((r) => r.phone && !sent.has(r.studentId));
    const segments = toSend.reduce((n, r) => n + smsLength(r.text).segments, 0);
    const [rate] = await tx.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM platform_settings`;
    const { today } = await this.settings.load();
    const used = await tx.smsLog.count({
      where: { localDate: dateToDb(today), status: { in: ['QUEUED', 'SENT'] } },
    });
    const capLeft = Math.max(0, (await this.settings.smsDailyCap()) - used);
    return {
      publishedVersion: examClass.publishedVersion,
      students: recipients.length,
      withoutPhone: recipients.filter((r) => !r.phone).length,
      alreadySent: recipients.filter((r) => r.phone && sent.has(r.studentId)).length,
      toSend: toSend.length,
      segments,
      costPaisa: segments * Number(rate?.rate ?? 0),
      capLeftToday: capLeft,
      wouldBeSkipped: Math.max(0, toSend.length - capLeft),
      sampleText: toSend[0]?.text ?? recipients[0]?.text ?? null,
    };
  }

  async send(examId: string, examClassId: string, expected: number): Promise<ResultSmsRun> {
    const preview = await this.preview(examId, examClassId);
    if (preview.toSend !== expected) {
      throw apiError(409, 'PREVIEW_CHANGED', 'The number of SMS changed: preview again', {
        toSend: preview.toSend,
      });
    }
    const examClass = await this.publishedClass(examId, examClassId);
    const recipients = await this.recipients(examClass);
    const sent = await this.alreadySent(examClassId, examClass.publishedVersion, recipients);
    const studentIds = recipients
      .filter((r) => r.phone && !sent.has(r.studentId))
      .map((r) => r.studentId);
    const runId = randomUUID();
    await this.audit.record({
      entity: 'exam_result_sms_run',
      entityId: runId,
      action: 'CREATE',
      newValues: {
        examClassId,
        version: examClass.publishedVersion,
        studentIds,
        costPaisa: preview.costPaisa,
      },
    });
    const data: ResultSmsJobData = {
      tenantId: this.context.requireTenantId(),
      actorUserId: this.context.requirePrincipal().userId,
      runId,
      examClassId,
      version: examClass.publishedVersion,
    };
    await this.context.afterCommit(() =>
      this.queue.add(SEND_RESULT_SMS_JOB, data, { removeOnComplete: true, removeOnFail: 50 }),
    );
    return { runId, queued: studentIds.length };
  }

  /** The run's students (the job reads them back from its audit row). */
  async runStudents(runId: string): Promise<string[]> {
    const row = await this.db.tx.auditLog.findFirst({
      where: { entity: 'exam_result_sms_run', entityId: runId },
      select: { newValues: true },
    });
    return ((row?.newValues as { studentIds?: string[] } | null)?.studentIds ?? []).slice();
  }

  /** In the job, acting as the admin: queue these students' SMS (only for that version). */
  async sendChunk(data: ResultSmsJobData, studentIds: string[]): Promise<void> {
    const examClass = await this.db.tx.examClass.findUnique({
      where: { id: data.examClassId },
      include: {
        classLevel: { select: { id: true } },
        exam: { include: { tenant: { select: { name: true } } } },
      },
    });
    if (!examClass?.isPublished || examClass.publishedVersion !== data.version) return;
    const recipients = (await this.recipients(examClass)).filter((r) =>
      studentIds.includes(r.studentId),
    );
    const { today } = await this.settings.load();
    const cap = await this.settings.smsDailyCap();
    for (const r of recipients) {
      if (!r.phone) continue;
      await this.sms.queue({
        purpose: 'EXAM_RESULT',
        phone: r.phone,
        body: r.text,
        localDate: today,
        dedupeKey: dedupeKey(data.examClassId, data.version, r.studentId),
        relatedEntity: versionEntity(data.examClassId, data.version),
        relatedId: r.studentId,
        delayMs: 0,
        dailyCap: cap,
        overCap: 'SKIP',
      });
    }
  }

  async status(runId: string): Promise<ResultSmsStatus> {
    const tx = this.db.tx;
    const row = await tx.auditLog.findFirst({
      where: { entity: 'exam_result_sms_run', entityId: runId },
      select: { newValues: true },
    });
    if (!row) throw new NotFoundException('Run not found');
    const run = row.newValues as { examClassId: string; version: number; studentIds: string[] };
    const logs = await tx.smsLog.groupBy({
      by: ['status'],
      where: {
        dedupeKey: { in: run.studentIds.map((id) => dedupeKey(run.examClassId, run.version, id)) },
      },
      _count: true,
    });
    const counts = { QUEUED: 0, SENT: 0, FAILED: 0, CANCELLED: 0 };
    let logged = 0;
    for (const l of logs) {
      logged += l._count;
      if (l.status in counts) counts[l.status as keyof typeof counts] = l._count;
    }
    return {
      runId,
      toSend: run.studentIds.length,
      counts,
      skipped: run.studentIds.length - logged,
    };
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private async publishedClass(examId: string, examClassId: string) {
    const examClass = await this.db.tx.examClass.findFirst({
      where: { id: examClassId, examId },
      include: {
        classLevel: { select: { id: true } },
        exam: { include: { tenant: { select: { name: true } } } },
      },
    });
    if (!examClass) throw new NotFoundException('Exam class not found');
    if (!examClass.isPublished) throw apiError(409, 'NOT_PUBLISHED', 'Publish the results first');
    return examClass;
  }

  /** Each published student, their primary guardian's phone and their SMS text. */
  private async recipients(examClass: {
    id: string;
    publishedVersion: number;
    exam: { nameBn: string; resultMode: 'GPA' | 'MARKS'; tenant: { name: string } };
    gradingSnapshot: unknown;
  }): Promise<Recipient[]> {
    const rows = await this.db.tx.examResult.findMany({
      where: {
        examClassId: examClass.id,
        publishedVersion: examClass.publishedVersion,
        candidate: { student: { deletedAt: null } },
      },
      orderBy: { roll: 'asc' },
      include: {
        candidate: {
          select: {
            student: {
              select: {
                nameBn: true,
                nameEn: true,
                guardians: {
                  where: { isPrimary: true },
                  select: { guardian: { select: { phone: true } } },
                },
              },
            },
          },
        },
      },
    });
    const decimals =
      (examClass.gradingSnapshot as { rules?: { gpaDecimals?: number } } | null)?.rules
        ?.gpaDecimals ?? 2;
    return rows.map((r) => {
      const st = r.candidate.student;
      const name = st.nameBn ?? st.nameEn ?? '';
      return {
        studentId: r.studentId,
        name,
        phone: st.guardians[0]?.guardian.phone ?? null,
        text: resultSmsText({
          institute: examClass.exam.tenant.name,
          student: name,
          exam: examClass.exam.nameBn,
          mode: examClass.exam.resultMode,
          gpaH: r.gpaH,
          gpaDecimals: decimals,
          letter: r.letter,
          totalH: r.totalH,
          fullMarks: r.fullMarks,
          percentH: r.percentH,
          classPosition: r.classPosition,
        }),
      };
    });
  }

  private async alreadySent(examClassId: string, version: number, recipients: Recipient[]) {
    const keys = recipients.map((r) => dedupeKey(examClassId, version, r.studentId));
    const rows = await this.db.tx.smsLog.findMany({
      where: { dedupeKey: { in: keys } },
      select: { relatedId: true },
    });
    return new Set(rows.map((r) => r.relatedId));
  }
}
