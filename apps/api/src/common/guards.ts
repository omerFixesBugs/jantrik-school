import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ModuleKey, Role } from '@jantrik/db';
import { TENANT_HEADER, TENANT_MISMATCH } from '@jantrik/shared';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { TokenService } from '../auth/token.service.js';
import type { Env } from '../config/env.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { IS_PUBLIC, NO_RATE_LIMIT, REQUIRED_MODULE, ROLES, USER_SCOPED } from './decorators.js';
import { RequestContext, type Principal } from './request-context.js';
import { revokedSessionKey } from './revocation.js';

type AuthedRequest = Request & { principal?: Principal };

/** Verifies the access token (unless @Public) and rejects revoked sessions. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly context: RequestContext,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException();

    const claims = await this.tokens.verifyAccess(token);
    if (!claims) throw new UnauthorizedException();
    if (await this.redis.exists(revokedSessionKey(claims.sid))) throw new UnauthorizedException();

    const principal: Principal = {
      userId: claims.sub,
      sessionId: claims.sid,
      ...(claims.tid ? { tenantId: claims.tid } : {}),
    };
    req.principal = principal;
    this.context.setPrincipal(principal);
    return true;
  }
}

/**
 * Tenant-switch safety. A page sends X-Jantrik-Tenant with the tenant it was loaded for; if the
 * access token now belongs to another tenant (switched in another tab), the request is refused
 * with 409 TENANT_MISMATCH instead of silently reading or writing the other institute's data.
 * Requests without the header (e.g. mobile) and account-level @UserScoped routes are not checked.
 */
@Injectable()
export class TenantHeaderGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(USER_SCOPED, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const expected = req.get(TENANT_HEADER);
    if (expected === undefined) return true;
    if (expected !== req.principal?.tenantId) {
      throw new ConflictException({
        statusCode: 409,
        code: TENANT_MISMATCH,
        message: 'The selected institute has changed. Reload the page.',
      });
    }
    return true;
  }
}

/** Per-user limit when authenticated, per-IP otherwise (many users share an IP in BD). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(NO_RATE_LIMIT, [ctx.getHandler(), ctx.getClass()])
    ) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    await this.limiter.consume(
      req.principal
        ? {
            key: `req-user:${req.principal.userId}`,
            limit: this.config.get('RATE_LIMIT_USER_PER_MIN', { infer: true }),
            windowSec: 60,
          }
        : {
            key: `req-ip:${req.ip}`,
            limit: this.config.get('RATE_LIMIT_IP_PER_MIN', { infer: true }),
            windowSec: 60,
          },
    );
    return true;
  }
}

/** @Roles(...): current roles in the selected tenant, from Redis (not from token claims). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: TenantAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;
    const principal = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal?.tenantId) throw new ForbiddenException('Select a tenant first');
    const roles = await this.access.getRoles(principal.tenantId, principal.userId);
    if (!required.some((r) => roles.includes(r))) throw new ForbiddenException();
    return true;
  }
}

/** @RequireModule(key): the module must be enabled for the selected tenant. */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: TenantAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const moduleKey = this.reflector.getAllAndOverride<ModuleKey | undefined>(REQUIRED_MODULE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!moduleKey) return true;
    const principal = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal?.tenantId) throw new ForbiddenException('Select a tenant first');
    const modules = await this.access.getEnabledModules(principal.tenantId);
    if (!modules.includes(moduleKey)) throw new ForbiddenException('Module not enabled');
    return true;
  }
}
