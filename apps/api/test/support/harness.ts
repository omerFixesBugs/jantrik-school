import './context-key.js';
import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createPrismaClient,
  findOrCreateUser,
  provisionTenant,
  withContext,
  withTenant,
  type PrismaClient,
  type Role,
  type TenantStatus,
} from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
import { hash } from '@node-rs/argon2';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AttendanceModule } from '../../src/attendance/attendance.module.js';
import { configureApp } from '../../src/app.setup.js';
import {
  DEVICES_QUEUE,
  DEVICES_TICK_JOB,
  EXPIRE_PUNCHES_JOB,
} from '../../src/devices/devices.constants.js';
import { DevicesModule } from '../../src/devices/devices.module.js';
import { ExamsModule } from '../../src/exams/exams.module.js';
import { FeesModule } from '../../src/fees/fees.module.js';
import { REDIS } from '../../src/redis/redis.constants.js';
import { SMS_PROVIDER, type MemorySmsProvider } from '../../src/sms/sms.providers.js';
import { TenantAccessService } from '../../src/tenancy/tenant-access.service.js';
import { Clock } from '../../src/common/clock.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../../src/payments/payments.config.js';
import { PAYMENTS_QUEUE } from '../../src/payments/payments.constants.js';
import { TestController } from './test.controller.js';
import { phoneSource } from './test-phones.js';

export interface Harness {
  app: INestApplication;
  /** Fixture client (app role, RLS applies). */
  prisma: PrismaClient;
  redis: Redis;
  sms: MemorySmsProvider;
  access: TenantAccessService;
  close(): Promise<void>;
}

/**
 * `payments`: the payments module's settings (the fake SSLCommerz's address, a public API
 * address). Without it SSLCommerz is an address nothing listens on (vitest.config.ts), so no test
 * can reach the real one. Tests may change the object's fields later (app.get(PAYMENTS_CONFIG)).
 */
export async function createHarness(
  opts: { clock?: Clock; payments?: Partial<PaymentsConfig> } = {},
): Promise<Harness> {
  const builder = Test.createTestingModule({
    // AttendanceModule, DevicesModule, FeesModule and ExamsModule again so TestController can
    // inject their exported services (same instances).
    imports: [AppModule, AttendanceModule, DevicesModule, FeesModule, ExamsModule],
    controllers: [TestController],
  });
  // Tests that need to control time pass a FakeClock (test/support/clock.ts).
  if (opts.clock) builder.overrideProvider(Clock).useValue(opts.clock);
  if (opts.payments) {
    const payments: PaymentsConfig = {
      apiPublicUrl: null,
      webPublicUrl: null,
      sslcommerzBaseUrl: process.env['SSLCOMMERZ_BASE_URL'] ?? 'http://127.0.0.1:9',
      timeoutMs: 30_000,
      ...opts.payments,
    };
    builder.overrideProvider(PAYMENTS_CONFIG).useValue(payments);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  // No real-time devices tick or retention in tests: they would visit each institute listed for
  // devices while other tests run. Tests run them themselves (DevicesProcessor.tickAll, expire).
  const devicesQueue = app.get<Queue>(getQueueToken(DEVICES_QUEUE));
  await devicesQueue.removeJobScheduler(DEVICES_TICK_JOB);
  await devicesQueue.removeJobScheduler(EXPIRE_PUNCHES_JOB);
  // Reconciliation steps are delayed by minutes to days: none of one test file may run in a later
  // one (against another fake SSLCommerz), so they are dropped when the file closes its app.
  const paymentsQueue = app.get<Queue>(getQueueToken(PAYMENTS_QUEUE));
  const prisma = createPrismaClient(process.env['DATABASE_URL']!);
  return {
    app,
    prisma,
    redis: app.get<Redis>(REDIS),
    sms: app.get<MemorySmsProvider>(SMS_PROVIDER),
    access: app.get(TenantAccessService),
    async close() {
      await paymentsQueue.drain(true);
      await app.close();
      await prisma.$disconnect();
    },
  };
}

let phones: (() => string) | undefined;
/**
 * A valid Bangladeshi mobile number (E.164) that no other test user of this database has, in this
 * run or an earlier one (`test-phones.ts`; the db package's tests draw from +88014, these from
 * +88013).
 */
export const randomPhone = (): string =>
  (phones ??= phoneSource('+88013', process.env['DATABASE_URL']!))();
/**
 * A distinct client IP per call (sent as X-Forwarded-For) so per-IP limits don't collide. Fully
 * random: test files run in parallel workers and share Redis, so a per-worker counter repeats.
 */
export const randomIp = (): string => {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${(c! % 250) + 1}`;
};

export const http = (h: Harness) => request(h.app.getHttpServer());

export async function createTenant(
  h: Pick<Harness, 'prisma'>,
  opts: { status?: TenantStatus; modules?: ('ATTENDANCE' | 'FEES' | 'EXAMS')[] } = {},
) {
  return provisionTenant(h.prisma, {
    slug: `t-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Institute',
    instituteTypeKey: 'NCTB_SCHOOL_BN',
    status: opts.status ?? 'ACTIVE',
    modules: opts.modules ?? [],
    academicYear: {
      name: '2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    },
  });
}

export async function addMember(
  h: Harness,
  tenantId: string,
  opts: { phone?: string; roles?: Role[]; password?: string; name?: string } = {},
): Promise<{ userId: string; phone: string }> {
  const phone = opts.phone ?? randomPhone();
  const userId = await withTenant(h.prisma, tenantId, async (tx) => {
    const name = opts.name ?? 'Test User';
    const id = await findOrCreateUser(tx, phone, name);
    const roles = opts.roles ?? ['TEACHER'];
    for (const role of roles) {
      await tx.membership.create({ data: { tenantId, userId: id, role } });
    }
    // Staff are known to the institute by their staff profile (as POST /staff creates one).
    if (roles.some((r) => r !== 'GUARDIAN' && r !== 'STUDENT')) {
      await tx.staffProfile.upsert({
        where: { tenantId_userId: { tenantId, userId: id } },
        create: { tenantId, userId: id, name, phone },
        update: {},
      });
    }
    return id;
  });
  if (opts.password) {
    const passwordHash = await hash(opts.password);
    await withContext(h.prisma, { userId }, (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash } }),
    );
  }
  return { userId, phone };
}

export async function createStudent(h: Harness, tenantId: string, code: string) {
  return withTenant(h.prisma, tenantId, (tx) =>
    tx.student.create({ data: { tenantId, studentCode: code, nameEn: code } }),
  );
}

/** Wait for the queued SMS to a phone and return the 6-digit code in the latest one. */
export async function waitForOtp(h: Harness, phone: string, previousCount = 0): Promise<string> {
  return vi.waitFor(
    () => {
      const messages = h.sms.sentTo(phone);
      if (messages.length <= previousCount) throw new Error('no SMS yet');
      const code = /\b(\d{6})\b/.exec(messages.at(-1)!)?.[1];
      if (!code) throw new Error('no code in SMS');
      return code;
    },
    { timeout: 5_000, interval: 25 },
  );
}

/** Full OTP login; returns the response body (mobile client: includes refreshToken). */
export async function otpLogin(h: Harness, phone: string): Promise<AuthResponse> {
  const ip = randomIp();
  const before = h.sms.sentTo(phone).length;
  await http(h).post('/auth/otp/request').set('X-Forwarded-For', ip).send({ phone }).expect(202);
  const code = await waitForOtp(h, phone, before);
  const res = await http(h)
    .post('/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ phone, code, client: 'mobile' })
    .expect(200);
  return res.body as AuthResponse;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
