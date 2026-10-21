import { Body, Controller, Injectable, Module, Put } from '@nestjs/common';
import {
  appearanceSchema,
  fitAccent,
  type Appearance,
  type AppearanceInput,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';

class AppearanceDto extends zodDto(appearanceSchema) {}

/**
 * The institute's theme (docs/design.md → Themes): a preset and an optional accent, one row per
 * tenant (appearance_settings, created on the first save). Everyone reads it through
 * GET /me/context; only the owner changes it.
 */
@Injectable()
export class AppearanceService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<Appearance> {
    const tx = this.db.tx;
    const [tenant, row] = await Promise.all([
      tx.tenant.findFirstOrThrow({
        where: { id: this.context.requirePrincipal().tenantId! },
        select: { instituteType: { select: { defaultTheme: true } } },
      }),
      tx.appearanceSettings.findFirst({ select: { preset: true, accent: true } }),
    ]);
    return appearanceOf(tenant.instituteType.defaultTheme, row);
  }

  async update(input: AppearanceInput): Promise<Appearance> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    const before = await this.get();
    const stored = await tx.appearanceSettings.findFirst({
      select: { preset: true, accent: true },
    });
    const preset = input.preset ?? before.typeDefault;
    // The owner's colour must read in light and dark for this preset (the same check the web
    // shows live); a colour that cannot is refused, never stored.
    if (input.accent && !fitAccent(input.accent, preset).ok) {
      throw apiError(
        422,
        'ACCENT_CONTRAST',
        'This colour cannot keep text readable in both light and dark; choose another',
      );
    }
    const old = { preset: stored?.preset ?? null, accent: stored?.accent ?? null };
    if (old.preset === input.preset && old.accent === input.accent) return before;
    const row = await tx.appearanceSettings.upsert({
      where: { tenantId },
      create: { tenantId, preset: input.preset, accent: input.accent },
      update: { preset: input.preset, accent: input.accent },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'appearance_settings',
      entityId: row.id,
      action: stored ? 'UPDATE' : 'CREATE',
      oldValues: old,
      newValues: input,
    });
    return this.get();
  }
}

/** The preset in force: the owner's choice, else the institute type's default. */
export function appearanceOf(
  typeDefault: Appearance['typeDefault'],
  row: { preset: Appearance['preset'] | null; accent: string | null } | null,
): Appearance {
  return {
    preset: row?.preset ?? typeDefault,
    accent: row?.accent ?? null,
    typeDefault,
    chosen: row !== null && (row.preset !== null || row.accent !== null),
  };
}

@Controller('settings')
@RequireModule('CORE')
export class AppearanceController {
  constructor(private readonly appearance: AppearanceService) {}

  @Put('appearance')
  @Roles('OWNER')
  update(@Body() dto: AppearanceDto): Promise<Appearance> {
    return this.appearance.update(dto);
  }
}

@Module({ controllers: [AppearanceController], providers: [AppearanceService] })
export class AppearanceModule {}
