import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { hashPlatformToken } from '@jantrik/db';
import { PLATFORM_CLIENT } from '@jantrik/shared';
import type { Request } from 'express';
import { WEB_CLIENT_HEADER } from '../auth/auth.controller.js';
import { apiError } from '../common/api-error.js';
import { PLATFORM } from '../common/decorators.js';
import { RequestContext, type PlatformPrincipal } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { isPlatformOrigin, type PlatformOriginEnv } from './platform-origin.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import {
  PLATFORM_COOKIE,
  PLATFORM_IDLE_SEC,
  PLATFORM_REQUESTS_PER_IP_PER_MIN,
} from './platform.constants.js';

type PlatformRequest = Request & { platform?: PlatformPrincipal };

/**
 * Guards /platform/* routes (@PlatformRoute). Every request must come from a PLATFORM_ORIGINS
 * origin (checked first: 403 PLATFORM_ORIGIN_REFUSED) and send X-Jantrik-Client: platform (with
 * the SameSite=Strict cookie, the CSRF defence). Session routes need the
 * jantrik_ps cookie of a live session: checked in the database on every request, which also
 * renews the idle timeout (never past the 8-hour end). Institute tokens never count here, and
 * this cookie never counts on institute routes.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  /** Read once: which browser origins may call /platform/* (env.ts → PLATFORM_ORIGINS). */
  private readonly originEnv: PlatformOriginEnv;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PlatformPrismaService,
    private readonly context: RequestContext,
    private readonly limiter: RateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.originEnv = {
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      DEV_LAN: config.get('DEV_LAN', { infer: true }),
      PLATFORM_ORIGINS: config.get('PLATFORM_ORIGINS', { infer: true }),
    };
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const mode = this.reflector.getAllAndOverride<'session' | 'login'>(PLATFORM, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!mode) return true;
    const req = ctx.switchToHttp().getRequest<PlatformRequest>();
    // First, before anything else: only the platform's own web origin. The institute app is
    // allowed by CORS too and shares the cookie's site (deployment requirement 1).
    if (!isPlatformOrigin(req.get('Origin'), this.originEnv)) {
      throw apiError(
        403,
        'PLATFORM_ORIGIN_REFUSED',
        'Platform requests come from the platform app',
      );
    }
    if (req.get(WEB_CLIENT_HEADER) !== PLATFORM_CLIENT) {
      throw apiError(
        403,
        'PLATFORM_CLIENT_REQUIRED',
        'Platform requests come from the platform app',
      );
    }
    if (mode === 'login') return true;

    // Before the database lookup, so junk cookies cannot hammer it (the per-admin limit applies
    // after a valid session is found).
    await this.limiter.consume({
      key: `platform-ip:${req.ip}`,
      limit: PLATFORM_REQUESTS_PER_IP_PER_MIN,
      windowSec: 60,
    });

    const token: unknown = req.cookies?.[PLATFORM_COOKIE];
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
      throw new UnauthorizedException();
    }
    const tokenHash = hashPlatformToken(token);
    const [row] = await this.prisma.client.$queryRaw<
      { session_id: string; admin_id: string; admin_name: string }[]
    >`SELECT * FROM platform_session_admin(${tokenHash}, ${PLATFORM_IDLE_SEC}::int)`;
    if (!row) throw new UnauthorizedException();
    const platform: PlatformPrincipal = {
      adminId: row.admin_id,
      sessionId: row.session_id,
      tokenHash,
      name: row.admin_name,
    };
    req.platform = platform;
    this.context.setPlatform(platform);
    return true;
  }
}
