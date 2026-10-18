import { Global, Module } from '@nestjs/common';
import { RequestContext } from '../common/request-context.js';
import { Db } from './db.service.js';
import { TenantAccessService } from './tenant-access.service.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { TenantJobRunner } from './tenant-job-runner.service.js';

@Global()
@Module({
  providers: [RequestContext, Db, TenantAccessService, TenantContextInterceptor, TenantJobRunner],
  exports: [RequestContext, Db, TenantAccessService, TenantContextInterceptor, TenantJobRunner],
})
export class TenancyModule {}
