import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Redirect,
  Req,
} from '@nestjs/common';
import { NoRateLimit, Public } from '../../common/decorators.js';
import { GatewaySignalsService } from './gateway-signals.service.js';
import type { SignalRequest } from './signal-body.js';

/** The form the reader found, or null for a body that was not one (too large, another type). */
const formOf = (req: SignalRequest): Record<string, string> | null =>
  req.signalBody?.ok ? req.signalBody.fields : null;

/**
 * SSLCommerz's two public surfaces (sprint 1 P7a2, docs/payments.md → Signals): the payer's
 * browser coming back, and the IPN. No login, no institute transaction, limits of their own
 * (`@NoRateLimit()`: every IPN comes from one or two SSLCommerz addresses, P7a-C).
 */
@Controller('public/payments/sslcommerz/:slug')
@Public()
@NoRateLimit()
export class GatewaySignalsController {
  constructor(private readonly signals: GatewaySignalsService) {}

  /** The browser returns by a form POST (or a GET: the docs do not say, P7a-N); 303 onwards. */
  @Post('return/:tranId/:outcome')
  @Header('Cache-Control', 'no-store')
  @Redirect()
  async returnPost(
    @Param('slug') slug: string,
    @Param('tranId') tranId: string,
    @Param('outcome') outcome: string,
    @Req() req: SignalRequest,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.signals.payerReturn(slug, tranId, outcome, formOf(req), req.ip ?? '');
    return { url, statusCode: 303 };
  }

  @Get('return/:tranId/:outcome')
  @Header('Cache-Control', 'no-store')
  @Redirect()
  async returnGet(
    @Param('slug') slug: string,
    @Param('tranId') tranId: string,
    @Param('outcome') outcome: string,
    @Query() query: Record<string, unknown>,
    @Req() req: SignalRequest,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.signals.payerReturn(slug, tranId, outcome, query ?? {}, req.ip ?? '');
    return { url, statusCode: 303 };
  }

  /** The IPN: 200 "OK" (also when nothing was stored), or 429 over a budget. */
  @Post('ipn')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async ipn(@Param('slug') slug: string, @Req() req: SignalRequest): Promise<string> {
    await this.signals.ipn(slug, formOf(req), req.ip ?? '');
    return 'OK';
  }
}
