import { Global, Module } from '@nestjs/common';
import { RequestContext } from '../common/request-context.js';
import { Db } from './db.service.js';
import { TenantAccessService } from './tenant-access.service.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';

@Global()
@Module({
  providers: [RequestContext, Db, TenantAccessService, TenantContextInterceptor],
  exports: [RequestContext, Db, TenantAccessService, TenantContextInterceptor],
})
export class TenancyModule {}
