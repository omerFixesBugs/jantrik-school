import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  refreshSchema,
  switchTenantSchema,
  type AuthClient,
  type AuthResponse,
} from '@jantrik/shared';
import type { Request, Response } from 'express';
import { CurrentUser, Public, UserScoped } from '../common/decorators.js';
import type { Principal } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import type { Env } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { OTP_TTL_SEC } from './otp.service.js';
import { REFRESH_TTL_SEC, type SessionMeta } from './session.service.js';

export class OtpRequestDto extends zodDto(otpRequestSchema) {}
export class OtpVerifyDto extends zodDto(otpVerifySchema) {}
export class PasswordLoginDto extends zodDto(passwordLoginSchema) {}
export class RefreshDto extends zodDto(refreshSchema) {}
export class SwitchTenantDto extends zodDto(switchTenantSchema) {}

export const REFRESH_COOKIE = 'jantrik_rt';
/** Cookie-based refresh must also send this header (CSRF defence on top of SameSite=Strict). */
export const WEB_CLIENT_HEADER = 'x-jantrik-client';

@Controller('auth')
@UserScoped() // auth routes never need a tenant context (and must work for a suspended tenant)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
    await this.auth.requestOtp(dto.phone, req.ip ?? 'unknown');
    // Identical whether or not the phone belongs to a user.
    return { expiresIn: OTP_TTL_SEC };
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @Body() dto: OtpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await this.auth.loginWithOtp(dto.phone, dto.code, dto.client, meta(req));
    return this.deliver(response, dto.client, res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: PasswordLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await this.auth.loginWithPassword(
      dto.identifier,
      dto.password,
      dto.client,
      meta(req),
    );
    return this.deliver(response, dto.client, res);
  }

  /** Mobile: `{ refreshToken }` in the body. Web: the httpOnly cookie + X-Jantrik-Client: web. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const client: AuthClient = dto.refreshToken ? 'mobile' : 'web';
    const cookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const raw = dto.refreshToken ?? (req.get(WEB_CLIENT_HEADER) === 'web' ? cookie : undefined);
    if (!raw) throw new UnauthorizedException('Invalid credentials');
    const response = await this.auth.refresh(raw, meta(req));
    return this.deliver(response, client, res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() principal: Principal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(principal);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentUser() principal: Principal) {
    return this.auth.me(principal);
  }

  @Get('memberships')
  memberships() {
    return this.auth.memberships();
  }

  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(@CurrentUser() principal: Principal, @Body() dto: SwitchTenantDto) {
    return this.auth.switchTenant(principal, dto.tenantId);
  }

  /** Web gets the refresh token as a cookie only; mobile gets it in the body. */
  private deliver(response: AuthResponse, client: AuthClient, res: Response): AuthResponse {
    if (client === 'mobile') return response;
    const { refreshToken, ...body } = response;
    if (refreshToken) {
      res.cookie(REFRESH_COOKIE, refreshToken, {
        ...this.cookieOptions(),
        maxAge: REFRESH_TTL_SEC * 1000,
      });
    }
    return body;
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: 'strict' as const,
      path: '/auth',
    };
  }
}

function meta(req: Request): SessionMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}
