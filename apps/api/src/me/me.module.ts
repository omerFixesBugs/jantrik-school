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
import { preferencesSchema, type MeContext } from '@jantrik/shared';
import { CurrentUser, UserScoped } from '../common/decorators.js';
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
    };
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
