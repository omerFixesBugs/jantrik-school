import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  attendanceSettingsSchema,
  attendanceSheetQuerySchema,
  holidaySchema,
  mySectionsQuerySchema,
  sectionTeachersSchema,
  submitAttendanceSchema,
  type AttendanceSettings,
  type AttendanceSheet,
  type Holiday,
  type MySectionsResponse,
  type SectionTeacherEntry,
  type SmsDailyStatus,
  type SubmitAttendanceResponse,
} from '@jantrik/shared';
import { z } from 'zod';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { AttendanceAdminService } from './attendance-admin.service.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';
import { AttendanceService } from './attendance.service.js';

export class SubmitAttendanceDto extends zodDto(submitAttendanceSchema) {}
export class AttendanceSheetQueryDto extends zodDto(attendanceSheetQuerySchema) {}
export class MySectionsQueryDto extends zodDto(mySectionsQuerySchema) {}
export class AttendanceSettingsDto extends zodDto(attendanceSettingsSchema) {}
export class HolidayDto extends zodDto(holidaySchema) {}
export class SectionTeachersDto extends zodDto(sectionTeachersSchema) {}
export class HolidayQueryDto extends zodDto(
  z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
) {}

/** Taking attendance: teachers (their sections) and admins (all). */
@Controller('attendance')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN', 'TEACHER')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly settings: AttendanceSettingsService,
    private readonly admin: AttendanceAdminService,
  ) {}

  @Get('my-sections')
  mySections(@Query() query: MySectionsQueryDto): Promise<MySectionsResponse> {
    return this.attendance.mySections(query.date);
  }

  @Get('sessions')
  sheet(@Query() query: AttendanceSheetQueryDto): Promise<AttendanceSheet> {
    return this.attendance.sheet(query);
  }

  /** Create or replace one register. Idempotent per submissionId (safe to retry). */
  @Put('sessions')
  submit(@Body() dto: SubmitAttendanceDto): Promise<SubmitAttendanceResponse> {
    return this.attendance.submit(dto);
  }

  @Get('holidays')
  holidays(@Query() query: HolidayQueryDto): Promise<Holiday[]> {
    return this.admin.listHolidays(query.year);
  }

  @Get('settings')
  getSettings(): Promise<AttendanceSettings> {
    return this.settings.get();
  }
}

/** Configuration (OWNER/ADMIN). */
@Controller('attendance')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN')
export class AttendanceAdminController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly settings: AttendanceSettingsService,
    private readonly admin: AttendanceAdminService,
  ) {}

  @Put('settings')
  updateSettings(@Body() dto: AttendanceSettingsDto): Promise<AttendanceSettings> {
    return this.settings.update(dto);
  }

  @Post('holidays')
  createHoliday(@Body() dto: HolidayDto): Promise<Holiday> {
    return this.admin.createHoliday(dto);
  }

  @Put('holidays/:id')
  updateHoliday(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HolidayDto): Promise<Holiday> {
    return this.admin.updateHoliday(id, dto);
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  async deleteHoliday(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.admin.deleteHoliday(id);
  }

  @Get('sections/:id/teachers')
  sectionTeachers(@Param('id', ParseUUIDPipe) id: string): Promise<SectionTeacherEntry[]> {
    return this.admin.sectionTeachers(id);
  }

  @Put('sections/:id/teachers')
  setSectionTeachers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SectionTeachersDto,
  ): Promise<SectionTeacherEntry[]> {
    return this.admin.setSectionTeachers(id, dto.teachers);
  }

  /** For the dashboard warning when SMS were held back by the daily cap. */
  @Get('sms/today')
  smsToday(): Promise<SmsDailyStatus> {
    return this.attendance.smsToday();
  }
}

@Module({
  controllers: [AttendanceController, AttendanceAdminController],
  providers: [AttendanceService, AttendanceSettingsService, AttendanceAdminService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
