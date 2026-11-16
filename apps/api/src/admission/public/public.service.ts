import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { withContext, type TenantTx } from '@jantrik/db';
import {
  admissionApplicationFieldsSchema,
  normalizeBdPhone,
  todayIn,
  toAsciiDigits,
  type AdmissionPublicForm,
  type AdmissionPublicStatus,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { apiError } from '../../common/api-error.js';
import { Clock } from '../../common/clock.js';
import { ImageService } from '../../files/image.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RateLimiter } from '../../redis/rate-limiter.service.js';
import {
  ADMISSION_SMS_QUEUE,
  ADMISSION_SUBMITTED_JOB,
  AdmissionOtpService,
  type AdmissionSubmittedJob,
} from './admission-otp.service.js';
import { FormTickets } from './form-ticket.js';
import { PHONE_TOKEN_TTL_SEC, PhoneTokens } from './phone-token.js';
import { TurnstileVerifier } from './turnstile.js';

/** admission_public_form's answer, with the two fields the browser never gets. */
type StoredForm = AdmissionPublicForm & { tenantId: string; timezone: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public admission form (sprint 1 P3b, decision S4). No request ever opens an institute's
 * transaction here (P3-C): the database is reached only through the three admission_* functions,
 * each in a transaction with no institute and no person (withContext({})). Nothing in this
 * folder imports Db, TenantJobRunner or TenantSmsService (no-tenant-access.spec.ts).
 */
@Injectable()
export class AdmissionPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly tickets: FormTickets,
    private readonly phones: PhoneTokens,
    private readonly otp: AdmissionOtpService,
    private readonly turnstile: TurnstileVerifier,
    private readonly images: ImageService,
    private readonly limiter: RateLimiter,
    @InjectQueue(ADMISSION_SMS_QUEUE) private readonly queue: Queue<AdmissionSubmittedJob>,
  ) {}

  /** A function call with no institute and no person (the public routes' only way in). */
  private call<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withContext(this.prisma.client, {}, fn, { timeout: 10_000, maxWait: 5_000 });
  }

  private async load(slug: string): Promise<StoredForm | null> {
    const now = this.clock.now();
    const [row] = await this.call((tx) =>
      tx.$queryRaw<{ v: StoredForm | null }[]>`
        SELECT public.admission_public_form(${slug}, ${now}::timestamptz) AS v`,
    );
    return row?.v ?? null;
  }

  private async open(slug: string): Promise<StoredForm> {
    const f = await this.load(slug);
    if (!f) throw apiError(404, 'ADMISSION_UNKNOWN', 'No such institute');
    return f;
  }

  private async passTurnstile(token: unknown, ip: string, action: string): Promise<void> {
    const verdict = await this.turnstile.verify(typeof token === 'string' ? token : '', ip, action);
    if (verdict === 'FAIL') throw apiError(403, 'TURNSTILE_FAILED', 'The check did not pass');
    if (verdict === 'UNAVAILABLE') {
      throw apiError(503, 'TURNSTILE_UNAVAILABLE', 'The check is unavailable; try again soon');
    }
  }

  private phoneFrom(token: string | undefined, tenantId: string): string {
    const phone = this.phones.verify(token, tenantId);
    if (!phone) throw apiError(401, 'ADMISSION_TOKEN_INVALID', 'Verify the phone again');
    return phone;
  }

  /** GET /public/admission/:slug: the form, and a ticket that dates it (P3-L). */
  async form(slug: string, ip: string): Promise<AdmissionPublicForm & { formTicket: string }> {
    await this.limiter.consume({ key: `adm-form-ip:${ip}`, limit: 60, windowSec: 60 });
    const { tenantId: _t, timezone: _z, ...form } = await this.open(slug);
    return { ...form, formTicket: this.tickets.issue(slug) };
  }

  /** POST /public/admission/:slug/otp: a code to the phone, after Turnstile. */
  async requestOtp(slug: string, body: { phone?: unknown; turnstileToken?: unknown }, ip: string) {
    const phone = typeof body.phone === 'string' ? normalizeBdPhone(body.phone) : null;
    if (!phone) throw apiError(400, 'PHONE_INVALID', 'Invalid Bangladeshi mobile number');
    const f = await this.open(slug);
    if (f.cycles.length === 0) throw apiError(404, 'ADMISSION_CLOSED', 'Not taking applications');
    await this.passTurnstile(body.turnstileToken, ip, 'admission-otp');
    await this.otp.request({
      tenantId: f.tenantId,
      phone,
      ip,
      today: todayIn(f.timezone, this.clock.now()),
      locale: f.institute.locale === 'en' ? 'en' : 'bn',
    });
    return { expiresIn: 300 };
  }

  /** POST /public/admission/:slug/otp/verify: the phone token (30 minutes). */
  async verifyOtp(slug: string, body: { phone?: unknown; code?: unknown }, ip: string) {
    const phone = typeof body.phone === 'string' ? normalizeBdPhone(body.phone) : null;
    const code = typeof body.code === 'string' ? toAsciiDigits(body.code.trim()) : '';
    if (!phone || !/^\d{6}$/.test(code)) {
      throw apiError(422, 'ADMISSION_CODE_INVALID', 'The code is not right');
    }
    const f = await this.open(slug);
    if (!(await this.otp.verify({ tenantId: f.tenantId, phone, code, ip }))) {
      throw apiError(422, 'ADMISSION_CODE_INVALID', 'The code is not right');
    }
    return { phoneToken: this.phones.sign(f.tenantId, phone), expiresIn: PHONE_TOKEN_TTL_SEC };
  }

  /** POST /public/admission/:slug/applications (multipart). */
  async submit(
    slug: string,
    token: string | undefined,
    body: Record<string, unknown>,
    photo: Buffer | undefined,
    ip: string,
  ): Promise<{ applicationNo: string }> {
    await this.limiter.consume({ key: `adm-submit-ip:${ip}`, limit: 10, windowSec: 3600 });
    const f = await this.open(slug);
    const phone = this.phoneFrom(token, f.tenantId);
    await this.limiter.consume({ key: `adm-submit-phone:${phone}`, limit: 10, windowSec: 86_400 });
    // A filled honeypot or a form sent too soon or too late: the same vague answer (P3-L), never
    // a fake success (a real guardian whose browser filled the hidden field learns to retry).
    const website = typeof body['website'] === 'string' ? body['website'] : '';
    const ticket = typeof body['formTicket'] === 'string' ? body['formTicket'] : undefined;
    if (website.trim() !== '' || !this.tickets.check(slug, ticket)) {
      throw apiError(422, 'ADMISSION_REJECTED', 'The application could not be accepted; try again');
    }
    await this.passTurnstile(body['turnstileToken'], ip, 'admission-submit');
    const cycleClassId = typeof body['cycleClassId'] === 'string' ? body['cycleClassId'] : '';
    let raw: unknown;
    try {
      raw = JSON.parse(typeof body['payload'] === 'string' ? body['payload'] : 'null');
    } catch {
      raw = null;
    }
    const parsed = admissionApplicationFieldsSchema.safeParse(raw);
    if (!parsed.success || !UUID.test(cycleClassId)) {
      throw apiError(422, 'ADMISSION_INVALID', 'Check the form', {
        errors: parsed.success
          ? [{ path: 'cycleClassId', message: 'Choose a class' }]
          : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // Only the re-encoded image ever reaches the database (P2's pipeline, two decodes at a time).
    const image = photo?.length ? await this.images.process('APPLICANT_PHOTO', photo) : null;
    const now = this.clock.now();
    const payload = JSON.stringify(parsed.data);
    const [r] = await this.call((tx) =>
      tx.$queryRaw<
        {
          outcome: string;
          application_no: string | null;
          tenant_id: string | null;
          application_id: string | null;
        }[]
      >`SELECT * FROM public.admission_submit(${slug}, ${cycleClassId}::uuid, ${phone},
          ${payload}::jsonb, ${image ? new Uint8Array(image.bytes) : null}::bytea,
          ${image?.width ?? null}::int, ${image?.height ?? null}::int, ${now}::timestamptz)`,
    );
    switch (r?.outcome) {
      case 'CREATED':
        await this.queue.add(
          ADMISSION_SUBMITTED_JOB,
          { tenantId: r.tenant_id!, applicationId: r.application_id!, slug },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
        return { applicationNo: r.application_no! };
      case 'DUPLICATE':
        throw apiError(409, 'ADMISSION_DUPLICATE', 'This child has already applied', {
          applicationNo: r.application_no,
        });
      case 'PHONE_CAP':
        throw apiError(422, 'ADMISSION_PHONE_CAP', 'This phone has applied for three children');
      case 'CLOSED':
        throw apiError(422, 'ADMISSION_CLOSED', 'This class is not taking applications');
      case 'UNKNOWN':
        throw apiError(404, 'ADMISSION_UNKNOWN', 'No such institute');
      default:
        throw apiError(422, 'ADMISSION_INVALID', 'Check the form');
    }
  }

  /** POST /public/admission/:slug/status: the status, for the proved phone only (P3-F). */
  async status(
    slug: string,
    token: string | undefined,
    body: { applicationNo?: unknown },
    ip: string,
  ): Promise<AdmissionPublicStatus> {
    await this.limiter.consume({ key: `adm-status-ip:${ip}`, limit: 30, windowSec: 3600 });
    const f = await this.open(slug);
    const phone = this.phoneFrom(token, f.tenantId);
    await this.limiter.consume({ key: `adm-status-phone:${phone}`, limit: 20, windowSec: 86_400 });
    const no =
      typeof body.applicationNo === 'string' ? toAsciiDigits(body.applicationNo.trim()) : '';
    const [row] = await this.call((tx) =>
      tx.$queryRaw<{ v: AdmissionPublicStatus | null }[]>`
        SELECT public.admission_lookup(${slug}, ${no}, ${phone}) AS v`,
    );
    if (!row?.v) throw apiError(404, 'APPLICATION_NOT_FOUND', 'No such application for this phone');
    return row.v;
  }
}
