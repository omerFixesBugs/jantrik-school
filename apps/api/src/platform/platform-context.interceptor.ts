import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withPlatformSession } from '@jantrik/db';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { PLATFORM_TX_TIMEOUT } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { PlatformPrismaService } from './platform-prisma.service.js';

const REQUEST_TX_TIMEOUT_MS = 15_000;

/**
 * Runs every platform session request in one transaction with `app.platform_session` set, so
 * the platform functions resolve the admin (and refuse without a live session). No tenant or
 * user is set: tenant tables show nothing. afterCommit callbacks run after the commit.
 */
@Injectable()
export class PlatformContextInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly context: RequestContext,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const platform = this.context.platform;
    if (!platform) return next.handle();
    const timeout =
      this.reflector.getAllAndOverride<number>(PLATFORM_TX_TIMEOUT, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? REQUEST_TX_TIMEOUT_MS;
    return from(this.run(platform.tokenHash, next, timeout));
  }

  private async run(tokenHash: string, next: CallHandler, timeout: number): Promise<unknown> {
    let committed: (() => unknown)[] = [];
    const result = await withPlatformSession(
      this.prisma.client,
      tokenHash,
      async (tx) => {
        this.context.beginTransaction(tx);
        try {
          const value = await lastValueFrom(next.handle(), { defaultValue: undefined });
          committed = this.context.endTransaction();
          return value;
        } catch (error) {
          this.context.endTransaction();
          throw error;
        }
      },
      { timeout, maxWait: 5_000 },
    );
    await this.context.runAfterCommit(committed);
    return result;
  }
}
