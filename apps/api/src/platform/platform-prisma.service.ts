import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '@jantrik/db';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The platform module's own database login (DATABASE_PLATFORM_URL, role jantrik_platform_app).
 * Only this role may run the platform_* functions; the rest of the API (jantrik_app) cannot, so
 * an SQL injection anywhere in the institute API never reaches platform logins or sessions.
 * Provided by PlatformModule only (platform-isolation.spec.ts checks who imports it).
 */
@Injectable()
export class PlatformPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformPrismaService.name);
  readonly client: PrismaClient;

  constructor(
    config: ConfigService<Env, true>,
    private readonly main: PrismaService,
  ) {
    this.client = createPrismaClient(config.get('DATABASE_PLATFORM_URL', { infer: true }));
  }

  /**
   * Refuse to start when the two URLs are mixed up (e.g. DATABASE_URL pasted with the platform
   * login): the separation would silently disappear. An unreachable database only warns here;
   * requests fail on their own then.
   */
  async onModuleInit(): Promise<void> {
    const canRun = (client: PrismaClient) =>
      client.$queryRaw<{ ok: boolean }[]>`
        SELECT has_function_privilege('public.platform_me()', 'EXECUTE') AS ok`.then(
        ([row]) => row?.ok === true,
      );
    let platform: boolean;
    let main: boolean;
    try {
      [platform, main] = await Promise.all([canRun(this.client), canRun(this.main.client)]);
    } catch (error) {
      this.logger.warn(`Could not check the database roles: ${(error as Error).message}`);
      return;
    }
    if (!platform || main) {
      throw new Error(
        'Database roles are mixed up: DATABASE_PLATFORM_URL must use the platform login ' +
          '(jantrik_platform_app) and DATABASE_URL the app login (jantrik_app). See docs/platform.md.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
