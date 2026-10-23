import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AppearanceModule } from './appearance/appearance.module.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ExamsModule } from './exams/exams.module.js';
import { FeesModule } from './fees/fees.module.js';
import {
  JwtAuthGuard,
  ModuleGuard,
  RateLimitGuard,
  RolesGuard,
  TenantHeaderGuard,
} from './common/guards.js';
import { PrismaErrorFilter } from './common/prisma-error.filter.js';
import { ZodValidationPipe } from './common/zod.js';
import { validateEnv, type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { MeModule } from './me/me.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SmsModule } from './sms/sms.module.js';
import { SetupModule } from './setup/setup.module.js';
import { StaffModule } from './staff/staff.module.js';
import { StudentsModule } from './students/students.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { PlatformAuthGuard } from './platform/platform-auth.guard.js';
import { PlatformContextInterceptor } from './platform/platform-context.interceptor.js';
import { PlatformModule } from './platform/platform.module.js';
import { TenantContextInterceptor } from './tenancy/tenant-context.interceptor.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Single root .env for the monorepo (cwd is apps/api when run via pnpm/turbo).
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
    // AsyncLocalStorage per request (principal, RLS transaction, afterCommit queue).
    ClsModule.forRoot({ global: true, middleware: { mount: true, saveReq: true, saveRes: true } }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
      }),
    }),
    RedisModule,
    PrismaModule,
    TenancyModule,
    AuditModule,
    SmsModule,
    AuthModule,
    HealthModule,
    MeModule,
    AppearanceModule,
    StudentsModule,
    SetupModule,
    StaffModule,
    ImportsModule,
    AttendanceModule,
    FeesModule,
    ExamsModule,
    PlatformModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Order matters: authenticate, check the page's tenant, rate-limit (per user if known),
    // then roles, then module.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // /platform/* (Jantrik's own admins): their own session cookie, never institute tokens.
    { provide: APP_GUARD, useClass: PlatformAuthGuard },
    { provide: APP_GUARD, useClass: TenantHeaderGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModuleGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: PlatformContextInterceptor },
    { provide: APP_FILTER, useClass: PrismaErrorFilter },
  ],
})
export class AppModule {}
