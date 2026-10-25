import { BullModule } from '@nestjs/bullmq';
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
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  DEVICE_IMPORT_MAX_BYTES,
  createDeviceSchema,
  deviceCommandsQuerySchema,
  deviceDefaultsSchema,
  deviceImportQuerySchema,
  devicePeopleCsvQuerySchema,
  devicePeopleQuerySchema,
  punchFeedQuerySchema,
  removeFromDevicesSchema,
  reviewPunchSchema,
  setDeviceUserIdSchema,
  staffRangeCheckQuerySchema,
  updateDeviceSchema,
  type CloseFromDeviceResult,
  type DeviceAddress,
  type DeviceAlert,
  type DeviceCommandView,
  type DeviceDefaultsResult,
  type DeviceIdCollisionView,
  type DeviceImportResult,
  type DeviceList,
  type DevicePeopleList,
  type DeviceSyncResult,
  type DeviceView,
  type FeedPunch,
  type PunchFeed,
  type RemoveFromDevicesResult,
  type SetDeviceIdResult,
  type StaffRangeCheck,
  type StaleDevicePerson,
  type TrustAddressResult,
  type UnknownDeviceId,
} from '@jantrik/shared';
import type { Response } from 'express';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { DeviceAlertsService } from './device-alerts.service.js';
import { DeviceAttendanceService } from './device-attendance.service.js';
import { DevicePeopleCsvService } from './device-people-csv.service.js';
import { DevicePeopleRoster } from './device-people-roster.js';
import { DevicePeopleService } from './device-people.service.js';
import { DevicePunchesService } from './device-punches.service.js';
import { DeviceRegistersService } from './device-registers.service.js';
import { DEVICES_QUEUE } from './devices.constants.js';
import { DevicesProcessor } from './devices.processor.js';
import { DevicesService } from './devices.service.js';
import { PunchProcessingService } from './punch-processing.service.js';
import { PunchReviewEffects } from './punch-review-effects.js';

export class CreateDeviceDto extends zodDto(createDeviceSchema) {}
export class UpdateDeviceDto extends zodDto(updateDeviceSchema) {}
export class DeviceCommandsQueryDto extends zodDto(deviceCommandsQuerySchema) {}
export class PunchFeedQueryDto extends zodDto(punchFeedQuerySchema) {}
export class ReviewPunchDto extends zodDto(reviewPunchSchema) {}
export class DevicePeopleQueryDto extends zodDto(devicePeopleQuerySchema) {}
export class SetDeviceUserIdDto extends zodDto(setDeviceUserIdSchema) {}
export class DeviceDefaultsDto extends zodDto(deviceDefaultsSchema) {}
export class DevicePeopleCsvQueryDto extends zodDto(devicePeopleCsvQuerySchema) {}
export class DeviceImportQueryDto extends zodDto(deviceImportQuerySchema) {}
export class RemoveFromDevicesDto extends zodDto(removeFromDevicesSchema) {}
export class StaffRangeCheckQueryDto extends zodDto(staffRangeCheckQuerySchema) {}

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

/** Registers from device punches: OWNER/ADMIN, module ATTENDANCE. */
@Controller('attendance/sections')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN')
export class DeviceRegistersController {
  constructor(private readonly registers: DeviceRegistersService) {}

  /** Today's register of a section the cutoff held back, from its punches (after a confirm). */
  @Post(':id/close-from-device')
  closeFromDevice(@Param('id', ParseUUIDPipe) id: string): Promise<CloseFromDeviceResult> {
    return this.registers.closeFromDevice(id);
  }
}

/** People ↔ device IDs: OWNER/ADMIN, module ATTENDANCE. */
@Controller('attendance/device-people')
@RequireModule('ATTENDANCE')
@Roles('OWNER', 'ADMIN')
export class DevicePeopleController {
  constructor(
    private readonly people: DevicePeopleService,
    private readonly csv: DevicePeopleCsvService,
  ) {}

  /** This year's students and the staff, each with their ID, suggested default and sync state. */
  @Get()
  list(@Query() query: DevicePeopleQueryDto): Promise<DevicePeopleList> {
    return this.people.list(query);
  }

  /** Set or clear one person's ID; a new ID is sent to every active device. */
  @Put()
  set(@Body() dto: SetDeviceUserIdDto): Promise<SetDeviceIdResult> {
    return this.people.set(dto);
  }

  @Get('collisions')
  collisions(): Promise<DeviceIdCollisionView[]> {
    return this.people.collisions();
  }

  /** Default IDs for people without one: a dry run, then the same with dryRun false. */
  @Post('defaults')
  @HttpCode(200)
  defaults(@Body() dto: DeviceDefaultsDto): Promise<DeviceDefaultsResult> {
    return this.people.defaults(dto);
  }

  /** Everyone with their ID or suggested default: UTF-8 with a BOM, ASCII digits. */
  @Get('csv')
  async exportCsv(
    @Query() query: DevicePeopleCsvQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.csv.exportCsv(query.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  /** multipart/form-data with `file` (.csv, at most 1 MB); apply=1 writes the OK rows. */
  @Post('import')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: DEVICE_IMPORT_MAX_BYTES, files: 1, fields: 0 } }),
  )
  importCsv(
    @Query() query: DeviceImportQueryDto,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
  ): Promise<DeviceImportResult> {
    return this.csv.importCsv(file, query.apply);
  }

  /** People no longer active whose ID a device still has. */
  @Get('stale')
  stale(): Promise<StaleDevicePerson[]> {
    return this.people.stale();
  }

  @Post('remove-from-devices')
  @HttpCode(200)
  removeFromDevices(@Body() dto: RemoveFromDevicesDto): Promise<RemoveFromDevicesResult> {
    return this.people.removeFromDevices(dto.deviceUserIds);
  }

  /** For the settings form: current students' code numbers within a staff start's 1000. */
  @Get('staff-range-check')
  staffRangeCheck(@Query() query: StaffRangeCheckQueryDto): Promise<StaffRangeCheck> {
    return this.people.staffRangeCheck(query.start);
  }
}

@Module({
  // AttendanceSettingsService: the timezone, the device settings and working days.
  // AbsentSmsService: the absent SMS of device registers and the guardians' phones.
  // DEVICES_QUEUE: the receiver's process-punches jobs and the devices-tick scheduler.
  imports: [AttendanceModule, BullModule.registerQueue({ name: DEVICES_QUEUE })],
  controllers: [DevicesController, DeviceRegistersController, DevicePeopleController],
  providers: [
    DevicesService,
    DevicePunchesService,
    DeviceAlertsService,
    PunchReviewEffects,
    DevicePeopleRoster,
    DevicePeopleService,
    DevicePeopleCsvService,
    DeviceAttendanceService,
    DeviceRegistersService,
    PunchProcessingService,
    DevicesProcessor,
  ],
  // For staff attendance: the punch lock a manual day takes, and who is active staff.
  exports: [DeviceAttendanceService, DevicePeopleRoster],
})
export class DevicesModule {}
