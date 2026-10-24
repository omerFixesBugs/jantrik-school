import { Global, Module } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from './db.service.js';
import { InstituteProvisioning } from './institute-provisioning.service.js';
import { TenantAccessService } from './tenant-access.service.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { TenantJobRunner } from './tenant-job-runner.service.js';

@Global()
@Module({
  providers: [
    RequestContext,
    Clock,
    Db,
    TenantAccessService,
    TenantContextInterceptor,
    TenantJobRunner,
    InstituteProvisioning,
  ],
  exports: [
    RequestContext,
    Clock,
    Db,
    TenantAccessService,
    TenantContextInterceptor,
    TenantJobRunner,
    InstituteProvisioning,
  ],
})
export class TenancyModule {}
