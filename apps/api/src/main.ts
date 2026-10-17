import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  // No request-body logging anywhere: bodies carry OTPs, passwords and refresh tokens.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('API_PORT', { infer: true }));
}
await bootstrap();
