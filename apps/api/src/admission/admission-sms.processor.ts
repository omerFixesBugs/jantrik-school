import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatIdentifier, todayIn } from '@jantrik/shared';
import type { Job } from 'bullmq';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import type { Env } from '../config/env.js';
import { SMS_PROVIDER, type SmsProvider } from '../sms/sms.providers.js';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  ADMISSION_OTP_JOB,
  ADMISSION_SMS_QUEUE,
  ADMISSION_SUBMITTED_JOB,
  type AdmissionOtpJob,
  type AdmissionSubmittedJob,
} from './public/admission-otp.service.js';

const isLastAttempt = (job: Job): boolean => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

const CODE_TEXT = {
  bn: (institute: string, code: string) =>
    `${institute} ভর্তির আবেদনের কোড: ${code}। ৫ মিনিটের মধ্যে ব্যবহার করুন।`,
  en: (institute: string, code: string) =>
    `${institute} admission code: ${code}. It expires in 5 minutes.`,
};

/**
 * The public form's two SMS (sprint 1 P3b, decision P3-C), each in its institute's own context
 * opened from ids our code resolved (never from the browser):
 * - the code: logged in the institute's sms_logs with the code masked, outside its daily cap but
 *   counted in the day's total (P3-D), then sent;
 * - "application received" (S11): through TenantSmsService.queue, skipped over the cap.
 */
@Processor(ADMISSION_SMS_QUEUE)
export class AdmissionSmsProcessor extends WorkerHost {
  private readonly logger = new Logger(AdmissionSmsProcessor.name);

  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    private readonly runner: TenantJobRunner,
    private readonly tenantSms: TenantSmsService,
    private readonly settings: AttendanceSettingsService,
    private readonly db: Db,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  async process(job: Job<AdmissionOtpJob | AdmissionSubmittedJob>): Promise<void> {
    if (job.name === ADMISSION_OTP_JOB) return this.code(job as Job<AdmissionOtpJob>);
    if (job.name === ADMISSION_SUBMITTED_JOB) {
      return this.submitted(job as Job<AdmissionSubmittedJob>);
    }
  }

  private async instituteName(locale: 'bn' | 'en'): Promise<string> {
    const tx = this.db.tx;
    const [tenant, profile] = await Promise.all([
      tx.tenant.findFirstOrThrow({ select: { name: true, timezone: true } }),
      tx.instituteProfile.findFirst({ select: { nameBn: true, nameEn: true } }),
    ]);
    return (locale === 'bn' ? profile?.nameBn : profile?.nameEn) ?? tenant.name;
  }

  private async code(job: Job<AdmissionOtpJob>): Promise<void> {
    const { tenantId, phone, code, locale } = job.data;
    // One row per job: a retry after a failed send reuses it (its id is kept on the job).
    let logId = (job.data as AdmissionOtpJob & { smsLogId?: string }).smsLogId;
    const text = await this.runner.run(tenantId, async () => {
      const institute = await this.instituteName(locale);
      const real = CODE_TEXT[locale](institute, code);
      if (!logId) {
        const tenant = await this.db.tx.tenant.findFirstOrThrow({ select: { timezone: true } });
        logId = await this.tenantSms.recordOutsideCap({
          purpose: 'ADMISSION_OTP',
          phone,
          body: CODE_TEXT[locale](institute, '••••••'),
          segmentsOf: real,
          localDate: todayIn(tenant.timezone),
        });
      }
      return real;
    });
    await job.updateData({ ...job.data, smsLogId: logId } as AdmissionOtpJob);
    try {
      await this.provider.send(phone, text);
    } catch (error) {
      this.logger.error(`admission code SMS failed: ${(error as Error).name}`);
      if (isLastAttempt(job)) {
        await this.runner.run(tenantId, () =>
          this.tenantSms.markFailed(logId!, (error as Error).message),
        );
      }
      throw error;
    }
    await this.runner.run(tenantId, () => this.tenantSms.markSent(logId!));
  }

  private async submitted(job: Job<AdmissionSubmittedJob>): Promise<void> {
    const { tenantId, applicationId, slug } = job.data;
    await this.runner.run(tenantId, async () => {
      const tx = this.db.tx;
      const app = await tx.admissionApplication.findUnique({
        where: { id: applicationId },
        select: { phone: true, applicationNo: true },
      });
      if (!app) return;
      const tenant = await tx.tenant.findFirstOrThrow({
        select: { timezone: true, defaultLocale: true },
      });
      const locale = tenant.defaultLocale === 'en' ? 'en' : 'bn';
      const institute = await this.instituteName(locale);
      const web = this.config.get('WEB_PUBLIC_URL', { infer: true });
      const link = web ? ` ${web.replace(/\/$/, '')}/apply/${slug}/status` : '';
      const no = formatIdentifier(app.applicationNo);
      const body =
        locale === 'bn'
          ? `${institute}: ভর্তির আবেদন জমা হয়েছে। আবেদন নম্বর ${no}।${link}`
          : `${institute}: admission application received. Application no ${no}.${link}`;
      await this.tenantSms.queue({
        purpose: 'ADMISSION_SUBMITTED',
        phone: app.phone,
        body,
        localDate: todayIn(tenant.timezone),
        dedupeKey: `admission-submitted:${applicationId}`,
        relatedEntity: 'admission_application',
        relatedId: applicationId,
        delayMs: 0,
        dailyCap: await this.settings.smsDailyCap(),
        overCap: 'SKIP',
      });
    });
  }
}
