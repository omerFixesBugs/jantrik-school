import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { RequireModule, Roles } from '../../src/common/decorators.js';
import { AttendanceService, type SubmitInput } from '../../src/attendance/attendance.service.js';
import { SmsService } from '../../src/sms/sms.service.js';
import { Db } from '../../src/tenancy/db.service.js';

/** Test-only routes exercising the request pipeline. Mounted only in e2e tests. */
@Controller('test')
export class TestController {
  constructor(
    private readonly db: Db,
    private readonly sms: SmsService,
    private readonly attendanceService: AttendanceService,
  ) {}

  @Get('students')
  async students(): Promise<{ id: string; tenantId: string; studentCode: string }[]> {
    return this.db.tx.student.findMany({ select: { id: true, tenantId: true, studentCode: true } });
  }

  @Get('students/:id')
  async student(@Param('id') id: string) {
    const student = await this.db.tx.student.findUnique({ where: { id } });
    if (!student) throw new NotFoundException();
    return student;
  }

  @Roles('ADMIN', 'OWNER')
  @Get('admin-only')
  adminOnly() {
    return { ok: true };
  }

  @RequireModule('ATTENDANCE')
  @Get('attendance')
  attendance() {
    return { ok: true };
  }

  /** Queues an SMS and then fails: the SMS must never be sent. */
  @Post('sms-then-fail')
  async smsThenFail(@Body() body: { phone: string }) {
    await this.sms.send(body.phone, 'must never arrive');
    throw new BadRequestException('handler failed after queueing an SMS');
  }

  /** Submits attendance (queueing absent SMS) and then fails: nothing may be saved or sent. */
  @Post('attendance-then-fail')
  async attendanceThenFail(@Body() body: SubmitInput) {
    await this.attendanceService.submit(body);
    throw new BadRequestException('handler failed after submitting attendance');
  }

  @Post('sms-ok')
  async smsOk(@Body() body: { phone: string }) {
    await this.sms.send(body.phone, 'arrives after commit');
    return { ok: true };
  }
}
