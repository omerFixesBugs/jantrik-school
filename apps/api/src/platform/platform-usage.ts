import {
  Body,
  Controller,
  Get,
  Injectable,
  InternalServerErrorException,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  platformSettingsSchema,
  platformUsageQuerySchema,
  todayIn,
  type PlatformSettings,
  type PlatformSmsTotals,
  type PlatformUsage,
  type PlatformUsageInstitute,
} from '@jantrik/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { PlatformRoute } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { PlatformDb, platformDbError } from './platform-db.js';

class UsageQueryDto extends zodDto(platformUsageQuerySchema) {}
class SettingsDto extends zodDto(platformSettingsSchema) {}

interface RawUsage {
  month: string;
  institutes: PlatformUsage['institutes'];
  activeStudents: number;
  institutesSms: PlatformSmsTotals;
  loginSms: PlatformSmsTotals;
  smsCostPerSegmentPaisa: number;
}

interface UsageRow {
  id: string;
  name: string;
  slug: string;
  status: PlatformUsageInstitute['status'];
  active_students: bigint;
  sms_sent: bigint;
  sms_segments: bigint;
  sms_cost_paisa: bigint;
  imports: bigint;
  last_activity_at: Date | null;
  total: bigint;
}

/**
 * What the platform costs to run (part 4): SMS sent by institutes and as login codes, at the
 * rate each was sent at, per month and per institute. Counts and costs only, never an SMS text or
 * a phone number. The rate itself is a platform setting (audited).
 */
@Injectable()
export class PlatformUsageService {
  constructor(private readonly db: PlatformDb) {}

  async usage(q: z.output<typeof platformUsageQuerySchema>): Promise<PlatformUsage> {
    const month = q.month ?? todayIn('Asia/Dhaka').slice(0, 7);
    const day = `${month}-01`;
    const [summary] = await this.db.tx.$queryRaw<{ v: RawUsage }[]>`
      SELECT platform_usage(${day}::date) AS v`;
    const query = (offset: number, limit: number) => this.db.tx.$queryRaw<UsageRow[]>`
      SELECT * FROM platform_usage_institutes(${day}::date, ${offset}::int, ${limit}::int)`;
    const rows = await query((q.page - 1) * q.pageSize, q.pageSize);
    const total = rows[0]?.total ?? (q.page > 1 ? ((await query(0, 1))[0]?.total ?? 0n) : 0n);
    const s = summary!.v;
    return {
      month,
      institutes: s.institutes,
      activeStudents: s.activeStudents,
      institutesSms: s.institutesSms,
      loginSms: s.loginSms,
      totalCostPaisa: s.institutesSms.costPaisa + s.loginSms.costPaisa,
      smsCostPerSegmentPaisa: s.smsCostPerSegmentPaisa,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        activeStudents: Number(r.active_students),
        smsSent: Number(r.sms_sent),
        smsSegments: Number(r.sms_segments),
        smsCostPaisa: Number(r.sms_cost_paisa),
        importsThisMonth: Number(r.imports),
        lastActivityAt: r.last_activity_at?.toISOString() ?? null,
      })),
      total: Number(total),
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async settings(): Promise<PlatformSettings> {
    const [row] = await this.db.tx.$queryRaw<
      { v: { smsCostPerSegmentPaisa: number; updatedAt: string; updatedBy: string | null } }[]
    >`SELECT platform_get_settings() AS v`;
    const v = row?.v;
    if (!v) throw new InternalServerErrorException('The platform settings row is missing');
    return { ...v, updatedAt: new Date(v.updatedAt).toISOString() };
  }

  async setSmsCost(paisa: number, ip: string): Promise<PlatformSettings> {
    await this.db.tx.$executeRaw`SELECT platform_set_sms_cost(${paisa}::int, ${ip})`.catch(
      platformDbError,
    );
    return this.settings();
  }
}

@Controller('platform')
@PlatformRoute()
export class PlatformUsageController {
  constructor(private readonly usage: PlatformUsageService) {}

  @Get('usage')
  get(@Query() q: UsageQueryDto): Promise<PlatformUsage> {
    return this.usage.usage(q);
  }

  @Get('settings')
  settings(): Promise<PlatformSettings> {
    return this.usage.settings();
  }

  @Put('settings')
  setSettings(@Body() dto: SettingsDto, @Req() req: Request): Promise<PlatformSettings> {
    return this.usage.setSmsCost(dto.smsCostPerSegmentPaisa, req.ip ?? 'unknown');
  }
}
