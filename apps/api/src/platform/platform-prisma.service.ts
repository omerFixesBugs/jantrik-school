import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaClient,
  loginPrivilegeProblems,
  readLoginPrivileges,
  type PrismaClient,
} from '@jantrik/db';
import {
  STARTUP_CHECK_TIMEOUT_MS,
  STARTUP_RETRY_DELAYS_MS,
  runStartupCheck,
  startupErrorLabel,
} from '../common/startup-check.js';
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
  /** Waits between failed start-up checks (about 3 minutes in all; tests shorten them). */
  retryDelaysMs: readonly number[] = STARTUP_RETRY_DELAYS_MS;
  /** How long one start-up check may take. */
  checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS;

  constructor(
    config: ConfigService<Env, true>,
    private readonly main: PrismaService,
  ) {
    this.client = createPrismaClient(config.get('DATABASE_PLATFORM_URL', { infer: true }));
  }

  /**
   * First the login's privileges, failing closed like the API's own login (PrismaService): never
   * a superuser, BYPASSRLS, or a login that can become such a role; while the check cannot run it
   * is asked again for about 3 minutes, then the start is refused.
   *
   * Then refuse to start when the two URLs are mixed up (e.g. DATABASE_URL pasted with the
   * platform login): the separation would silently disappear. An error in this second check only
   * warns (the first has just shown the database answers); requests fail on their own then.
   */
  async onModuleInit(): Promise<void> {
    await runStartupCheck({
      run: () => readLoginPrivileges(this.client),
      verdict: (p) => {
        const problems = loginPrivilegeProblems(p);
        return problems.length === 0
          ? true
          : `DATABASE_PLATFORM_URL must use the platform login (jantrik_platform_app): ` +
              `${p.login} ${problems.join(', ')}. See docs/platform.md.`;
      },
      retryDelaysMs: this.retryDelaysMs,
      checkTimeoutMs: this.checkTimeoutMs,
      logger: this.logger,
      what: "the platform module's database login (DATABASE_PLATFORM_URL)",
      unchecked: 'The platform module does not start unchecked.',
      label: startupErrorLabel,
    });

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
