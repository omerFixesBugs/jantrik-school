import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  applyOnlinePaymentSchema,
  dismissReviewSchema,
  onlinePaymentsQuerySchema,
  refundedOutsideSchema,
  type FeeReceipt,
  type OnlinePaymentCheckQueued,
  type OnlinePaymentList,
  type OnlinePaymentStaffView,
  type PaymentReviewQueue,
  type PaymentSignalItem,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { ReviewService } from './review.service.js';

class ApplyOnlinePaymentDto extends zodDto(applyOnlinePaymentSchema) {}
class RefundedOutsideDto extends zodDto(refundedOutsideSchema) {}
class DismissReviewDto extends zodDto(dismissReviewSchema) {}
class OnlinePaymentsQueryDto extends zodDto(onlinePaymentsQuerySchema) {}

const Id = (name = 'id') => Param(name, ParseUUIDPipe);

/**
 * Online payments for staff and their review queue (sprint 1 P7b, docs/payments.md → The review
 * queue). OWNER, ADMIN and ACCOUNTANT read and may ask SSLCommerz again ("check now"); only OWNER
 * and ADMIN decide (P7b-D). Another institute's id is a 404 (RLS). Registered after the gateway
 * account's controller, so `/fees/online-payments/account` stays the owner's; the fixed paths
 * (`review`, `signals/…`) come before `:id`.
 */
@Controller('fees/online-payments')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class OnlinePaymentsController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  list(@Query() query: OnlinePaymentsQueryDto): Promise<OnlinePaymentList> {
    return this.review.list(query);
  }

  @Get('review')
  queue(): Promise<PaymentReviewQueue> {
    return this.review.queue();
  }

  /** The fee tabs' badge: how many items wait (no heal, nothing else). */
  @Get('review/count')
  async count(): Promise<{ count: number }> {
    return { count: await this.review.count() };
  }

  @Post('signals/:eventId/refunded-outside')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  signalRefundOutside(
    @Id('eventId') eventId: string,
    @Body() dto: RefundedOutsideDto,
  ): Promise<PaymentSignalItem> {
    return this.review.signalRefundOutside(eventId, dto);
  }

  @Post('signals/:eventId/dismiss')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  signalDismiss(
    @Id('eventId') eventId: string,
    @Body() dto: DismissReviewDto,
  ): Promise<PaymentSignalItem> {
    return this.review.signalDismiss(eventId, dto);
  }

  @Get(':id')
  detail(@Id() id: string): Promise<OnlinePaymentStaffView> {
    return this.review.detail(id);
  }

  @Post(':id/check')
  @HttpCode(202)
  check(@Id() id: string): Promise<OnlinePaymentCheckQueued> {
    return this.review.check(id);
  }

  /** A receipt, as the counter's (201). */
  @Post(':id/apply')
  @Roles('OWNER', 'ADMIN')
  apply(@Id() id: string, @Body() dto: ApplyOnlinePaymentDto): Promise<FeeReceipt> {
    return this.review.apply(id, dto);
  }

  @Post(':id/refunded-outside')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  refundOutside(
    @Id() id: string,
    @Body() dto: RefundedOutsideDto,
  ): Promise<OnlinePaymentStaffView> {
    return this.review.refundOutside(id, dto);
  }

  @Post(':id/dismiss')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  dismiss(@Id() id: string, @Body() dto: DismissReviewDto): Promise<OnlinePaymentStaffView> {
    return this.review.dismiss(id, dto);
  }
}
