import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AudienceService } from './audience.service.js';
import { BroadcastsController } from './broadcasts.controller.js';
import { BroadcastsService, NOTICES_QUEUE } from './broadcasts.service.js';
import { NoticesController } from './notices.controller.js';
import { NoticesProcessor } from './notices.processor.js';
import { NoticesService } from './notices.service.js';

/** Notices, the board and SMS broadcasts (sprint 1 P6, docs/notices.md). */
@Module({
  // AttendanceModule: the shared daily SMS cap (AttendanceSettingsService.smsDailyCap).
  imports: [BullModule.registerQueue({ name: NOTICES_QUEUE }), AttendanceModule],
  controllers: [NoticesController, BroadcastsController],
  providers: [NoticesService, BroadcastsService, AudienceService, NoticesProcessor],
  exports: [NoticesService, BroadcastsService, NoticesProcessor],
})
export class NoticesModule {}
