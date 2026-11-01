import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  staffDayEntrySchema,
  staffDayParamsSchema,
  staffDayQuerySchema,
  staffMonthCsvQuerySchema,
  staffMonthQuerySchema,
  staffTrackedSchema,
  type StaffDayRecord,
  type StaffDayReport,
  type StaffMonthReport,
  type StaffTrackedResult,
} from '@jantrik/shared';
import type { Response } from 'express';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { DevicesModule } from '../devices/devices.module.js';
import { StaffAttendanceMonthService } from './staff-attendance-month.service.js';
import { StaffAttendanceService } from './staff-attendance.service.js';

export class StaffDayQueryDto extends zodDto(staffDayQuerySchema) {}
export class StaffDayParamsDto extends zodDto(staffDayParamsSchema) {}
export class StaffDayEntryDto extends zodDto(staffDayEntrySchema) {}
export class StaffTrackedDto extends zodDto(staffTrackedSchema) {}
export class StaffMonthQueryDto extends zodDto(staffMonthQuerySchema) {}
export class StaffMonthCsvQueryDto extends zodDto(staffMonthCsvQuerySchema) {}

/** Staff attendance: OWNER/ADMIN, module ATTENDANCE. */
@Controller('staff-attendance')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN')
export class StaffAttendanceController {
  constructor(
    private readonly staff: StaffAttendanceService,
    private readonly months: StaffAttendanceMonthService,
  ) {}

  /** Everyone's day (default today; never a future date). */
  @Get('day')
  day(@Query() query: StaffDayQueryDto): Promise<StaffDayReport> {
    return this.staff.day(query.date);
  }

  @Get('month')
  month(@Query() query: StaffMonthQueryDto): Promise<StaffMonthReport> {
    return this.months.month(query.month);
  }

  /** The month as CSV (`grid` or `days`): UTF-8 with a BOM, ASCII digits. */
  @Get('month/csv')
  async monthCsv(
    @Query() query: StaffMonthCsvQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.months.csv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  // Before `:userId/:date`, which would take "tracked" for a date.
  @Put(':userId/tracked')
  setTracked(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: StaffTrackedDto,
  ): Promise<StaffTrackedResult> {
    return this.staff.setTracked(userId, dto.tracked);
  }

  /** Set one person's day by hand (MANUAL; punches never change it), with a reason. */
  @Put(':userId/:date')
  enter(
    @Param() params: StaffDayParamsDto,
    @Body() dto: StaffDayEntryDto,
  ): Promise<StaffDayRecord> {
    return this.staff.enter(params.userId, params.date, dto);
  }
}

@Module({
  // AttendanceModule: settings, office hours and working days. DevicesModule: the punch lock
  // (DeviceAttendanceService) and active staff roles (DevicePeopleRoster).
  imports: [AttendanceModule, DevicesModule],
  controllers: [StaffAttendanceController],
  providers: [StaffAttendanceService, StaffAttendanceMonthService],
})
export class StaffAttendanceModule {}
