import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaClient,
  loadRequestContextKey,
  loginPrivilegeProblems,
  readLoginPrivileges,
  requestContextKey,
  setRequestContextKeySource,
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
 * The password login's own database login (DATABASE_LOGIN_URL, role jantrik_login_app, P1-J).
 * It may run one function, auth_find_user_for_password_login, and nothing else; the rest of the
 * API (jantrik_app) may not run that function, so an SQL injection in an ordinary request never
 * reaches a password hash. Used by AuthService.loginWithPassword only
 * (login-isolation.spec.ts checks who imports it). A small pool: one lookup per login.
 *
 * It also reads the request context key (P1-J8), the other thing only this login may read: every
 * institute transaction of the API and the worker is signed with it (withContext, docs/auth.md →
 * The request context). The source is registered when the service is built, so any module may
 * open a context during start-up. The key is loaded at start-up. When it cannot be (the
 * migrations have not run yet), production refuses to start; development and tests only log an
 * error and load it on the first institute transaction (Playwright starts the API before its
 * global setup migrates jantrik_e2e). Without a key no context can be signed, so every institute
 * transaction fails: closed, and loud.
 */
@Injectable()
export class LoginPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoginPrismaService.name);
  readonly client: PrismaClient;
  /** Production refuses to start without the request context key; elsewhere it only logs. */
  private readonly production: boolean;
  /** Waits between failed start-up checks (about 3 minutes in all; tests shorten them). */
  retryDelaysMs: readonly number[] = STARTUP_RETRY_DELAYS_MS;
  /** How long one start-up check may take. */
  checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS;

  constructor(
    config: ConfigService<Env, true>,
    private readonly main: PrismaService,
  ) {
    this.client = createPrismaClient(config.get('DATABASE_LOGIN_URL', { infer: true }), {
      max: 4,
    });
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
    this.registerContextKeySource();
  }

  /** withContext reads the request context key through this login (once, then from memory). */
  registerContextKeySource(): void {
    setRequestContextKeySource(() => loadRequestContextKey(this.client));
  }

  /**
   * First the login's privileges, failing closed like the API's own login (PrismaService): never
   * a superuser, BYPASSRLS, or a login that can become such a role; while the check cannot run it
   * is asked again for about 3 minutes, then the start is refused.
   *
   * Then refuse to start when the URLs are mixed up (DATABASE_URL given the login login, or the
   * other way round: the separation would silently disappear), or reach different databases (a
   * password login against another database than the sessions it creates). An error in these
   * checks only warns (the first has just shown the database answers); logins fail on their own.
   */
  async onModuleInit(): Promise<void> {
    await runStartupCheck({
      run: () => readLoginPrivileges(this.client),
      verdict: (p) => {
        const problems = loginPrivilegeProblems(p);
        return problems.length === 0
          ? true
          : `DATABASE_LOGIN_URL must use the password login's login (jantrik_login_app): ` +
              `${p.login} ${problems.join(', ')}. See docs/auth.md.`;
      },
      retryDelaysMs: this.retryDelaysMs,
      checkTimeoutMs: this.checkTimeoutMs,
      logger: this.logger,
      what: "the password login's database login (DATABASE_LOGIN_URL)",
      unchecked: 'The password login does not start unchecked.',
      label: startupErrorLabel,
    });

    // P1-J8: read the key now. Production refuses to start without it (the migrations run
    // before the apps, docs/deploy.md). Elsewhere every institute transaction tries again and
    // fails until it can (no key, no context), so an API started before its migrations
    // (Playwright's global setup migrates after starting it) heals by itself.
    try {
      await requestContextKey();
    } catch (error) {
      const message =
        'Could not read the request context key through DATABASE_LOGIN_URL ' +
        `(${(error as Error).message}). Run the database migrations. See docs/auth.md.`;
      if (this.production) throw new Error(message);
      this.logger.error(`${message} Institute requests fail until the key can be read.`);
    }

    const canRun = (client: PrismaClient) =>
      client.$queryRaw<{ ok: boolean }[]>`
        SELECT has_function_privilege(
          'public.auth_find_user_for_password_login(text, text)', 'EXECUTE') AS ok`.then(
        ([row]) => row?.ok === true,
      );
    // Where each login is connected: the database, the port and the server's start time (one
    // cluster has one). Not the address: "localhost" may reach ::1 on one connection and
    // 127.0.0.1 on the next.
    const where = (client: PrismaClient) =>
      client.$queryRaw<{ db: string; port: number | null; started: Date }[]>`
        SELECT current_database() AS db, inet_server_port() AS port,
               pg_postmaster_start_time() AS started`.then(([row]) =>
        row ? `${row.db}:${row.port ?? 'socket'}:${new Date(row.started).toISOString()}` : '',
      );
    let login: boolean;
    let main: boolean;
    let loginAt: string;
    let mainAt: string;
    try {
      [login, main, loginAt, mainAt] = await Promise.all([
        canRun(this.client),
        canRun(this.main.client),
        where(this.client),
        where(this.main.client),
      ]);
    } catch (error) {
      this.logger.warn(`Could not check the database roles: ${(error as Error).message}`);
      return;
    }
    if (!login || main) {
      throw new Error(
        'Database roles are mixed up: DATABASE_LOGIN_URL must use the password login (jantrik_login_app) ' +
          'and DATABASE_URL the app login (jantrik_app). See docs/auth.md.',
      );
    }
    if (loginAt !== mainAt) {
      throw new Error(
        'DATABASE_LOGIN_URL and DATABASE_URL must reach the same database on the same server ' +
          `(${loginAt} and ${mainAt}). See docs/auth.md.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
