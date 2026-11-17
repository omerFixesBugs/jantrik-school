import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { withContext, type Role, type TenantTx } from '@jantrik/db';
import type { Redis } from 'ioredis';
import { RequestContext, type Principal } from '../common/request-context.js';
import { revokedSessionKey } from '../common/revocation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS_CALL_TIMEOUT_MS, withRedisDeadline } from '../redis/redis-deadline.js';
import { REDIS } from '../redis/redis.constants.js';

export const REQUEST_TX_TIMEOUT_MS = 15_000;

/**
 * The authenticated request's RLS transaction (docs/auth.md → Request pipeline):
 *   withContext({ tenantId, userId }) → the tenant re-check → fn → commit → afterCommit callbacks.
 * A thrown error rolls the transaction back and drops the afterCommit callbacks. Services reach
 * the transaction through `Db.tx`.
 *
 * TenantContextInterceptor runs every authenticated route inside it. A route marked
 * `@OwnTransaction()` (uploads) runs without one and calls `run` itself once its slow part is
 * done (reading the body, decoding the image), so no database connection waits on a client.
 * Such a route passes `roles`: the guards checked the session and the roles when the request
 * arrived, which can be a minute before the store, so they are checked again in the transaction.
 */
@Injectable()
export class RequestTransaction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** For services on @OwnTransaction routes. */
  async run<T>(
    fn: () => Promise<T>,
    opts: { userScoped?: boolean; roles?: readonly Role[] } = {},
  ): Promise<T> {
    // Inside a request transaction this would replace it (and its afterCommit queue) in the
    // request context, and wait on its locks from a second connection.
    if (this.context.tx) {
      throw new InternalServerErrorException(
        'RequestTransaction.run: a transaction is already open',
      );
    }
    return this.around(fn, opts);
  }

  /**
   * TenantContextInterceptor's entry: the outermost transaction by definition, so no nesting
   * check. (A request made from inside a running job, as some tests do, inherits the job's
   * request context; the interceptor's transaction replaces it there, as it always has.)
   */
  async around<T>(
    fn: () => Promise<T>,
    opts: { userScoped?: boolean; roles?: readonly Role[] } = {},
  ): Promise<T> {
    const principal = this.context.requirePrincipal();
    // The session first, outside the transaction and with Redis's deadline (review round 3): a
    // slow Redis never holds a pooled connection.
    if (opts.roles) {
      await withRedisDeadline(
        () => this.sessionLive(principal),
        REDIS_CALL_TIMEOUT_MS,
        'SERVICE_UNAVAILABLE',
      );
    }
    const tenantId = opts.userScoped ? null : (principal.tenantId ?? null);
    let committed: (() => unknown)[] = [];
    const result = await withContext(
      this.prisma.client,
      { tenantId, userId: principal.userId },
      async (tx) => {
        if (tenantId) await assertTenantAccess(tx);
        if (opts.roles) await this.recheckRoles(tx, opts.roles);
        this.context.beginTransaction(tx);
        try {
          const value = await fn();
          committed = this.context.endTransaction();
          return value;
        } catch (error) {
          this.context.endTransaction(); // rollback: drop side effects
          throw error;
        }
      },
      { timeout: REQUEST_TX_TIMEOUT_MS, maxWait: 5_000 },
    );
    await this.context.runAfterCommit(committed);
    return result;
  }

  /** The session not revoked since the guards checked it. */
  private async sessionLive(principal: Principal): Promise<void> {
    if (await this.redis.exists(revokedSessionKey(principal.sessionId))) {
      throw new UnauthorizedException();
    }
  }

  /** The person still holding one of `roles` here, read in the transaction. */
  private async recheckRoles(tx: TenantTx, roles: readonly Role[]) {
    const held = await tx.$queryRaw<{ role: Role }[]>`
      SELECT role FROM memberships
      WHERE user_id = app_current_user_id() AND status = 'ACTIVE'`;
    if (!held.some((m) => roles.includes(m.role))) {
      throw new ForbiddenException('Your role here has changed');
    }
  }
}

/**
 * Re-checked on every tenant request (not just at switch-tenant), so suspending a tenant or
 * removing a membership takes effect immediately rather than when the access token expires.
 */
async function assertTenantAccess(tx: TenantTx): Promise<void> {
  const [row] = await tx.$queryRaw<{ status: string; member: boolean }[]>`
    SELECT t.status::text AS status,
           EXISTS (SELECT 1 FROM memberships m
                   WHERE m.user_id = app_current_user_id() AND m.status = 'ACTIVE') AS member
    FROM tenants t`;
  if (!row || !['ACTIVE', 'TRIAL'].includes(row.status) || !row.member) {
    throw new ForbiddenException('No access to this tenant');
  }
}
