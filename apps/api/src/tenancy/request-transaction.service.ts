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
    const principal = this.context.requirePrincipal();
    const tenantId = opts.userScoped ? null : (principal.tenantId ?? null);
    let committed: (() => unknown)[] = [];
    const result = await withContext(
      this.prisma.client,
      { tenantId, userId: principal.userId },
      async (tx) => {
        if (tenantId) await assertTenantAccess(tx);
        if (opts.roles) await this.recheck(tx, principal, opts.roles);
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

  /** The session still live and the person still holding one of `roles` here, read now. */
  private async recheck(tx: TenantTx, principal: Principal, roles: readonly Role[]) {
    if (await this.redis.exists(revokedSessionKey(principal.sessionId))) {
      throw new UnauthorizedException();
    }
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
