import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import {
  setPasswordSchema,
  STAFF_ROLE_VALUES,
  type PasswordCodeSent,
  type PasswordStatus,
} from '@jantrik/shared';
import type { Request } from 'express';
import { CurrentUser, RequireModule, Roles } from '../common/decorators.js';
import type { Principal } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { PasswordSettingsService } from './password-settings.service.js';

export class SetPasswordDto extends zodDto(setPasswordSchema) {}

/**
 * A staff member's own password (sprint 1 P1). In the current institute, for staff roles there
 * (P1-A): guardians and students get 403 and stay on codes.
 */
@Controller('me/password')
@RequireModule('CORE')
@Roles(...STAFF_ROLE_VALUES)
export class PasswordController {
  constructor(private readonly settings: PasswordSettingsService) {}

  @Get()
  status(@CurrentUser() principal: Principal): Promise<PasswordStatus> {
    return this.settings.status(principal);
  }

  @Post('code')
  @HttpCode(202)
  sendCode(@CurrentUser() principal: Principal, @Req() req: Request): Promise<PasswordCodeSent> {
    return this.settings.sendCode(principal, req.ip ?? 'unknown');
  }

  @Put()
  @HttpCode(204)
  async set(
    @CurrentUser() principal: Principal,
    @Body() dto: SetPasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.settings.set(principal, req.ip ?? 'unknown', dto);
  }
}
