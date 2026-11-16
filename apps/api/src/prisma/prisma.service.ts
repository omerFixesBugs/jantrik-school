import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaClient,
  loginStartupVerdict,
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

/**
 * Owns the API's Prisma client (DATABASE_URL, role jantrik_app). The platform module has its own
 * login: PlatformPrismaService (src/platform).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Database');
  readonly client: PrismaClient;
  /** Production refuses a login that may create temporary objects; elsewhere it warns. */
  private readonly production: boolean;
  /** Waits between failed start-up checks (about 3 minutes in all; tests shorten them). */
  retryDelaysMs: readonly number[] = STARTUP_RETRY_DELAYS_MS;
  /** How long one start-up check may take. */
  checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS;

  constructor(config: ConfigService<Env, true>) {
    this.client = createPrismaClient(config.get('DATABASE_URL', { infer: true }));
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * The API (and the worker) start only with a login that RLS applies to: never a superuser, one
   * with BYPASSRLS, or one that can become such a role. Fail closed: while the check cannot run
   * (the database is not reachable yet) it is asked again for about 3 minutes, then the start is
   * refused.
   *
   * A login that may create temporary objects (TEMP on the database) or has stored role settings
   * (`ALTER ROLE … SET`) is refused in production and warned about elsewhere (P1-J8 review:
   * loginStartupVerdict).
   */
  async onModuleInit(): Promise<void> {
    await runStartupCheck({
      run: () => readLoginPrivileges(this.client),
      verdict: (p) => {
        const { problems, warnings } = loginStartupVerdict(p, { production: this.production });
        for (const w of warnings) this.logger.warn(w);
        return problems.length === 0
          ? true
          : `DATABASE_URL must use the app login (jantrik_app), which Row-Level Security applies ` +
              `to: ${p.login} ${problems.join(', ')}. See docs/database.md.`;
      },
      retryDelaysMs: this.retryDelaysMs,
      checkTimeoutMs: this.checkTimeoutMs,
      logger: this.logger,
      what: "the API's database login (DATABASE_URL)",
      unchecked: 'The API does not start unchecked.',
      label: startupErrorLabel,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
