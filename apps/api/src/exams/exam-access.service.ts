import { Injectable } from '@nestjs/common';
import type { Role } from '@jantrik/db';
import { RequestContext } from '../common/request-context.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

export interface ExamCaller {
  userId: string;
  roles: Role[];
  /** OWNER or ADMIN: every exam, sheet and report. */
  isAdmin: boolean;
}

/** Who is asking, for the exam services' own checks (the guards decide the route itself). */
@Injectable()
export class ExamAccessService {
  constructor(
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
  ) {}

  async caller(): Promise<ExamCaller> {
    const p = this.context.requirePrincipal();
    const roles = await this.access.getRoles(p.tenantId!, p.userId);
    return {
      userId: p.userId,
      roles,
      isAdmin: roles.includes('OWNER') || roles.includes('ADMIN'),
    };
  }
}
