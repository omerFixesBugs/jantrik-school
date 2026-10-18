import { Inject, Injectable } from '@nestjs/common';
import { withContext, withTenant, type ModuleKey, type Role, type TenantTx } from '@jantrik/db';
import type { Redis } from 'ioredis';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.constants.js';

const CACHE_TTL_SEC = 300;
const modulesKey = (tenantId: string) => `tenant:${tenantId}:modules`;
const rolesKey = (tenantId: string, userId: string) => `tenant:${tenantId}:user:${userId}:roles`;

/**
 * Enabled modules per tenant and roles per member, cached in Redis for the guards.
 * Every write goes through this service and invalidates the cache *after commit* (so a
 * concurrent read cannot re-cache the old value). The TTL is only a safety net.
 */
@Injectable()
export class TenantAccessService {
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
    return this.cached(rolesKey(tenantId, userId), () =>
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
    await this.context.afterCommit(() => this.redis.del(rolesKey(tenantId, userId)));
  }

  /** Drop a member's cached roles once the current request commits (after a direct write). */
  async invalidateRolesAfterCommit(tenantId: string, userId: string): Promise<void> {
    await this.context.afterCommit(() => this.redis.del(rolesKey(tenantId, userId)));
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
