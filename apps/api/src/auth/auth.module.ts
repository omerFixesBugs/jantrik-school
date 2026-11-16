import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OtpService } from './otp.service.js';
import { PasswordController } from './password.controller.js';
import { PasswordSettingsService } from './password-settings.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController, PasswordController],
  providers: [
    AuthService,
    OtpService,
    PasswordService,
    PasswordSettingsService,
    SessionService,
    TokenService,
  ],
  exports: [TokenService, SessionService, PasswordService],
})
export class AuthModule {}
