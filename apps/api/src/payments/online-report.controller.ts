import { Controller, Get, Query, Res } from '@nestjs/common';
import { onlinePaymentsReportQuerySchema, type OnlinePaymentsReport } from '@jantrik/shared';
import type { Response } from 'express';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { sendCsv } from '../fees/fees.module.js';
import { OnlinePaymentsReportService } from './online-report.service.js';

class OnlinePaymentsReportQueryDto extends zodDto(onlinePaymentsReportQuerySchema) {}

/** The online payments report and its CSV (sprint 1 P7b; OWNER, ADMIN, ACCOUNTANT). */
@Controller('fees/reports/online-payments')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class OnlinePaymentsReportController {
  constructor(private readonly reports: OnlinePaymentsReportService) {}

  @Get()
  report(@Query() q: OnlinePaymentsReportQueryDto): Promise<OnlinePaymentsReport> {
    return this.reports.report(q);
  }

  @Get('csv')
  async csv(
    @Query() q: OnlinePaymentsReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    return sendCsv(res, await this.reports.csv(q));
  }
}
