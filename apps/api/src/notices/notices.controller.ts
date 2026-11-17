import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  noticeInputSchema,
  publishNoticeSchema,
  withdrawNoticeSchema,
  type NoticeBoardItem,
  type NoticeDetail,
  type NoticeManageItem,
  type NoticeReadCounts,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { NoticesService } from './notices.service.js';

class NoticeInputDto extends zodDto(noticeInputSchema) {}
class PublishNoticeDto extends zodDto(publishNoticeSchema) {}
class WithdrawNoticeDto extends zodDto(withdrawNoticeSchema) {}

/** Every member reads the board; OWNER/ADMIN write (S20). Module CORE (S3). */
@Controller('notices')
@RequireModule('CORE')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF', 'GUARDIAN')
  board(): Promise<NoticeBoardItem[]> {
    return this.notices.board();
  }

  @Get('unread-count')
  @Roles('OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF', 'GUARDIAN')
  unreadCount(): Promise<{ count: number }> {
    return this.notices.unreadCount();
  }

  @Get('manage')
  @Roles('OWNER', 'ADMIN')
  manageList(): Promise<NoticeManageItem[]> {
    return this.notices.manageList();
  }

  @Get('manage/:id')
  @Roles('OWNER', 'ADMIN')
  manageOne(@Param('id', ParseUUIDPipe) id: string): Promise<NoticeManageItem> {
    return this.notices.manageOne(id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Body() body: NoticeInputDto): Promise<NoticeManageItem> {
    return this.notices.create(body);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF', 'GUARDIAN')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<NoticeDetail> {
    return this.notices.detail(id);
  }

  @Post(':id/read')
  @HttpCode(204)
  @Roles('OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF', 'GUARDIAN')
  async read(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.notices.markRead(id);
  }

  @Put(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: NoticeInputDto,
  ): Promise<NoticeManageItem> {
    return this.notices.update(id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN')
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PublishNoticeDto,
  ): Promise<NoticeManageItem> {
    return this.notices.publish(id, body.publishAt);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WithdrawNoticeDto,
  ): Promise<NoticeManageItem> {
    return this.notices.withdraw(id, body.reason);
  }

  @Get(':id/reads')
  @Roles('OWNER', 'ADMIN')
  reads(@Param('id', ParseUUIDPipe) id: string): Promise<NoticeReadCounts> {
    return this.notices.readCounts(id);
  }
}
