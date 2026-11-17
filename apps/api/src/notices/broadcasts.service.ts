import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  BROADCAST_LIMITS,
  broadcastProblems,
  inQuietHours,
  nextAllowedAt,
  smsLength,
  todayIn,
  dateToDb,
  type BroadcastAlert,
  type BroadcastInput,
  type BroadcastPreview,
  type BroadcastView,
  type NoticeTargetRef,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { REDIS } from '../redis/redis.constants.js';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';
import { AudienceService } from './audience.service.js';
import { NoticesService } from './notices.service.js';

export const NOTICES_QUEUE = 'notices';
export const BROADCAST_SEND_JOB = 'broadcast-send';
export const NOTICES_SWEEP_JOB = 'notices-sweep';
/** Scheduled broadcasts by due time (score = ms): `<tenantId>|<broadcastId>`, our own values. */
export const NOTICES_DUE_KEY = 'notices:due';

export interface BroadcastJobData {
  tenantId: string;
  broadcastId: string;
}

export const broadcastJobId = (broadcastId: string) => `broadcast-${broadcastId}`;
const relatedEntity = (id: string) => `broadcast:${id}`;
/** Overdue this long, a SCHEDULED broadcast is re-queued when an admin opens the list (P6-K). */
const HEAL_AFTER_MS = 2 * 60_000;
/** The dashboard warning looks back this far (P6-D). */
const ALERT_DAYS = 3;

type Row = Prisma.SmsBroadcastGetPayload<{ include: { targets: { include: { classLevel: true; section: true } } } }>;

/** The outcome of one run of the send job, for its caller to finish after commit. */
export type SendOutcome =
  | { kind: 'STOP' }
  | { kind: 'SENT'; queued: number }
  | { kind: 'FAILED_OVER_CAP' }
  | { kind: 'CANCELLED_ACTOR' }
  | { kind: 'LATER'; at: Date };

/**
 * SMS broadcasts (sprint 1 P6b, docs/notices.md → Broadcasts). A draft is previewed (recipients,
 * segments, cost, the cap left), then sent now or scheduled outside quiet hours; the job
 * resolves the audience at that moment (S19) and queues every SMS in one transaction, or none
 * when they do not fit today's cap (S18). OWNER/ADMIN only (S20).
 */
@Injectable()
export class BroadcastsService implements OnModuleInit {
  constructor(
    @InjectQueue(NOTICES_QUEUE) private readonly queue: Queue<BroadcastJobData>,
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly sms: TenantSmsService,
    private readonly cap: AttendanceSettingsService,
    private readonly audience: AudienceService,
    private readonly notices: NoticesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // A queued SMS of a broadcast cancelled afterwards is dropped before sending (P6-L).
    this.sms.registerRelevanceCheck('BROADCAST', async (log) => {
      if (!log.relatedId) return false;
      const b = await this.db.tx.smsBroadcast.findFirst({
        where: { id: log.relatedId },
        select: { status: true },
      });
      return b?.status === 'SENT';
    });
    // The sweep: re-adds jobs Redis lost (one scheduler for every API instance).
    await this.queue.upsertJobScheduler(
      'notices-sweep',
      { every: 5 * 60_000 },
      { name: NOTICES_SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────

  private readonly include = {
    targets: { include: { classLevel: true, section: true }, orderBy: { createdAt: 'asc' } },
  } as const;

  private async view(b: Row): Promise<BroadcastView> {
    const groups = await this.db.tx.smsLog.groupBy({
      by: ['status'],
      where: { relatedEntity: relatedEntity(b.id) },
      _count: true,
    });
    const n = (s: string) => groups.find((g) => g.status === s)?._count ?? 0;
    return {
      id: b.id,
      body: b.body,
      recipients: b.recipients,
      status: b.status,
      noticeId: b.noticeId,
      targets: b.targets.map((t) => ({
        classLevelId: t.classLevelId,
        sectionId: t.sectionId,
        classNameBn: t.classLevel.nameBn,
        classNameEn: t.classLevel.nameEn,
        sectionName: t.section?.name ?? null,
      })),
      scheduledAt: b.scheduledAt?.toISOString() ?? null,
      previewCount: b.previewCount,
      segments: b.segments,
      estimatedCostPaisa: b.estimatedCostPaisa,
      queuedCount: b.queuedCount,
      sentAt: b.sentAt?.toISOString() ?? null,
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancelReason: (b.cancelReason as BroadcastView['cancelReason']) ?? null,
      failure: (b.failure as unknown as BroadcastView['failure']) ?? null,
      createdAt: b.createdAt.toISOString(),
      sms: {
        queued: n('QUEUED') + n('HELD_OVER_LIMIT'),
        sent: n('SENT'),
        failed: n('FAILED') + n('EXPIRED'),
        cancelled: n('CANCELLED'),
      },
    };
  }

  private async row(id: string): Promise<Row> {
    const b = await this.db.tx.smsBroadcast.findFirst({ where: { id }, include: this.include });
    if (!b) throw new NotFoundException('Broadcast not found');
    return b;
  }

  async get(id: string): Promise<BroadcastView> {
    return this.view(await this.row(id));
  }

  /** The list. Opening it re-queues scheduled broadcasts overdue by 2 minutes (P6-K). */
  async list(): Promise<BroadcastView[]> {
    await this.healOverdue();
    const rows = await this.db.tx.smsBroadcast.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: this.include,
    });
    return Promise.all(rows.map((b) => this.view(b)));
  }

  private async healOverdue(): Promise<void> {
    const tenantId = this.context.requireTenantId();
    const overdue = await this.db.tx.smsBroadcast.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lt: new Date(this.clock.now().getTime() - HEAL_AFTER_MS) },
      },
      select: { id: true, scheduledAt: true },
    });
    for (const b of overdue) await this.enqueueAfterCommit(tenantId, b.id, b.scheduledAt!);
  }

  /** The dashboard warning: failed over the cap, cancelled because the admin lost the role, or overdue. */
  async alerts(): Promise<BroadcastAlert[]> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - ALERT_DAYS * 86_400_000);
    const rows = await this.db.tx.smsBroadcast.findMany({
      where: {
        OR: [
          { status: 'FAILED_OVER_CAP', updatedAt: { gte: since } },
          { status: 'CANCELLED', cancelReason: 'ACTOR_NOT_ADMIN', cancelledAt: { gte: since } },
          { status: 'SCHEDULED', scheduledAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        body: true,
        updatedAt: true,
        cancelledAt: true,
        scheduledAt: true,
      },
    });
    return rows.map((b) => ({
      id: b.id,
      status: b.status === 'SCHEDULED' ? 'OVERDUE' : (b.status as 'FAILED_OVER_CAP' | 'CANCELLED'),
      at: (b.status === 'SCHEDULED' ? b.scheduledAt! : (b.cancelledAt ?? b.updatedAt)).toISOString(),
      bodyStart: b.body.length > 60 ? `${b.body.slice(0, 60)}…` : b.body,
    }));
  }

  // ── Writing ──────────────────────────────────────────────────────────────────────────────

  /** Text of 1–3 segments; targets only for guardians, this institute's classes and sections. */
  private async check(input: BroadcastInput): Promise<NoticeTargetRef[]> {
    const problems = broadcastProblems(input.body);
    if (problems.includes('SMS_TOO_LONG') || problems.includes('EMPTY')) {
      const { segments } = smsLength(input.body);
      throw apiError(422, 'SMS_TOO_LONG', 'A broadcast is 1 to 3 SMS segments', {
        segments,
        max: BROADCAST_LIMITS.segments,
      });
    }
    if (input.recipients === 'STAFF' && input.targets.length) {
      throw apiError(422, 'TARGET_INVALID', 'A broadcast to staff takes no class targets');
    }
    if (input.noticeId) await this.notices.manageOne(input.noticeId); // 404 when not ours
    return this.notices.checkTargets('GUARDIANS', input.targets);
  }

  async create(input: BroadcastInput): Promise<BroadcastView> {
    const tenantId = this.context.requireTenantId();
    const userId = this.context.requirePrincipal().userId;
    const targets = await this.check(input);
    const b = await this.db.tx.smsBroadcast.create({
      data: {
        tenantId,
        body: input.body,
        recipients: input.recipients,
        noticeId: input.noticeId,
        createdById: userId,
        targets: { create: targets.map((t) => ({ tenantId, ...t })) },
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'sms_broadcast',
      entityId: b.id,
      action: 'CREATE',
      newValues: this.auditValues(input, targets),
    });
    return this.get(b.id);
  }

  /**
   * Edits a draft, or a scheduled broadcast, which goes back to DRAFT (its job stops on its own):
   * the admin previews and schedules again, so every check runs again.
   */
  async update(id: string, input: BroadcastInput): Promise<BroadcastView> {
    const tenantId = this.context.requireTenantId();
    const before = await this.lockRow(id);
    if (before.status !== 'DRAFT' && before.status !== 'SCHEDULED') {
      throw apiError(409, 'NOT_EDITABLE', 'A sent or cancelled broadcast cannot be edited');
    }
    const targets = await this.check(input);
    await this.db.tx.smsBroadcast.update({
      where: { id },
      data: {
        body: input.body,
        recipients: input.recipients,
        noticeId: input.noticeId,
        status: 'DRAFT',
        scheduledAt: null,
        scheduledById: null,
        previewCount: null,
        segments: null,
        estimatedCostPaisa: null,
      },
      select: { id: true },
    });
    await this.db.tx.smsBroadcastTarget.deleteMany({ where: { broadcastId: id } });
    if (targets.length) {
      await this.db.tx.smsBroadcastTarget.createMany({
        data: targets.map((t) => ({ tenantId, broadcastId: id, ...t })),
      });
    }
    await this.audit.record({
      entity: 'sms_broadcast',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: before.status, bodyLength: before.body.length, recipients: before.recipients },
      newValues: { status: 'DRAFT', ...(this.auditValues(input, targets) as object) },
    });
    if (before.status === 'SCHEDULED') await this.dequeueAfterCommit(tenantId, id);
    return this.get(id);
  }

  private auditValues(input: BroadcastInput, targets: NoticeTargetRef[]): Prisma.InputJsonValue {
    return {
      recipients: input.recipients,
      noticeId: input.noticeId,
      targets: targets.map((t) => ({ classLevelId: t.classLevelId, sectionId: t.sectionId })),
      bodyLength: input.body.length,
      segments: smsLength(input.body).segments,
    };
  }

  /** The broadcast's row, locked for this transaction (FOR UPDATE NOWAIT when `nowait`). */
  private async lockRow(id: string, nowait = false) {
    try {
      const rows = nowait
        ? await this.db.tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM public.sms_broadcasts WHERE id = ${id}::uuid FOR UPDATE NOWAIT`
        : await this.db.tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM public.sms_broadcasts WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Broadcast not found');
    } catch (e) {
      if (nowait && String((e as Error).message).includes('55P03')) {
        throw apiError(409, 'ALREADY_SENDING', 'The broadcast is being sent right now');
      }
      throw e;
    }
    return this.row(id);
  }

  // ── Preview, send, schedule, cancel ──────────────────────────────────────────────────────

  private async tenantNow() {
    const tenant = await this.db.tx.tenant.findFirstOrThrow({ select: { timezone: true, name: true } });
    const now = this.clock.now();
    return { now, timeZone: tenant.timezone, today: todayIn(tenant.timezone, now) };
  }

  async preview(id: string): Promise<BroadcastPreview> {
    const b = await this.row(id);
    return this.previewOf(b);
  }

  private async previewOf(b: Row): Promise<BroadcastPreview> {
    const tx = this.db.tx;
    const { now, timeZone, today } = await this.tenantNow();
    const audience = await this.audience.resolve(
      b.recipients,
      b.targets.map((t) => ({ classLevelId: t.classLevelId, sectionId: t.sectionId })),
    );
    const { segments, encoding } = smsLength(b.body);
    const [rate] = await tx.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM public.platform_settings`;
    const used = await tx.smsLog.count({
      where: { localDate: dateToDb(today), status: { in: ['QUEUED', 'SENT'] } },
    });
    const capLeft = Math.max(0, (await this.cap.smsDailyCap()) - used);
    const recipients = audience.phones.length;
    return {
      recipients,
      withoutPhone: audience.withoutPhone,
      mergedPhones: audience.mergedPhones,
      segments,
      encoding,
      costPaisa: recipients * segments * Number(rate?.rate ?? 0),
      capLeftToday: capLeft,
      fits: recipients <= capLeft,
      quietNow: inQuietHours(now, timeZone),
      nextAllowedAt: nextAllowedAt(now, timeZone).toISOString(),
      sampleText: b.body,
    };
  }

  /** Send now = schedule at now, after the same checks; the job sends it at once. */
  async send(id: string, expectedRecipients: number): Promise<BroadcastView> {
    const b = await this.lockRow(id);
    this.assertDraft(b);
    const preview = await this.previewOf(b);
    this.assertPreview(preview, expectedRecipients);
    if (!preview.fits) {
      throw apiError(422, 'OVER_CAP', "The SMS do not fit today's limit", {
        needed: preview.recipients,
        capLeft: preview.capLeftToday,
      });
    }
    if (preview.quietNow) {
      throw apiError(422, 'QUIET_HOURS', 'No SMS between 21:00 and 08:00', {
        nextAllowedAt: preview.nextAllowedAt,
      });
    }
    return this.markScheduled(b, this.clock.now(), preview);
  }

  async schedule(id: string, scheduledAt: Date, expectedRecipients: number): Promise<BroadcastView> {
    const b = await this.lockRow(id);
    this.assertDraft(b);
    const { now, timeZone } = await this.tenantNow();
    const min = now.getTime() + BROADCAST_LIMITS.minAheadMinutes * 60_000;
    const max = now.getTime() + BROADCAST_LIMITS.maxDays * 86_400_000;
    if (scheduledAt.getTime() < min || scheduledAt.getTime() > max) {
      throw apiError(422, 'SCHEDULE_OUT_OF_RANGE', 'Schedule between 5 minutes and 30 days ahead');
    }
    if (inQuietHours(scheduledAt, timeZone)) {
      throw apiError(422, 'QUIET_HOURS', 'No SMS between 21:00 and 08:00', {
        nextAllowedAt: nextAllowedAt(scheduledAt, timeZone).toISOString(),
      });
    }
    const preview = await this.previewOf(b);
    this.assertPreview(preview, expectedRecipients);
    return this.markScheduled(b, scheduledAt, preview);
  }

  private assertDraft(b: Row) {
    if (b.status !== 'DRAFT') {
      throw apiError(409, 'NOT_EDITABLE', 'Only a draft can be sent or scheduled');
    }
  }

  private assertPreview(preview: BroadcastPreview, expected: number) {
    if (preview.recipients !== expected) {
      throw apiError(409, 'PREVIEW_CHANGED', 'The number of recipients changed: preview again', {
        recipients: preview.recipients,
      });
    }
  }

  private async markScheduled(b: Row, at: Date, preview: BroadcastPreview) {
    const tenantId = this.context.requireTenantId();
    const userId = this.context.requirePrincipal().userId;
    await this.db.tx.smsBroadcast.update({
      where: { id: b.id },
      data: {
        status: 'SCHEDULED',
        scheduledAt: at,
        scheduledById: userId,
        previewCount: preview.recipients,
        segments: preview.segments,
        estimatedCostPaisa: preview.costPaisa,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'sms_broadcast',
      entityId: b.id,
      action: 'UPDATE',
      oldValues: { status: b.status },
      newValues: {
        status: 'SCHEDULED',
        scheduledAt: at.toISOString(),
        previewCount: preview.recipients,
        segments: preview.segments,
        estimatedCostPaisa: preview.costPaisa,
      },
    });
    await this.enqueueAfterCommit(tenantId, b.id, at);
    return this.get(b.id);
  }

  /** A draft or a scheduled broadcast. 409 ALREADY_SENDING while the job holds the row. */
  async cancel(id: string): Promise<BroadcastView> {
    const tenantId = this.context.requireTenantId();
    const userId = this.context.requirePrincipal().userId;
    const b = await this.lockRow(id, true);
    if (b.status !== 'DRAFT' && b.status !== 'SCHEDULED') {
      throw apiError(409, 'NOT_EDITABLE', 'A sent or failed broadcast cannot be cancelled');
    }
    await this.db.tx.smsBroadcast.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: this.clock.now(),
        cancelledById: userId,
        cancelReason: 'BY_ADMIN',
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'sms_broadcast',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: b.status },
      newValues: { status: 'CANCELLED', cancelReason: 'BY_ADMIN' },
    });
    if (b.status === 'SCHEDULED') await this.dequeueAfterCommit(tenantId, id);
    return this.get(id);
  }

  // ── The job ──────────────────────────────────────────────────────────────────────────────

  /** Who the send job acts for (read first, outside the actor's context). */
  async scheduledBy(id: string): Promise<{ status: string; scheduledById: string | null } | null> {
    return this.db.tx.smsBroadcast.findFirst({
      where: { id },
      select: { status: true, scheduledById: true },
    });
  }

  /**
   * The send job's transaction (acting as the scheduling admin): the row under FOR UPDATE; stop
   * unless SCHEDULED; cancel when the admin lost the role (S19); wait out quiet hours (and an
   * early run); resolve the audience now; queue every SMS or none (S18).
   */
  async sendDue(id: string, actorStillAdmin: boolean): Promise<SendOutcome> {
    const b = await this.lockRow(id);
    if (b.status !== 'SCHEDULED') return { kind: 'STOP' };
    const { now, timeZone, today } = await this.tenantNow();
    if (!actorStillAdmin) {
      await this.db.tx.smsBroadcast.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'ACTOR_NOT_ADMIN' },
        select: { id: true },
      });
      await this.audit.record({
        entity: 'sms_broadcast',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: 'SCHEDULED' },
        newValues: { status: 'CANCELLED', cancelReason: 'ACTOR_NOT_ADMIN' },
      });
      return { kind: 'CANCELLED_ACTOR' };
    }
    if (b.scheduledAt && b.scheduledAt > now) return { kind: 'LATER', at: b.scheduledAt };
    if (inQuietHours(now, timeZone)) {
      const at = nextAllowedAt(now, timeZone);
      await this.db.tx.smsBroadcast.update({
        where: { id },
        data: { scheduledAt: at },
        select: { id: true },
      });
      await this.audit.record({
        entity: 'sms_broadcast',
        entityId: id,
        action: 'UPDATE',
        oldValues: { scheduledAt: b.scheduledAt?.toISOString() ?? null },
        newValues: { scheduledAt: at.toISOString(), reason: 'QUIET_HOURS' },
      });
      return { kind: 'LATER', at };
    }
    const audience = await this.audience.resolve(
      b.recipients,
      b.targets.map((t) => ({ classLevelId: t.classLevelId, sectionId: t.sectionId })),
    );
    const result = await this.sms.queueAll(
      audience.phones.map((phone) => ({
        purpose: 'BROADCAST' as const,
        phone,
        body: b.body,
        dedupeKey: `broadcast:${id}:${phone}`,
        relatedEntity: relatedEntity(id),
        relatedId: id,
      })),
      { dailyCap: await this.cap.smsDailyCap(), localDate: today },
    );
    if (result.outcome === 'OVER_CAP') {
      await this.db.tx.smsBroadcast.update({
        where: { id },
        data: {
          status: 'FAILED_OVER_CAP',
          failure: { needed: result.needed, capLeft: result.capLeft },
        },
        select: { id: true },
      });
      await this.audit.record({
        entity: 'sms_broadcast',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: 'SCHEDULED' },
        newValues: { status: 'FAILED_OVER_CAP', needed: result.needed, capLeft: result.capLeft },
      });
      return { kind: 'FAILED_OVER_CAP' };
    }
    const segments = smsLength(b.body).segments;
    const [rate] = await this.db.tx.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM public.platform_settings`;
    await this.db.tx.smsBroadcast.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: now,
        queuedCount: result.queued,
        localDate: dateToDb(today),
        segments,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'sms_broadcast',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'SCHEDULED' },
      newValues: {
        status: 'SENT',
        queued: result.queued,
        duplicates: result.duplicates,
        withoutPhone: audience.withoutPhone,
        costPaisa: result.queued * segments * Number(rate?.rate ?? 0),
      },
    });
    return { kind: 'SENT', queued: result.queued };
  }

  // ── Queue and the due set (after commit) ────────────────────────────────────────────────

  private member = (tenantId: string, id: string) => `${tenantId}|${id}`;

  private enqueueAfterCommit(tenantId: string, id: string, at: Date): Promise<void> {
    return this.context.afterCommit(() => this.enqueue(tenantId, id, at));
  }

  /** Adds (or keeps) the job and the due-set entry. The same job id is a no-op while it exists. */
  async enqueue(tenantId: string, id: string, at: Date): Promise<void> {
    const delay = Math.max(0, at.getTime() - this.clock.now().getTime());
    await this.redis.zadd(NOTICES_DUE_KEY, at.getTime(), this.member(tenantId, id));
    const existing = await this.queue.getJob(broadcastJobId(id));
    // A job already running or waiting keeps its place; a delayed one is moved to the new time.
    if (existing && (await existing.isDelayed())) await existing.remove().catch(() => undefined);
    else if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return;
    else if (existing) await existing.remove().catch(() => undefined);
    await this.queue.add(
      BROADCAST_SEND_JOB,
      { tenantId, broadcastId: id },
      { jobId: broadcastJobId(id), delay, removeOnComplete: true, removeOnFail: 50 },
    );
  }

  private dequeueAfterCommit(tenantId: string, id: string): Promise<void> {
    return this.context.afterCommit(() => this.forget(tenantId, id, true));
  }

  /** The due-set entry at its (new) time, for the sweep. */
  async markDue(tenantId: string, id: string, at: Date): Promise<void> {
    await this.redis.zadd(NOTICES_DUE_KEY, at.getTime(), this.member(tenantId, id));
  }

  /** Drops the due-set entry (and the job, when asked: a failed removal is harmless). */
  async forget(tenantId: string, id: string, removeJob = false): Promise<void> {
    await this.redis.zrem(NOTICES_DUE_KEY, this.member(tenantId, id));
    if (removeJob) {
      const job = await this.queue.getJob(broadcastJobId(id));
      if (job && !(await job.isActive())) await job.remove().catch(() => undefined);
    }
  }

  /** The sweep: re-adds every due job Redis lost; entries older than 7 days are dropped. */
  async sweep(): Promise<number> {
    const now = this.clock.now().getTime();
    await this.redis.zremrangebyscore(NOTICES_DUE_KEY, '-inf', now - 7 * 86_400_000);
    const due = await this.redis.zrangebyscore(NOTICES_DUE_KEY, '-inf', now);
    let added = 0;
    for (const m of due) {
      const [tenantId, id] = m.split('|');
      if (!tenantId || !id) continue;
      if (await this.queue.getJob(broadcastJobId(id))) continue;
      await this.queue.add(
        BROADCAST_SEND_JOB,
        { tenantId, broadcastId: id },
        { jobId: broadcastJobId(id), removeOnComplete: true, removeOnFail: 50 },
      );
      added++;
    }
    return added;
  }
}
