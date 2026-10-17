import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse } from '@jantrik/shared';
import { NoRateLimit, Public } from '../common/decorators.js';
import { HealthService } from './health.service.js';

@Public()
@NoRateLimit()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness + database check. Returns 503 when the database is unreachable. */
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
