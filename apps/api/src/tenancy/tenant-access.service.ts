import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { withContext, withTenant, type ModuleKey, type Role, type TenantTx } from '@jantrik/db';
import type { Redis } from 'ioredis';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.constants.js';

const CACHE_TTL_SEC = 300;
const modulesKey = (tenantId: string) => `tenant:${tenantId}:modules`;
/**
 * The member's roles-cache version, bumped after every committed role/status change. It has no
 * expiry (one small counter per member): a counter that expired could start again at a number
 * whose stale entry is still cached.
 */
export const rolesVersionKey = (tenantId: string, userId: string) =>
  `tenant:${tenantId}:user:${userId}:roles:ver`;
export const rolesKey = (tenantId: string, userId: string, version: string) =>
  `tenant:${tenantId}:user:${userId}:roles:v${version}`;

/**
 * Enabled modules per tenant and roles per member, cached in Redis for the guards.
 * Module writes invalidate after commit. Roles are cached under a per-member version that every
 * change bumps after commit: a request that loaded the old roles just before the change can only
 * write them under the old version, which nobody reads any more (no stale re-cache). The TTL is
 * only a safety net.
 */
@Injectable()
export class TenantAccessService {
  private readonly logger = new Logger(TenantAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async getEnabledModules(tenantId: string): Promise<ModuleKey[]> {
    return this.cached(modulesKey(tenantId), () =>
      withTenant(this.prisma.client, tenantId, async (tx) =>
        (await tx.tenantModule.findMany({ where: { enabled: true } })).map((m) => m.moduleKey),
      ),
    );
  }

  async getRoles(tenantId: string, userId: string): Promise<Role[]> {
    // The version is read before loading: see the class comment.
    const version = (await this.redis.get(rolesVersionKey(tenantId, userId))) ?? '0';
    return this.cached(rolesKey(tenantId, userId, version), () =>
      withContext(this.prisma.client, { tenantId, userId }, async (tx) =>
        (await tx.membership.findMany({ where: { userId, status: 'ACTIVE' } })).map((m) => m.role),
      ),
    );
  }

  async setModuleEnabled(tenantId: string, moduleKey: ModuleKey, enabled: boolean): Promise<void> {
    const enabledAt = enabled ? new Date() : null;
    await this.inTenant(tenantId, (tx) =>
      tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
        create: { tenantId, moduleKey, enabled, enabledAt },
        update: { enabled, enabledAt },
      }),
    );
    await this.context.afterCommit(() => this.redis.del(modulesKey(tenantId)));
  }

  /** Replace a member's roles in a tenant (e.g. ADMIN → TEACHER). */
  async setMemberRoles(tenantId: string, userId: string, roles: Role[]): Promise<void> {
    await this.inTenant(tenantId, async (tx) => {
      await tx.membership.deleteMany({ where: { userId, role: { notIn: roles } } });
      for (const role of roles) {
        await tx.membership.upsert({
          where: { tenantId_userId_role: { tenantId, userId, role } },
          create: { tenantId, userId, role },
          update: {},
        });
      }
    });
    await this.invalidateRolesAfterCommit(tenantId, userId);
  }

  /**
   * The caller answers their own staff invitation to `tenantId`. Runs in its own transaction with
   * that tenant + the caller's user context, but only after finding INVITED rows for the caller
   * there; it changes only those rows (never anyone else's, never other statuses). The rows are
   * locked first (staff changes lock them too), and an accept must name exactly the roles the
   * invitee was shown. Audited.
   */
  async respondToInvitation(
    userId: string,
    tenantId: string,
    accept: boolean,
    expiresAfterMs: number,
    shownRoles: readonly string[] = [],
  ): Promise<void> {
    await withContext(this.prisma.client, { tenantId, userId }, async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM memberships
        WHERE user_id = ${userId}::uuid AND status = 'INVITED'
        ORDER BY id
        FOR UPDATE`;
      // A fresh read after the lock: it also sees rows a concurrent role change committed.
      const rows = await tx.membership.findMany({
        where: { userId, status: 'INVITED' },
        select: { id: true, role: true, invitedAt: true },
      });
      if (rows.length === 0) throw new NotFoundException('No invitation');
      const sent = Math.max(...rows.map((r) => r.invitedAt?.getTime() ?? 0));
      if (sent + expiresAfterMs < Date.now()) {
        throw new HttpException(
          { statusCode: 410, code: 'INVITATION_EXPIRED', message: 'Expired' },
          410,
        );
      }
      const roles = rows.map((r) => r.role as string);
      if (
        accept &&
        (roles.length !== shownRoles.length || roles.some((r) => !shownRoles.includes(r)))
      ) {
        throw new HttpException(
          { statusCode: 409, code: 'INVITATION_CHANGED', message: 'The invitation changed' },
          409,
        );
      }
      const status = accept ? 'ACTIVE' : 'DECLINED';
      const { count } = await tx.membership.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, userId, status: 'INVITED' },
        data: { status },
      });
      if (count !== rows.length) throw new NotFoundException('No invitation');
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: userId,
          entity: 'membership',
          entityId: userId,
          action: 'UPDATE',
          oldValues: { status: 'INVITED', roles: rows.map((r) => r.role) },
          newValues: { status, roles: rows.map((r) => r.role), by: 'invitee' },
        },
        select: { id: true },
      });
    });
    // Its own transaction has committed: a failed bump must not turn the answer into an error.
    await this.bumpRoles(tenantId, userId).catch(() => undefined);
  }

  /** Retire a member's cached roles once the current request commits (after any membership write). */
  async invalidateRolesAfterCommit(tenantId: string, userId: string): Promise<void> {
    await this.context.afterCommit(() => this.bumpRoles(tenantId, userId));
  }

  /** Errors are logged and rethrown; the old roles then last at most the cache TTL. */
  private async bumpRoles(tenantId: string, userId: string): Promise<void> {
    try {
      await this.redis.incr(rolesVersionKey(tenantId, userId));
    } catch (error) {
      this.logger.error(
        `roles cache bump failed for tenant ${tenantId} user ${userId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /** Use the request transaction when it is for this tenant; otherwise open one. */
  private async inTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tx = this.context.tx;
    if (tx && this.context.principal?.tenantId === tenantId) return fn(tx);
    return withTenant(this.prisma.client, tenantId, fn);
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await load();
    await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SEC);
    return value;
  }
}
