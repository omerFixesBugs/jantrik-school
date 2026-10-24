import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createDeviceSchema,
  deviceCommandsQuerySchema,
  punchFeedQuerySchema,
  reviewPunchSchema,
  updateDeviceSchema,
  type DeviceAddress,
  type DeviceAlert,
  type DeviceCommandView,
  type DeviceList,
  type DeviceSyncResult,
  type DeviceView,
  type FeedPunch,
  type PunchFeed,
  type TrustAddressResult,
  type UnknownDeviceId,
} from '@jantrik/shared';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { DeviceAlertsService } from './device-alerts.service.js';
import { DevicePunchesService } from './device-punches.service.js';
import { DevicesService } from './devices.service.js';
import { PunchReviewEffects } from './punch-review-effects.js';

export class CreateDeviceDto extends zodDto(createDeviceSchema) {}
export class UpdateDeviceDto extends zodDto(updateDeviceSchema) {}
export class DeviceCommandsQueryDto extends zodDto(deviceCommandsQuerySchema) {}
export class PunchFeedQueryDto extends zodDto(punchFeedQuerySchema) {}
export class ReviewPunchDto extends zodDto(reviewPunchSchema) {}

/** Attendance devices: OWNER/ADMIN, module ATTENDANCE. */
@Controller('attendance/devices')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly punches: DevicePunchesService,
    private readonly alertsService: DeviceAlertsService,
  ) {}

  /** Every device with its state, and the server and port the setup guide shows. */
  @Get()
  list(): Promise<DeviceList> {
    return this.devices.list();
  }

  @Post()
  create(@Body() dto: CreateDeviceDto): Promise<DeviceView> {
    return this.devices.create(dto);
  }

  /** The live feed, newest first; `after` for the poll, `flagged=1` for the review list. */
  @Get('punches')
  feed(@Query() query: PunchFeedQueryDto): Promise<PunchFeed> {
    return this.punches.feed(query);
  }

  @Post('punches/:id/review')
  @HttpCode(200)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewPunchDto): Promise<FeedPunch> {
    return this.punches.review(id, dto.action);
  }

  @Get('unknown-ids')
  unknownIds(): Promise<UnknownDeviceId[]> {
    return this.punches.unknownIds();
  }

  @Get('alerts')
  alerts(): Promise<DeviceAlert[]> {
    return this.alertsService.alerts();
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeviceDto,
  ): Promise<DeviceView> {
    return this.devices.update(id, dto);
  }

  /** Send every active person's ID and name to the device. */
  @Post(':id/sync')
  @HttpCode(200)
  sync(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceSyncResult> {
    return this.devices.sync(id);
  }

  @Get(':id/commands')
  commands(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeviceCommandsQueryDto,
  ): Promise<DeviceCommandView[]> {
    return this.devices.commands(id, query.status);
  }

  @Get(':id/ips')
  addresses(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceAddress[]> {
    return this.devices.addresses(id);
  }

  @Post(':id/ips/:ipId/trust')
  @HttpCode(200)
  trust(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ipId', ParseUUIDPipe) ipId: string,
  ): Promise<TrustAddressResult> {
    return this.devices.trust(id, ipId);
  }

  @Post(':id/ips/:ipId/revoke')
  @HttpCode(200)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ipId', ParseUUIDPipe) ipId: string,
  ): Promise<DeviceAddress> {
    return this.devices.revoke(id, ipId);
  }
}

@Module({
  // AttendanceSettingsService: the timezone, the device settings and working days.
  imports: [AttendanceModule],
  controllers: [DevicesController],
  providers: [DevicesService, DevicePunchesService, DeviceAlertsService, PunchReviewEffects],
})
export class DevicesModule {}
