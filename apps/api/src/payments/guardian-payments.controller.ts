import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { startOnlinePaymentSchema, type OnlinePaymentView } from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { CheckoutService } from './checkout.service.js';

class StartOnlinePaymentDto extends zodDto(startOnlinePaymentSchema) {}

const Id = (name = 'id') => Param(name, ParseUUIDPipe);

/**
 * A guardian pays chosen dues of their child online (sprint 1 P7a2, S22). 404 for a child that is
 * not theirs; no staff role reaches these routes (no staff payment links).
 */
@Controller('me/children/:id/fees/online-payments')
@RequireModule('FEES')
@Roles('GUARDIAN')
export class GuardianPaymentsController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  start(@Id() id: string, @Body() dto: StartOnlinePaymentDto): Promise<OnlinePaymentView> {
    return this.checkout.start(id, dto);
  }

  @Get(':intentId')
  view(@Id() id: string, @Id('intentId') intentId: string): Promise<OnlinePaymentView> {
    return this.checkout.view(id, intentId);
  }

  @Post(':intentId/abandon')
  @HttpCode(200)
  abandon(@Id() id: string, @Id('intentId') intentId: string): Promise<OnlinePaymentView> {
    return this.checkout.abandon(id, intentId);
  }
}
