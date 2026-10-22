import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  addDays,
  dateToDb,
  reminderSmsText,
  smsLength,
  type FeeReminderPreview,
  type FeeReminderRun,
  type FeeReminderStatus,
  type IsoDate,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { z } from 'zod';
import type { feeReminderFilterSchema } from '@jantrik/shared';
import { AttendanceSettingsService } from '../../attendance/attendance-settings.service.js';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { TenantSmsService } from '../../sms/tenant-sms.service.js';
import { Db } from '../../tenancy/db.service.js';
import { balanceOf } from '../due-balance.js';
import { FEES_QUEUE, FeeDuesService } from '../dues/fee-dues.service.js';

export type ReminderFilter = z.output<typeof feeReminderFilterSchema>;
export const SEND_REMINDERS_JOB = 'send-reminders';
export interface ReminderJobData {
  tenantId: string;
  actorUserId: string;
  runId: string;
  filter: ReminderFilter;
}

interface Candidate {
  studentId: string;
  name: string;
  phone: string | null;
  overduePaisa: number;
  /** One reminder per student per overdue period: keyed by their latest overdue due. */
  dedupeKey: string;
}

const runEntity = (runId: string) => `fee_reminder:${runId}`;

/**
 * Due reminder SMS (OWNER/ADMIN, docs/fees.md → Reminders): a preview with the count and the SMS
 * cost, a confirmation that must match it, then a background job (25 students per
 * transaction) through TenantSmsService: the shared daily cap applies, a student is reminded at
 * most once per overdue period (dedupe key), and a reminder is cancelled at send time if the
 * student has paid meanwhile.
 */
@Injectable()
export class FeeRemindersService implements OnModuleInit {
  constructor(
    @InjectQueue(FEES_QUEUE) private readonly queue: Queue,
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly dues: FeeDuesService,
    private readonly sms: TenantSmsService,
    private readonly smsCap: AttendanceSettingsService,
  ) {}

  onModuleInit(): void {
    this.sms.registerRelevanceCheck('FEE_REMINDER', async ({ relatedId, localDate }) => {
      if (!relatedId) return false;
      return (await this.overdueOf([relatedId], localDate, 1)).has(relatedId);
    });
  }

  /** Each student's overdue balance today (dues past their date by at least `minDays`). */
  private async overdueOf(studentIds: string[], today: IsoDate, minDays: number) {
    const before = addDays(today, -minDays + 1);
    const rows = await this.db.tx.feeDue.findMany({
      where: { studentId: { in: studentIds }, status: 'OPEN', dueDate: { lt: dateToDb(before) } },
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
    });
    const out = new Map<string, { paisa: number; latestDueId: string }>();
    for (const d of rows) {
      const total = balanceOf(d, today).total;
      if (total === 0) continue;
      const current = out.get(d.studentId);
      out.set(d.studentId, {
        paisa: (current?.paisa ?? 0) + total,
        latestDueId: current?.latestDueId ?? d.id,
      });
    }
    return out;
  }

  /** Students of the filter with something overdue, with their primary guardian's phone. */
  async candidates(filter: ReminderFilter, onlyIds?: string[]): Promise<Candidate[]> {
    const tx = this.db.tx;
    const ctx = await this.dues.planContext();
    if (!ctx.year) return [];
    const students = await tx.student.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(onlyIds ? { id: { in: onlyIds } } : {}),
        enrolments: {
          some: {
            academicYearId: ctx.year.id,
            ...(filter.classLevelId ? { classLevelId: filter.classLevelId } : {}),
            ...(filter.sectionId ? { sectionId: filter.sectionId } : {}),
          },
        },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        studentCode: true,
        nameBn: true,
        nameEn: true,
        guardians: {
          where: { isPrimary: true },
          select: { guardian: { select: { phone: true } } },
        },
      },
    });
    // Their dues up to today first, so the preview and the send count the same students
    // (cheap once the nightly run has generated them: existing dues are skipped).
    const ids = students.map((s) => s.id);
    for (let i = 0; i < ids.length; i += 500) {
      await this.dues.ensureForStudents(ids.slice(i, i + 500), { ctx, trigger: 'reminders' });
    }
    const overdue = await this.overdueOf(ids, ctx.today, filter.minDays);
    return students
      .filter((s) => overdue.has(s.id))
      .map((s) => ({
        studentId: s.id,
        name: s.nameBn ?? s.nameEn ?? s.studentCode,
        phone: s.guardians[0]?.guardian.phone ?? null,
        overduePaisa: overdue.get(s.id)!.paisa,
        dedupeKey: `fee-reminder:${s.id}:${overdue.get(s.id)!.latestDueId}`,
      }));
  }

  async preview(filter: ReminderFilter): Promise<FeeReminderPreview> {
    const tx = this.db.tx;
    await this.dues.ensureTenantToday();
    const ctx = await this.dues.planContext();
    const list = await this.candidates(filter);
    const reminded = new Set(
      (
        await tx.smsLog.findMany({
          where: { dedupeKey: { in: list.map((c) => c.dedupeKey) } },
          select: { dedupeKey: true },
        })
      ).map((l) => l.dedupeKey),
    );
    const tenant = await tx.tenant.findFirstOrThrow({ select: { name: true } });
    const toSend = list.filter((c) => c.phone && !reminded.has(c.dedupeKey));
    const texts = toSend.map((c) =>
      reminderSmsText({ institute: tenant.name, student: c.name, duePaisa: c.overduePaisa }),
    );
    const segments = texts.reduce((sum, t) => sum + smsLength(t).segments, 0);
    const [rate] = await tx.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM platform_settings`;
    const used = await tx.smsLog.count({
      where: { localDate: dateToDb(ctx.today), status: { in: ['QUEUED', 'SENT'] } },
    });
    const capLeft = Math.max(0, (await this.smsCap.smsDailyCap()) - used);
    return {
      students: list.length,
      withoutPhone: list.filter((c) => !c.phone).length,
      alreadyReminded: list.filter((c) => c.phone && reminded.has(c.dedupeKey)).length,
      toSend: toSend.length,
      segments,
      costPaisa: segments * Number(rate?.rate ?? 0),
      capLeftToday: capLeft,
      wouldBeHeld: Math.max(0, toSend.length - capLeft),
      sampleText: texts[0] ?? null,
    };
  }

  async send(filter: ReminderFilter, expected: number): Promise<FeeReminderRun> {
    const preview = await this.preview(filter);
    if (preview.toSend !== expected) {
      throw apiError(409, 'PREVIEW_CHANGED', 'The number of reminders changed: preview again', {
        toSend: preview.toSend,
      });
    }
    const runId = randomUUID();
    await this.audit.record({
      entity: 'fee_reminder_run',
      entityId: runId,
      action: 'CREATE',
      newValues: { filter: { ...filter }, toSend: preview.toSend, costPaisa: preview.costPaisa },
    });
    const data: ReminderJobData = {
      tenantId: this.context.requireTenantId(),
      actorUserId: this.context.requirePrincipal().userId,
      runId,
      filter,
    };
    await this.context.afterCommit(() =>
      this.queue.add(SEND_REMINDERS_JOB, data, { removeOnComplete: true, removeOnFail: 50 }),
    );
    return { runId, queued: preview.toSend };
  }

  /** In the job (one transaction per chunk, acting as the admin): queue each student's SMS. */
  async sendChunk(runId: string, filter: ReminderFilter, studentIds: string[]): Promise<void> {
    const ctx = await this.dues.planContext();
    const tenant = await this.db.tx.tenant.findFirstOrThrow({ select: { name: true } });
    const cap = await this.smsCap.smsDailyCap();
    for (const c of await this.candidates(filter, studentIds)) {
      if (!c.phone) continue;
      await this.sms.queue({
        purpose: 'FEE_REMINDER',
        phone: c.phone,
        body: reminderSmsText({
          institute: tenant.name,
          student: c.name,
          duePaisa: c.overduePaisa,
        }),
        localDate: ctx.today,
        dedupeKey: c.dedupeKey,
        relatedEntity: runEntity(runId),
        relatedId: c.studentId,
        delayMs: 0,
        dailyCap: cap,
      });
    }
  }

  async status(runId: string): Promise<FeeReminderStatus> {
    const rows = await this.db.tx.smsLog.groupBy({
      by: ['status'],
      where: { relatedEntity: runEntity(runId) },
      _count: true,
    });
    const counts = { QUEUED: 0, SENT: 0, FAILED: 0, CANCELLED: 0, HELD_OVER_LIMIT: 0, EXPIRED: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts] = r._count;
    return { runId, counts };
  }
}
