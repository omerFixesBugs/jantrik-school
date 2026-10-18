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
  Res,
} from '@nestjs/common';
import {
  attendanceSettingsSchema,
  childAttendanceQuerySchema,
  registerQuerySchema,
  studentReportQuerySchema,
  attendanceSheetQuerySchema,
  holidaySchema,
  mySectionsQuerySchema,
  sectionTeachersSchema,
  submitAttendanceSchema,
  type AttendanceRegisterReport,
  type AttendanceSettings,
  type AttendanceStaffMember,
  type AttendanceTodayReport,
  type ChildAttendanceMonth,
  type SendHeldSmsResult,
  type StudentAttendanceReport,
  type AttendanceSheet,
  type AttendanceTodaySummary,
  type Holiday,
  type MySectionsResponse,
  type SectionTeacherEntry,
  type SmsDailyStatus,
  type SubmitAttendanceResponse,
} from '@jantrik/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { AttendanceAdminService } from './attendance-admin.service.js';
import { AttendanceReportsService } from './attendance-reports.service.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';
import { AttendanceService } from './attendance.service.js';

export class SubmitAttendanceDto extends zodDto(submitAttendanceSchema) {}
export class AttendanceSheetQueryDto extends zodDto(attendanceSheetQuerySchema) {}
export class MySectionsQueryDto extends zodDto(mySectionsQuerySchema) {}
export class AttendanceSettingsDto extends zodDto(attendanceSettingsSchema) {}
export class HolidayDto extends zodDto(holidaySchema) {}
export class SectionTeachersDto extends zodDto(sectionTeachersSchema) {}
export class RegisterQueryDto extends zodDto(registerQuerySchema) {}
export class StudentReportQueryDto extends zodDto(studentReportQuerySchema) {}
export class ChildAttendanceQueryDto extends zodDto(childAttendanceQuerySchema) {}
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
    private readonly reports: AttendanceReportsService,
  ) {}

  @Get('my-sections')
  mySections(@Query() query: MySectionsQueryDto): Promise<MySectionsResponse> {
    return this.attendance.mySections(query.date);
  }

  /** Dashboard "present today": the caller's sections (teacher) or all (admin). */
  @Get('summary/today')
  todaySummary(): Promise<AttendanceTodaySummary> {
    return this.attendance.todaySummary();
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

  /** Every section's roll call today (teachers: their sections). */
  @Get('reports/today')
  todayReport(): Promise<AttendanceTodayReport> {
    return this.reports.today();
  }

  /** The month register for one section (students × days). */
  @Get('reports/register')
  register(@Query() query: RegisterQueryDto): Promise<AttendanceRegisterReport> {
    return this.reports.register(query);
  }

  /** The same as CSV: UTF-8 with a BOM, ASCII digits. */
  @Get('reports/register/csv')
  async registerCsv(
    @Query() query: RegisterQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.reports.registerCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  /** One student's present % over a date range (at most a year). */
  @Get('reports/students/:id')
  studentReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StudentReportQueryDto,
  ): Promise<StudentAttendanceReport> {
    return this.reports.student(id, query.from, query.to);
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
    private readonly reports: AttendanceReportsService,
  ) {}

  /** Staff who can be given a section (settings: section teachers). */
  @Get('staff')
  staff(): Promise<AttendanceStaffMember[]> {
    return this.reports.staff();
  }

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

  /** Send today's SMS held back by the daily cap; each is re-checked (still absent?) first. */
  @Post('sms/held/send')
  @HttpCode(200)
  sendHeld(): Promise<SendHeldSmsResult> {
    return this.reports.sendHeld();
  }
}

/** A guardian's own child's attendance month (the dashboard calendar). */
@Controller('me/children')
@RequireModule('ATTENDANCE')
@Roles('GUARDIAN')
export class ChildAttendanceController {
  constructor(private readonly reports: AttendanceReportsService) {}

  @Get(':id/attendance')
  month(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ChildAttendanceQueryDto,
  ): Promise<ChildAttendanceMonth> {
    return this.reports.childMonth(id, query.month);
  }
}

@Module({
  controllers: [AttendanceController, AttendanceAdminController, ChildAttendanceController],
  providers: [
    AttendanceService,
    AttendanceSettingsService,
    AttendanceAdminService,
    AttendanceReportsService,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
