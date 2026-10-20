import { Body, Controller, Get, HttpCode, Module, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  platformAuditQuerySchema,
  platformLoginSchema,
  platformVerifySchema,
  type PlatformAdminInfo,
  type PlatformAuditEntry,
  type PlatformLoginResponse,
  type PlatformVerifyResponse,
} from '@jantrik/shared';
import type { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformRoute } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { refreshCookieSecure } from '../config/dev-lan.js';
import type { Env } from '../config/env.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformDb } from './platform-db.js';
import { PlatformInstitutesController, PlatformInstitutesService } from './platform-institutes.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { PLATFORM_COOKIE, PLATFORM_COOKIE_PATH, PLATFORM_MAX_SEC } from './platform.constants.js';

class PlatformLoginDto extends zodDto(platformLoginSchema) {}
class PlatformVerifyDto extends zodDto(platformVerifySchema) {}
class PlatformAuditQueryDto extends zodDto(platformAuditQuerySchema) {}

/**
 * /platform: Jantrik's own admins. Separate from institute auth in every way. Every route is a
 * platform session route unless it says `@PlatformRoute('login')`.
 */
@Controller('platform')
@PlatformRoute()
export class PlatformController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly db: PlatformDb,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @PlatformRoute('login')
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() dto: PlatformLoginDto, @Req() req: Request): Promise<PlatformLoginResponse> {
    return this.auth.login(dto.identifier, dto.password, req.ip ?? 'unknown');
  }

  @PlatformRoute('login')
  @Post('auth/verify')
  @HttpCode(200)
  async verify(
    @Body() dto: PlatformVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformVerifyResponse> {
    const { token, backupCodes } = await this.auth.verify(
      dto.challengeId,
      dto.code,
      req.ip ?? 'unknown',
      req.get('user-agent') ?? null,
    );
    res.cookie(PLATFORM_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: PLATFORM_MAX_SEC * 1000,
    });
    res.setHeader('Cache-Control', 'no-store');
    const admin = await this.auth.adminForToken(token);
    return { admin, ...(backupCodes ? { backupCodes } : {}) };
  }

  @PlatformRoute()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.db.tx);
    res.clearCookie(PLATFORM_COOKIE, this.cookieOptions());
  }

  @PlatformRoute()
  @Get('auth/me')
  me(): Promise<PlatformAdminInfo> {
    return this.auth.me(this.db.tx);
  }

  @PlatformRoute()
  @Get('audit')
  audit(@Query() q: PlatformAuditQueryDto): Promise<PlatformAuditEntry[]> {
    return this.auth.audit(this.db.tx, q.before, q.beforeId, q.limit);
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: refreshCookieSecure({
        NODE_ENV: this.config.get('NODE_ENV', { infer: true }),
        DEV_LAN: this.config.get('DEV_LAN', { infer: true }),
        COOKIE_SECURE: this.config.get('COOKIE_SECURE', { infer: true }),
      }),
      sameSite: 'strict' as const,
      path: PLATFORM_COOKIE_PATH,
    };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [PlatformController, PlatformInstitutesController],
  providers: [PlatformAuthService, PlatformDb, PlatformPrismaService, PlatformInstitutesService],
  // The global PlatformAuthGuard and PlatformContextInterceptor (registered in AppModule) need it.
  exports: [PlatformDb, PlatformPrismaService],
})
export class PlatformModule {}
