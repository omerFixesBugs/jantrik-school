import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  INVITATION_DAYS,
  PLATFORM_MODULES,
  platformCreateInstituteSchema,
  platformInstituteListQuerySchema,
  platformLimitsSchema,
  platformModuleSchema,
  platformOwnerSchema,
  platformStatusChangeSchema,
  todayIn,
  type IsoDate,
  type PlatformInstituteDetail,
  type PlatformInstituteListItem,
  type PlatformInstituteOptions,
  type PlatformInstituteOwner,
  type PlatformInstitutePage,
  type PlatformLimits,
  type PlatformModule,
  type PlatformOwnerStatus,
} from '@jantrik/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { apiError } from '../common/api-error.js';
import { PlatformRoute, PlatformTxTimeout } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { InstituteProvisioning } from '../tenancy/institute-provisioning.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { PlatformDb } from './platform-db.js';

class CreateInstituteDto extends zodDto(platformCreateInstituteSchema) {}
class InstituteListQueryDto extends zodDto(platformInstituteListQuerySchema) {}
class StatusChangeDto extends zodDto(platformStatusChangeSchema) {}
class ModuleDto extends zodDto(platformModuleSchema) {}
class LimitsDto extends zodDto(platformLimitsSchema) {}
class OwnerDto extends zodDto(platformOwnerSchema) {}

const INVITE_MS = INVITATION_DAYS * 24 * 3600 * 1000;
/** Institutes are created in Dhaka time unless the type says otherwise (all do today). */
const DEFAULT_TZ = 'Asia/Dhaka';

interface ListRow {
  id: string;
  name: string;
  slug: string;
  type_key: string;
  type_name_bn: string;
  type_name_en: string;
  status: PlatformInstituteListItem['status'];
  plan_name: string | null;
  trial_ends_on: Date | null;
  created_at: Date;
  owner_name: string | null;
  owner_name_bn: string | null;
  owner_phone: string | null;
  owner_status: string | null;
  owner_invited_at: Date | null;
  active_students: bigint;
  sms_this_month: bigint;
  total: bigint;
}

/**
 * Institutes as Jantrik's admins see them: metadata, plan, limits and counts, through the
 * platform functions (never an institute's students, guardians or attendance). Writes inside an
 * institute (creating it, its owner invitation) go through InstituteProvisioning, which runs as
 * the API's main role in its own transaction; the platform side (plan, platform audit) follows in
 * this request's platform transaction.
 */
@Injectable()
export class PlatformInstitutesService {
  constructor(
    private readonly db: PlatformDb,
    private readonly context: RequestContext,
    private readonly provisioning: InstituteProvisioning,
    private readonly access: TenantAccessService,
  ) {}

  private get adminId(): string {
    return this.context.requirePlatform().adminId;
  }

  async options(): Promise<PlatformInstituteOptions> {
    const [row] = await this.db.tx.$queryRaw<{ v: PlatformInstituteOptions }[]>`
      SELECT platform_institute_options() AS v`;
    return { types: row?.v.types ?? [], plans: [...(row?.v.plans ?? [])].sort() };
  }

  async list(q: z.output<typeof platformInstituteListQuerySchema>): Promise<PlatformInstitutePage> {
    const query = (offset: number, limit: number) => this.db.tx.$queryRaw<ListRow[]>`
      SELECT * FROM platform_list_institutes(${q.search || null}, ${q.type || null},
        ${q.status ?? null}, ${q.plan || null}, ${q.trialEnded ?? null}::boolean,
        ${offset}::int, ${limit}::int)`;
    const rows = await query((q.page - 1) * q.pageSize, q.pageSize);
    // Past the last page: still report the total.
    const total = rows[0]?.total ?? (q.page > 1 ? ((await query(0, 1))[0]?.total ?? 0n) : 0n);
    const today = todayIn(DEFAULT_TZ);
    return {
      items: rows.map((r) => {
        const trialEndsOn = r.trial_ends_on ? isoDate(r.trial_ends_on) : null;
        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          type: { key: r.type_key, nameBn: r.type_name_bn, nameEn: r.type_name_en },
          status: r.status,
          planName: r.plan_name,
          trialEndsOn,
          trialEnded: r.status === 'TRIAL' && trialEndsOn !== null && trialEndsOn < today,
          createdAt: r.created_at.toISOString(),
          owner: r.owner_status
            ? {
                name: r.owner_name,
                nameBn: r.owner_name_bn,
                phone: r.owner_phone,
                status: ownerStatus(r.owner_status, r.owner_invited_at),
                invitedAt: r.owner_invited_at?.toISOString() ?? null,
              }
            : null,
          activeStudents: Number(r.active_students),
          smsThisMonth: Number(r.sms_this_month),
        };
      }),
      total: Number(total),
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async detail(id: string): Promise<PlatformInstituteDetail> {
    const rows = await this.db.tx.$queryRaw<
      { v: RawDetail }[]
    >`SELECT platform_get_institute(${id}::uuid) AS v`.catch(platformDbError);
    return toDetail(rows[0]!.v);
  }

  /**
   * Provision a TRIAL institute with its owner invitation, then record the plan, limits and the
   * platform audit entry. The response is built from what was typed: the same whether or not
   * the owner's phone already belonged to someone.
   */
  async create(input: z.output<typeof platformCreateInstituteSchema>, ip: string) {
    const year = input.academicYear ?? calendarYear(todayIn(DEFAULT_TZ));
    const { tenantId } = await this.provisioning.create(
      {
        name: input.name,
        slug: input.slug,
        instituteTypeKey: input.instituteTypeKey,
        modules: input.modules,
        academicYear: year,
        owner: input.owner,
      },
      this.adminId,
    );
    const p = input.plan;
    const details = {
      name: input.name,
      slug: input.slug,
      instituteType: input.instituteTypeKey,
      modules: input.modules,
      owner: { name: input.owner.name, phone: input.owner.phone },
      plan: p,
      trialEndsOn: input.trialEndsOn,
      limits: input.limits,
    };
    await this.db.tx.$executeRaw`
      SELECT platform_register_institute(${tenantId}::uuid, ${p.planName}, ${p.pricing},
        ${p.corePaisa}::int, ${p.attendancePaisa}::int, ${p.feesPaisa}::int, ${p.examsPaisa}::int,
        ${p.flatPaisa}::int, ${p.cycle}, ${p.yearlyDiscountPercent}::int, ${p.dueDays}::int,
        ${input.trialEndsOn}::date, ${input.limits.studentLimit}::int,
        ${input.limits.smsDailyCap}::int, ${JSON.stringify(details)}::jsonb, ${ip})`.catch(
      platformDbError,
    );
    return {
      id: tenantId,
      name: input.name,
      slug: input.slug,
      owner: {
        name: input.owner.name,
        nameBn: input.owner.nameBn,
        phone: input.owner.phone,
        status: 'INVITED' as const,
        inviteExpiresAt: new Date(Date.now() + INVITE_MS).toISOString(),
      },
    };
  }

  async setStatus(id: string, action: 'SUSPEND' | 'REACTIVATE', reason: string, ip: string) {
    await this.db.tx.$queryRaw`
      SELECT platform_set_institute_status(${id}::uuid, ${action}, ${reason}, ${ip})::text AS s`.catch(
      platformDbError,
    );
    return this.detail(id);
  }

  async setModule(id: string, module: PlatformModule, enabled: boolean, ip: string) {
    const [row] = await this.db.tx.$queryRaw<{ changed: boolean }[]>`
      SELECT platform_set_module(${id}::uuid, ${module}, ${enabled}, ${ip}) AS changed`.catch(
      platformDbError,
    );
    if (row?.changed) await this.access.invalidateModulesAfterCommit(id);
    return this.detail(id);
  }

  async setLimits(id: string, limits: PlatformLimits, ip: string) {
    await this.db.tx.$executeRaw`
      SELECT platform_set_limits(${id}::uuid, ${limits.studentLimit}::int,
        ${limits.smsDailyCap}::int, ${ip})`.catch(platformDbError);
    return this.detail(id);
  }

  async inviteOwner(id: string, owner: z.output<typeof platformOwnerSchema>, ip: string) {
    const { userId } = await this.provisioning.inviteOwner(id, owner, this.adminId);
    await this.audit(
      'INSTITUTE_OWNER_INVITE',
      id,
      userId,
      {
        name: owner.name,
        phone: owner.phone,
      },
      ip,
    );
    return this.detail(id);
  }

  async resendOwnerInvitation(id: string, userId: string, ip: string) {
    await this.provisioning.resendOwnerInvitation(id, userId, this.adminId);
    await this.audit('INSTITUTE_OWNER_REINVITE', id, userId, {}, ip);
    return this.detail(id);
  }

  async cancelOwnerInvitation(id: string, userId: string, ip: string) {
    await this.provisioning.cancelOwnerInvitation(id, userId, this.adminId);
    await this.audit('INSTITUTE_OWNER_CANCEL', id, userId, {}, ip);
    return this.detail(id);
  }

  private async audit(
    action: string,
    tenantId: string,
    userId: string,
    details: Record<string, unknown>,
    ip: string,
  ): Promise<void> {
    await this.db.tx.$queryRaw`
      SELECT platform_audit(${action}, ${tenantId}::uuid, 'membership', ${userId},
        ${JSON.stringify(details)}::jsonb, ${ip})::text AS id`;
  }
}

// ── mapping ──

interface RawDetail extends Omit<
  PlatformInstituteDetail,
  'owners' | 'trialEnded' | 'createdAt' | 'suspendedAt' | 'modules' | 'counts'
> {
  createdAt: string;
  suspendedAt: string | null;
  modules: {
    key: PlatformInstituteDetail['modules'][number]['key'];
    enabled: boolean;
    enabledAt: string | null;
  }[];
  owners: (Omit<PlatformInstituteOwner, 'status' | 'inviteExpiresAt'> & { status: string })[];
  counts: Omit<PlatformInstituteDetail['counts'], 'lastActivityAt'> & {
    lastActivityAt: string | null;
  };
}

function toDetail(v: RawDetail): PlatformInstituteDetail {
  const today = todayIn(v.timezone);
  const trialEndsOn = v.subscription?.trialEndsOn ?? null;
  return {
    ...v,
    createdAt: iso(v.createdAt)!,
    suspendedAt: iso(v.suspendedAt),
    modules: v.modules.map((m) => ({ ...m, enabledAt: iso(m.enabledAt) })),
    trialEnded: v.status === 'TRIAL' && trialEndsOn !== null && trialEndsOn < today,
    owners: v.owners.map((o) => {
      const invitedAt = o.invitedAt ? new Date(o.invitedAt) : null;
      const status = ownerStatus(o.status, invitedAt);
      return {
        ...o,
        status,
        invitedAt: invitedAt?.toISOString() ?? null,
        inviteExpiresAt:
          status === 'INVITED' && invitedAt
            ? new Date(invitedAt.getTime() + INVITE_MS).toISOString()
            : null,
      };
    }),
    counts: { ...v.counts, lastActivityAt: iso(v.counts.lastActivityAt) },
  };
}

function ownerStatus(status: string, invitedAt: Date | null): PlatformOwnerStatus {
  if (status === 'INVITED' && (invitedAt?.getTime() ?? 0) + INVITE_MS <= Date.now()) {
    return 'EXPIRED';
  }
  return status as PlatformOwnerStatus;
}

const iso = (value: string | null): string | null => (value ? new Date(value).toISOString() : null);
const isoDate = (d: Date): IsoDate => d.toISOString().slice(0, 10) as IsoDate;

/** January to December of today's year (named after it). */
function calendarYear(today: IsoDate) {
  const y = today.slice(0, 4);
  return { name: y, startDate: `${y}-01-01` as IsoDate, endDate: `${y}-12-31` as IsoDate };
}

/** Errors the platform functions raise, as API errors. */
function platformDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/PLATFORM_NOT_FOUND/.test(message)) throw new NotFoundException('Institute not found');
  if (/PLATFORM_BAD_STATUS/.test(message)) {
    throw apiError(409, 'BAD_STATUS', 'Not possible in the institute’s current status');
  }
  if (/PLATFORM_REASON_REQUIRED/.test(message)) {
    throw apiError(422, 'REASON_REQUIRED', 'A reason is required', { field: 'reason' });
  }
  if (/PLATFORM_CORE_REQUIRED/.test(message)) {
    throw apiError(422, 'CORE_REQUIRED', 'The core module is always on');
  }
  if (/PLATFORM_ALREADY_REGISTERED/.test(message)) {
    throw apiError(409, 'ALREADY_REGISTERED', 'The institute already has a plan');
  }
  throw error;
}

const parseModule = (value: string): PlatformModule => {
  if (!(PLATFORM_MODULES as readonly string[]).includes(value)) {
    throw new BadRequestException('Unknown module');
  }
  return value as PlatformModule;
};

const ipOf = (req: Request) => req.ip ?? 'unknown';

@Controller('platform/institutes')
@PlatformRoute()
export class PlatformInstitutesController {
  constructor(private readonly institutes: PlatformInstitutesService) {}

  @Get()
  list(@Query() q: InstituteListQueryDto): Promise<PlatformInstitutePage> {
    return this.institutes.list(q);
  }

  @Get('options')
  options(): Promise<PlatformInstituteOptions> {
    return this.institutes.options();
  }

  @Post()
  @PlatformTxTimeout(60_000)
  create(@Body() dto: CreateInstituteDto, @Req() req: Request) {
    return this.institutes.create(dto, ipOf(req));
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformInstituteDetail> {
    return this.institutes.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StatusChangeDto,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.setStatus(id, 'SUSPEND', dto.reason, ipOf(req));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StatusChangeDto,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.setStatus(id, 'REACTIVATE', dto.reason, ipOf(req));
  }

  @Put(':id/modules/:module')
  setModule(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('module') module: string,
    @Body() dto: ModuleDto,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.setModule(id, parseModule(module), dto.enabled, ipOf(req));
  }

  @Put(':id/limits')
  setLimits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LimitsDto,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.setLimits(id, dto, ipOf(req));
  }

  @Post(':id/owner-invitations')
  @HttpCode(200)
  inviteOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OwnerDto,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.inviteOwner(id, dto, ipOf(req));
  }

  @Post(':id/owner-invitations/:userId/resend')
  @HttpCode(200)
  resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.resendOwnerInvitation(id, userId, ipOf(req));
  }

  @Post(':id/owner-invitations/:userId/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ): Promise<PlatformInstituteDetail> {
    return this.institutes.cancelOwnerInvitation(id, userId, ipOf(req));
  }
}
