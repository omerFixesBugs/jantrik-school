import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  broadcastInputSchema,
  scheduleBroadcastSchema,
  sendBroadcastSchema,
  type BroadcastAlert,
  type BroadcastPreview,
  type BroadcastView,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { BroadcastsService } from './broadcasts.service.js';

class BroadcastInputDto extends zodDto(broadcastInputSchema) {}
class SendBroadcastDto extends zodDto(sendBroadcastSchema) {}
class ScheduleBroadcastDto extends zodDto(scheduleBroadcastSchema) {}

/** SMS broadcasts: OWNER/ADMIN only (S20), module CORE (S3). */
@Controller('broadcasts')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get()
  list(): Promise<BroadcastView[]> {
    return this.broadcasts.list();
  }

  @Get('alerts')
  alerts(): Promise<BroadcastAlert[]> {
    return this.broadcasts.alerts();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BroadcastView> {
    return this.broadcasts.get(id);
  }

  @Post()
  create(@Body() body: BroadcastInputDto): Promise<BroadcastView> {
    return this.broadcasts.create(body);
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BroadcastInputDto,
  ): Promise<BroadcastView> {
    return this.broadcasts.update(id, body);
  }

  @Post(':id/preview')
  @HttpCode(200)
  preview(@Param('id', ParseUUIDPipe) id: string): Promise<BroadcastPreview> {
    return this.broadcasts.preview(id);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendBroadcastDto,
  ): Promise<BroadcastView> {
    return this.broadcasts.send(id, body.expectedRecipients);
  }

  @Post(':id/schedule')
  @HttpCode(200)
  schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleBroadcastDto,
  ): Promise<BroadcastView> {
    return this.broadcasts.schedule(id, body.scheduledAt, body.expectedRecipients);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<BroadcastView> {
    return this.broadcasts.cancel(id);
  }
}
