import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@jantrik/shared';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResponse> {
    // In a transaction like every app query (P1-J8 review).
    const dbUp = await this.prisma.client
      .$transaction((tx) => tx.$queryRaw`SELECT 1`)
      .then(
        () => true,
        () => false,
      );
    return {
      status: dbUp ? 'ok' : 'error',
      db: dbUp ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    };
  }
}
