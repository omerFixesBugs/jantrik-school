import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@jantrik/db';
import { RequestContext } from '../common/request-context.js';

/** The platform request's transaction (app.platform_session set by PlatformContextInterceptor). */
@Injectable()
export class PlatformDb {
  constructor(private readonly context: RequestContext) {}

  get tx(): TenantTx {
    this.context.requirePlatform();
    const tx = this.context.tx;
    if (!tx) throw new Error('No platform transaction');
    return tx;
  }
}
