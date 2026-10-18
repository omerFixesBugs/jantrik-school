import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  Patch,
} from '@nestjs/common';
import { preferencesSchema, todayIn, type GuardianChild, type MeContext } from '@jantrik/shared';
import { CurrentUser, RequireModule, Roles, UserScoped } from '../common/decorators.js';
import type { Principal } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

export class PreferencesDto extends zodDto(preferencesSchema) {}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class MeService {
  constructor(
    private readonly db: Db,
    private readonly access: TenantAccessService,
  ) {}

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
    const [tenant, labels, year, modules, roles] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { instituteType: true } }),
      tx.tenantLabel.findMany(),
      tx.academicYear.findFirst({ where: { isCurrent: true } }),
      this.access.getEnabledModules(tenantId),
      this.access.getRoles(tenantId, principal.userId),
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

  /** RLS lets a user update only their own row. */
  async setLocale(principal: Principal, locale: 'bn' | 'en'): Promise<void> {
    await this.db.tx.user.update({ where: { id: principal.userId }, data: { locale } });
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('context')
  context(@CurrentUser() principal: Principal): Promise<MeContext> {
    return this.me.context(principal);
  }

  @Get('children')
  @RequireModule('CORE')
  @Roles('GUARDIAN')
  children(@CurrentUser() principal: Principal): Promise<GuardianChild[]> {
    return this.me.children(principal);
  }

  @Patch('preferences')
  @UserScoped()
  @HttpCode(204)
  async preferences(
    @CurrentUser() principal: Principal,
    @Body() dto: PreferencesDto,
  ): Promise<void> {
    await this.me.setLocale(principal, dto.locale);
  }
}

@Module({ controllers: [MeController], providers: [MeService] })
export class MeModule {}
