import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADMISSION_TEST_REJECT_REASONS,
  admissionResultSmsText,
  dateToDb,
  smsLength,
  type AdmissionResultSmsPreview,
  type AdmissionResultSmsRun,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { BULK_SMS_PRIORITY, TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';

/** Its own queue: one processor per queue (the approval queue's would drop these jobs). */
export const ADMISSION_RESULTS_QUEUE = 'admission-results';
export const SEND_ADMISSION_RESULT_SMS_JOB = 'send-result-sms';

type Told = 'SELECTED' | 'WAITLISTED' | 'REJECTED';

export interface AdmissionResultSmsJobData {
  tenantId: string;
  actorUserId: string;
  runId: string;
  cycleClassId: string;
  version: number;
}

/**
 * One SMS per run, application, version and status told (P4-a5, review N3): the status and the
 * version in the key are how the next preview knows what each applicant was told; the run makes a
 * resend of a cancelled or failed SMS a new SMS, not a DUPLICATE.
 */
const dedupeKey = (
  cycleClassId: string,
  version: number,
  applicationId: string,
  told: Told,
  runId: string,
) => `admission-result:${cycleClassId}:v${version}:${applicationId}:${told}:${runId}`;
const TOLD_RE =
  /^admission-result:[0-9a-f-]{36}:v(\d+):[0-9a-f-]{36}:(SELECTED|WAITLISTED|REJECTED)(?::|$)/;
const entity = (cycleClassId: string, version: number, told: Told) =>
  `admission_result:${cycleClassId}:v${version}:${told}`;
const ENTITY_RE = /^admission_result:([0-9a-f-]{36}):v(\d+):(SELECTED|WAITLISTED|REJECTED)$/;

interface Recipient {
  applicationId: string;
  phone: string;
  told: Told;
  text: string;
}

/**
 * The result SMS of an admission test (sprint 1 P4, the exams' result SMS pattern): never
 * automatic. A preview counts the applicants whose status changed since their last result SMS
 * (the first time: everyone with a result), with the cost and the cap left today; the send must
 * match it (409 PREVIEW_CHANGED); a job queues the SMS, over the daily cap skipped (SKIP, not
 * HOLD), and an SMS still waiting is cancelled if its version is no longer published or the
 * applicant's status moved on.
 */
@Injectable()
export class AdmissionResultSmsService implements OnModuleInit {
  constructor(
    @InjectQueue(ADMISSION_RESULTS_QUEUE) private readonly queue: Queue<AdmissionResultSmsJobData>,
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly sms: TenantSmsService,
    private readonly settings: AttendanceSettingsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.sms.registerRelevanceCheck('ADMISSION_RESULT', async ({ relatedEntity, relatedId }) => {
      const m = relatedEntity ? ENTITY_RE.exec(relatedEntity) : null;
      if (!m) return false;
      const cls = await this.db.tx.admissionCycleClass.findUnique({
        where: { id: m[1]! },
        select: { resultsVersion: true },
      });
      if (cls?.resultsVersion !== Number(m[2])) return false;
      if (!relatedId) return false;
      const app = await this.db.tx.admissionApplication.findUnique({
        where: { id: relatedId },
        select: { status: true },
      });
      return app?.status === m[3];
    });
  }

  async preview(cycleClassId: string): Promise<AdmissionResultSmsPreview> {
    const tx = this.db.tx;
    const cls = await this.publishedClass(cycleClassId);
    const all = await this.recipients(cls);
    const toSend = await this.notYetTold(all, cls.resultsVersion);
    const [rate] = await tx.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM public.platform_settings`;
    const { today } = await this.settings.load();
    const used = await tx.smsLog.count({
      where: { localDate: dateToDb(today), status: { in: ['QUEUED', 'SENT'] } },
    });
    const capLeft = Math.max(0, (await this.settings.smsDailyCap()) - used);
    // The segments and the cost of what will go out today, not of what the cap skips (N4).
    const segments = toSend.slice(0, capLeft).reduce((n, r) => n + smsLength(r.text).segments, 0);
    return {
      publishedVersion: cls.resultsVersion,
      applications: all.length,
      toSend: toSend.length,
      segments,
      costPaisa: segments * Number(rate?.rate ?? 0),
      capLeftToday: capLeft,
      wouldBeSkipped: Math.max(0, toSend.length - capLeft),
      sampleText: toSend[0]?.text ?? all[0]?.text ?? null,
    };
  }

  async send(cycleClassId: string, expected: number): Promise<AdmissionResultSmsRun> {
    const preview = await this.preview(cycleClassId);
    if (preview.toSend !== expected) {
      throw apiError(409, 'PREVIEW_CHANGED', 'The number of SMS changed: preview again', {
        toSend: preview.toSend,
      });
    }
    const cls = await this.publishedClass(cycleClassId);
    const toSend = await this.notYetTold(await this.recipients(cls), cls.resultsVersion);
    const runId = randomUUID();
    await this.audit.record({
      entity: 'admission_result_sms_run',
      entityId: runId,
      action: 'CREATE',
      newValues: {
        cycleClassId,
        version: cls.resultsVersion,
        recipients: toSend.map((r) => ({ applicationId: r.applicationId, told: r.told })),
        costPaisa: preview.costPaisa,
      },
    });
    const data: AdmissionResultSmsJobData = {
      tenantId: this.context.requireTenantId(),
      actorUserId: this.context.requirePrincipal().userId,
      runId,
      cycleClassId,
      version: cls.resultsVersion,
    };
    await this.context.afterCommit(() =>
      this.queue.add(SEND_ADMISSION_RESULT_SMS_JOB, data, {
        removeOnComplete: true,
        removeOnFail: 50,
      }),
    );
    return { runId, queued: toSend.length };
  }

  /** The run's recipients (the job reads them back from its audit row). */
  async runRecipients(runId: string): Promise<{ applicationId: string; told: Told }[]> {
    const row = await this.db.tx.auditLog.findFirst({
      where: { entity: 'admission_result_sms_run', entityId: runId },
      select: { newValues: true },
    });
    return (
      (row?.newValues as { recipients?: { applicationId: string; told: Told }[] } | null)
        ?.recipients ?? []
    ).slice();
  }

  /** In the job, acting as the admin: queue these SMS, still for that version and status. */
  async sendChunk(
    data: AdmissionResultSmsJobData,
    chunk: { applicationId: string; told: Told }[],
  ): Promise<void> {
    const cls = await this.db.tx.admissionCycleClass.findUnique({
      where: { id: data.cycleClassId },
      select: { id: true, resultsVersion: true },
    });
    if (!cls || cls.resultsVersion !== data.version) return;
    // The SMS writers' lock first (TenantSmsService's), then who is still owed: two runs at once
    // never send the same SMS twice.
    await this.db.tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('sms:' || app_current_tenant_id()::text, 0))`;
    const wanted = new Map(chunk.map((c) => [c.applicationId, c.told]));
    const recipients = await this.notYetTold(
      (await this.recipients(cls)).filter((r) => wanted.get(r.applicationId) === r.told),
      data.version,
    );
    const { today } = await this.settings.load();
    const cap = await this.settings.smsDailyCap();
    for (const r of recipients) {
      await this.sms.queue({
        priority: BULK_SMS_PRIORITY,
        purpose: 'ADMISSION_RESULT',
        phone: r.phone,
        body: r.text,
        localDate: today,
        dedupeKey: dedupeKey(data.cycleClassId, data.version, r.applicationId, r.told, data.runId),
        relatedEntity: entity(data.cycleClassId, data.version, r.told),
        relatedId: r.applicationId,
        delayMs: 0,
        dailyCap: cap,
        overCap: 'SKIP',
      });
    }
  }

  async status(runId: string) {
    const tx = this.db.tx;
    const row = await tx.auditLog.findFirst({
      where: { entity: 'admission_result_sms_run', entityId: runId },
      select: { newValues: true },
    });
    if (!row) throw new NotFoundException('Run not found');
    const run = row.newValues as {
      cycleClassId: string;
      version: number;
      recipients: { applicationId: string; told: Told }[];
    };
    const keys = run.recipients.map((r) =>
      dedupeKey(run.cycleClassId, run.version, r.applicationId, r.told, runId),
    );
    const logs = await tx.smsLog.groupBy({
      by: ['status'],
      where: { dedupeKey: { in: keys } },
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
      toSend: run.recipients.length,
      counts,
      // Not queued at all: over the daily cap, or no longer owed when the run reached them
      // (told meanwhile, or the status moved on); never a failure (review round 2, N4).
      skipped: run.recipients.length - logged,
    };
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private async publishedClass(cycleClassId: string) {
    const cls = await this.db.tx.admissionCycleClass.findUnique({
      where: { id: cycleClassId },
      select: { id: true, resultsVersion: true },
    });
    if (!cls) throw new NotFoundException('Admission class not found');
    if (cls.resultsVersion === 0) {
      throw apiError(422, 'NOT_PUBLISHED', 'Publish the merit list first');
    }
    return cls;
  }

  /**
   * Every application of the published version with a status to tell: SELECTED, WAITLISTED, or
   * REJECTED by the test. Admitted and withdrawn applicants get no result SMS.
   */
  private async recipients(cls: { id: string; resultsVersion: number }): Promise<Recipient[]> {
    const tx = this.db.tx;
    const [rows, tenant, profile] = await Promise.all([
      tx.admissionApplication.findMany({
        where: {
          cycleClassId: cls.id,
          resultVersion: cls.resultsVersion,
          OR: [
            { status: { in: ['SELECTED', 'WAITLISTED'] } },
            { status: 'REJECTED', statusReason: { in: [...ADMISSION_TEST_REJECT_REASONS] } },
          ],
        },
        orderBy: { testRoll: 'asc' },
        select: {
          id: true,
          applicationNo: true,
          phone: true,
          status: true,
          resultMeritPosition: true,
          resultWaitlistPosition: true,
        },
      }),
      tx.tenant.findFirstOrThrow({ select: { name: true, slug: true, defaultLocale: true } }),
      tx.instituteProfile.findFirst({ select: { nameBn: true, nameEn: true } }),
    ]);
    const locale = tenant.defaultLocale === 'en' ? 'en' : 'bn';
    const institute = (locale === 'bn' ? profile?.nameBn : profile?.nameEn) ?? tenant.name;
    const web = this.config.get('WEB_PUBLIC_URL', { infer: true });
    const statusUrl = web ? `${web.replace(/\/$/, '')}/apply/${tenant.slug}/status` : null;
    return rows.map((r) => {
      const told = r.status as Told;
      return {
        applicationId: r.id,
        phone: r.phone,
        told,
        text: admissionResultSmsText({
          institute,
          applicationNo: r.applicationNo,
          outcome: told,
          meritPosition: told === 'REJECTED' ? null : r.resultMeritPosition,
          waitlistPosition: told === 'WAITLISTED' ? r.resultWaitlistPosition : null,
          statusUrl,
          locale,
        }),
      };
    });
  }

  /**
   * Those not yet told their current status (review S1): told means an SMS that went out (SENT),
   * or one of this version still waiting (QUEUED). A cancelled or failed one told nobody, so it is
   * owed again; the latest such SMS (any version) says what the applicant was last told.
   */
  private async notYetTold(recipients: Recipient[], version: number): Promise<Recipient[]> {
    if (recipients.length === 0) return [];
    const logs = await this.db.tx.smsLog.findMany({
      where: {
        purpose: 'ADMISSION_RESULT',
        relatedId: { in: recipients.map((r) => r.applicationId) },
        status: { in: ['SENT', 'QUEUED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { relatedId: true, dedupeKey: true, status: true },
    });
    const last = new Map<string, string>();
    for (const l of logs) {
      if (!l.relatedId || last.has(l.relatedId)) continue;
      const m = l.dedupeKey ? TOLD_RE.exec(l.dedupeKey) : null;
      if (!m) continue;
      if (l.status === 'QUEUED' && Number(m[1]) !== version) continue;
      last.set(l.relatedId, m[2]!);
    }
    return recipients.filter((r) => last.get(r.applicationId) !== r.told);
  }
}
