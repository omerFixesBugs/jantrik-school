import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  platformGenerateInvoicesSchema,
  platformInvoiceListQuerySchema,
  platformPaymentSchema,
  platformVoidSchema,
  type IsoDate,
  type PlatformGenerateResult,
  type PlatformInvoiceDetail,
  type PlatformInvoiceListItem,
  type PlatformInvoicePage,
} from '@jantrik/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { PlatformRoute, PlatformTxTimeout } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { PlatformDb, platformDbError } from './platform-db.js';

class GenerateDto extends zodDto(platformGenerateInvoicesSchema) {}
class InvoiceListQueryDto extends zodDto(platformInvoiceListQuerySchema) {}
class PaymentDto extends zodDto(platformPaymentSchema) {}
class VoidDto extends zodDto(platformVoidSchema) {}

interface InvoiceRow {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  period_start: Date;
  period_end: Date;
  cycle: PlatformInvoiceListItem['cycle'];
  issued_on: Date;
  due_on: Date;
  status: PlatformInvoiceListItem['status'];
  total_paisa: number;
  paid_paisa: number;
  overdue: boolean;
  total: bigint;
}

const isoDate = (d: Date): IsoDate => d.toISOString().slice(0, 10) as IsoDate;
/** A Postgres date/timestamp inside jsonb (e.g. "2026-10-20" or "…+00:00"). */
const jsonDate = (v: string): IsoDate => v.slice(0, 10) as IsoDate;

/**
 * Jantrik's invoices to institutes (part 3): one month's invoices at a time (idempotent),
 * payments recorded by hand (cash, bKash, bank), void while unpaid. Everything goes through the
 * platform functions, which audit on both sides.
 */
@Injectable()
export class PlatformBillingService {
  constructor(private readonly db: PlatformDb) {}

  async list(q: z.output<typeof platformInvoiceListQuerySchema>): Promise<PlatformInvoicePage> {
    const query = (offset: number, limit: number) => this.db.tx.$queryRaw<InvoiceRow[]>`
      SELECT * FROM platform_list_invoices(${q.tenantId ?? null}::uuid, ${q.status ?? null},
        ${q.overdue ?? null}::boolean, ${q.month ? `${q.month}-01` : null}::date,
        ${offset}::int, ${limit}::int)`;
    const rows = await query((q.page - 1) * q.pageSize, q.pageSize);
    const total = rows[0]?.total ?? (q.page > 1 ? ((await query(0, 1))[0]?.total ?? 0n) : 0n);
    return {
      items: rows.map((r) => ({
        id: r.id,
        tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
        periodStart: isoDate(r.period_start),
        periodEnd: isoDate(r.period_end),
        cycle: r.cycle,
        issuedOn: isoDate(r.issued_on),
        dueOn: isoDate(r.due_on),
        status: r.status,
        totalPaisa: r.total_paisa,
        paidPaisa: r.paid_paisa,
        overdue: r.overdue,
      })),
      total: Number(total),
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async detail(id: string): Promise<PlatformInvoiceDetail> {
    const [row] = await this.db.tx.$queryRaw<
      { v: RawInvoice }[]
    >`SELECT platform_get_invoice(${id}::uuid) AS v`.catch(platformDbError);
    const v = row!.v;
    return {
      ...v,
      periodStart: jsonDate(v.periodStart),
      periodEnd: jsonDate(v.periodEnd),
      issuedOn: jsonDate(v.issuedOn),
      dueOn: jsonDate(v.dueOn),
      voidedAt: v.voidedAt ? new Date(v.voidedAt).toISOString() : null,
      payments: v.payments.map((p) => ({
        ...p,
        paidOn: jsonDate(p.paidOn),
        createdAt: new Date(p.createdAt).toISOString(),
      })),
    };
  }

  async generate(
    input: z.output<typeof platformGenerateInvoicesSchema>,
    ip: string,
  ): Promise<PlatformGenerateResult> {
    const [row] = await this.db.tx.$queryRaw<{ v: PlatformGenerateResult }[]>`
      SELECT platform_generate_invoices(${`${input.month}-01`}::date, ${input.issuedOn}::date,
        ${ip}) AS v`.catch(platformDbError);
    return row!.v;
  }

  async pay(id: string, p: z.output<typeof platformPaymentSchema>, ip: string) {
    await this.db.tx.$executeRaw`
      SELECT platform_record_payment(${id}::uuid, ${p.amountPaisa}::int, ${p.method},
        ${p.reference}, ${p.paidOn}::date, ${ip})`.catch(platformDbError);
    return this.detail(id);
  }

  async void(id: string, reason: string, ip: string) {
    await this.db.tx.$executeRaw`
      SELECT platform_void_invoice(${id}::uuid, ${reason}, ${ip})`.catch(platformDbError);
    return this.detail(id);
  }
}

interface RawInvoice extends Omit<PlatformInvoiceDetail, 'payments'> {
  payments: (Omit<PlatformInvoiceDetail['payments'][number], 'paidOn'> & { paidOn: string })[];
}

const ipOf = (req: Request) => req.ip ?? 'unknown';

@Controller('platform/invoices')
@PlatformRoute()
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get()
  list(@Query() q: InvoiceListQueryDto): Promise<PlatformInvoicePage> {
    return this.billing.list(q);
  }

  /** One month's invoices for every institute that is due (idempotent). */
  @Post('generate')
  @HttpCode(200)
  @PlatformTxTimeout(60_000) // every institute in one transaction
  generate(@Body() dto: GenerateDto, @Req() req: Request): Promise<PlatformGenerateResult> {
    return this.billing.generate(dto, ipOf(req));
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformInvoiceDetail> {
    return this.billing.detail(id);
  }

  @Post(':id/payments')
  @HttpCode(200)
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaymentDto,
    @Req() req: Request,
  ): Promise<PlatformInvoiceDetail> {
    return this.billing.pay(id, dto, ipOf(req));
  }

  @Post(':id/void')
  @HttpCode(200)
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
    @Req() req: Request,
  ): Promise<PlatformInvoiceDetail> {
    return this.billing.void(id, dto.reason, ipOf(req));
  }
}
