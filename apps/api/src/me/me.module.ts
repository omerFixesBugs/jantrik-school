import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  acceptInvitationSchema,
  INVITATION_DAYS,
  preferencesSchema,
  dateToDb,
  todayIn,
  type BillingNotice,
  type GuardianChild,
  type IsoDate,
  type MeContext,
  type StaffInvitation,
  type ColorScheme,
} from '@jantrik/shared';
import { appearanceOf } from '../appearance/appearance.module.js';
import { listMemberships } from '../auth/login-lookup.js';
import { CurrentUser, RequireModule, Roles, UserScoped } from '../common/decorators.js';
import type { Principal } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

export class PreferencesDto extends zodDto(preferencesSchema) {}
export class AcceptInvitationDto extends zodDto(acceptInvitationSchema) {}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class MeService {
  constructor(
    private readonly db: Db,
    private readonly access: TenantAccessService,
  ) {}

  /**
   * Jantrik's invoices to this institute that are past their due date (OWNER only; the dashboard
   * shows a gentle notice). The institute's own rows, under RLS.
   */
  async billingNotice(): Promise<BillingNotice> {
    const tx = this.db.tx;
    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const overdue = await tx.platformInvoice.findMany({
      where: { status: 'ISSUED', dueOn: { lt: dateToDb(todayIn(tenant.timezone)) } },
      orderBy: { dueOn: 'asc' },
      select: { totalPaisa: true, paidPaisa: true, dueOn: true },
    });
    if (overdue.length === 0) return { overdue: null };
    return {
      overdue: {
        count: overdue.length,
        duePaisa: overdue.reduce((sum, i) => sum + i.totalPaisa - i.paidPaisa, 0),
        oldestDueOn: isoDate(overdue[0]!.dueOn) as IsoDate,
      },
    };
  }

  /** Everything the web shell needs for the selected tenant, in one call. */
  async context(principal: Principal): Promise<MeContext> {
    const tenantId = principal.tenantId;
    if (!tenantId)
      throw new ForbiddenException({
        statusCode: 403,
        code: 'NO_TENANT',
        message: 'Select an institute first',
      });

    const tx = this.db.tx;
    const [tenant, labels, year, modules, roles, appearance] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { instituteType: true } }),
      tx.tenantLabel.findMany(),
      tx.academicYear.findFirst({ where: { isCurrent: true } }),
      this.access.getEnabledModules(tenantId),
      this.access.getRoles(tenantId, principal.userId),
      tx.appearanceSettings.findFirst({ select: { preset: true, accent: true } }),
    ]);

    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        defaultLocale: tenant.defaultLocale,
        instituteType: {
          key: tenant.instituteType.key,
          nameBn: tenant.instituteType.nameBn,
          nameEn: tenant.instituteType.nameEn,
        },
      },
      labels: Object.fromEntries(labels.map((l) => [l.key, { bn: l.valueBn, en: l.valueEn }])),
      modules,
      roles,
      academicYear: year
        ? {
            id: year.id,
            name: year.name,
            startDate: isoDate(year.startDate),
            endDate: isoDate(year.endDate),
          }
        : null,
      today: todayIn(tenant.timezone),
      appearance: appearanceOf(tenant.instituteType.defaultTheme, appearance),
    };
  }

  /**
   * The caller's own children: students linked to a guardian record whose user is the caller.
   * RLS limits every table here to the selected tenant; the `guardian.userId` filter limits it
   * to this person. Soft-deleted students are left out.
   */
  async children(principal: Principal): Promise<GuardianChild[]> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const links = await tx.studentGuardian.findMany({
      where: { guardian: { userId: principal.userId }, student: { deletedAt: null } },
      orderBy: [{ student: { studentCode: 'asc' } }],
      select: {
        relation: true,
        student: {
          select: {
            id: true,
            studentCode: true,
            nameBn: true,
            nameEn: true,
            photoUrl: true,
            status: true,
            enrolments: {
              where: { academicYearId: year?.id ?? '00000000-0000-0000-0000-000000000000' },
              take: 1,
              select: {
                roll: true,
                classLevel: { select: { id: true, nameBn: true, nameEn: true } },
                section: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    // A person can be linked twice to one child (two guardian records); show the child once.
    const seen = new Set<string>();
    return links.flatMap(({ relation, student: { enrolments, ...s } }) => {
      if (seen.has(s.id)) return [];
      seen.add(s.id);
      return [{ ...s, relation, enrolment: enrolments[0] ?? null }];
    });
  }

  /** The caller's pending (not expired) staff invitations, from the membership definer function. */
  async invitations(): Promise<StaffInvitation[]> {
    const memberships = await listMemberships(this.db.tx);
    return memberships.flatMap((m) =>
      m.invitation
        ? [
            {
              tenant: { id: m.tenant.id, name: m.tenant.name },
              roles: m.invitation.roles,
              expiresAt: m.invitation.expiresAt,
              invitedAt: new Date(
                new Date(m.invitation.expiresAt).getTime() - INVITATION_DAYS * 24 * 3600 * 1000,
              ).toISOString(),
            },
          ]
        : [],
    );
  }

  async respond(
    principal: Principal,
    tenantId: string,
    accept: boolean,
    shownRoles: readonly string[] = [],
  ): Promise<void> {
    await this.access.respondToInvitation(
      principal.userId,
      tenantId,
      accept,
      INVITATION_DAYS * 24 * 3600 * 1000,
      shownRoles,
    );
  }

  /** The language and the light/dark choice. RLS lets a user update only their own row. */
  async setPreferences(
    principal: Principal,
    prefs: { locale?: 'bn' | 'en'; colorScheme?: ColorScheme },
  ): Promise<void> {
    await this.db.tx.user.update({
      where: { id: principal.userId },
      data: {
        ...(prefs.locale ? { locale: prefs.locale } : {}),
        ...(prefs.colorScheme ? { colorScheme: prefs.colorScheme } : {}),
      },
    });
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('context')
  context(@CurrentUser() principal: Principal): Promise<MeContext> {
    return this.me.context(principal);
  }

  @Get('billing-notice')
  @RequireModule('CORE')
  @Roles('OWNER')
  billingNotice(): Promise<BillingNotice> {
    return this.me.billingNotice();
  }

  @Get('children')
  @RequireModule('CORE')
  @Roles('GUARDIAN')
  children(@CurrentUser() principal: Principal): Promise<GuardianChild[]> {
    return this.me.children(principal);
  }

  /** Pending staff invitations (no institute needs to be selected). */
  @Get('invitations')
  @UserScoped()
  invitations(): Promise<StaffInvitation[]> {
    return this.me.invitations();
  }

  /** Access to that institute starts here (the invited memberships become ACTIVE). */
  @Post('invitations/:tenantId/accept')
  @UserScoped()
  @HttpCode(204)
  async accept(
    @CurrentUser() principal: Principal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: AcceptInvitationDto,
  ): Promise<void> {
    await this.me.respond(principal, tenantId, true, body.roles);
  }

  @Post('invitations/:tenantId/decline')
  @UserScoped()
  @HttpCode(204)
  async decline(
    @CurrentUser() principal: Principal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<void> {
    await this.me.respond(principal, tenantId, false);
  }

  @Patch('preferences')
  @UserScoped()
  @HttpCode(204)
  async preferences(
    @CurrentUser() principal: Principal,
    @Body() dto: PreferencesDto,
  ): Promise<void> {
    await this.me.setPreferences(principal, dto);
  }
}

@Module({ controllers: [MeController], providers: [MeService] })
export class MeModule {}
