import { BullModule } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  cancelFeeDueSchema,
  collectFeeSchema,
  feeClosingQuerySchema,
  voidFeePaymentSchema,
  type FeeClosing,
  type FeeReceipt,
  confirmSiblingsSchema,
  copyFeeAmountsSchema,
  createFeeConcessionSchema,
  createFeeHeadSchema,
  createFeeTermSchema,
  endFeeConcessionSchema,
  feeAmountsQuerySchema,
  feeConcessionsQuerySchema,
  feeLedgerQuerySchema,
  feeSettingsSchema,
  feeStudentSearchSchema,
  feeTermsQuerySchema,
  recalculateFeeDuesSchema,
  removeSiblingSchema,
  setFeeAmountsSchema,
  updateFeeHeadSchema,
  updateFeeTermSchema,
  waiveFeeFineSchema,
  type FeeAmountsMatrix,
  type FeeConcessionView,
  type FeeHeadView,
  type FeeLedger,
  type FeeSettingsView,
  type FeeSiblingsView,
  type FeeStudentHit,
  type FeeTermView,
} from '@jantrik/shared';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { FeeCollectionService } from './collection/fee-collection.service.js';
import { FEES_QUEUE, FeeDuesService } from './dues/fee-dues.service.js';
import { FeeDuesProcessor } from './dues/fee-dues.processor.js';
import { FeeLedgerService } from './dues/fee-ledger.service.js';
import { FeeStudentsService } from './fee-students.service.js';
import { FeeSetupService } from './setup/fee-setup.service.js';
import { FeeSiblingsService } from './setup/fee-siblings.service.js';

class FeeSettingsDto extends zodDto(feeSettingsSchema) {}
class CreateFeeHeadDto extends zodDto(createFeeHeadSchema) {}
class UpdateFeeHeadDto extends zodDto(updateFeeHeadSchema) {}
class CreateFeeTermDto extends zodDto(createFeeTermSchema) {}
class UpdateFeeTermDto extends zodDto(updateFeeTermSchema) {}
class FeeTermsQueryDto extends zodDto(feeTermsQuerySchema) {}
class FeeAmountsQueryDto extends zodDto(feeAmountsQuerySchema) {}
class SetFeeAmountsDto extends zodDto(setFeeAmountsSchema) {}
class CopyFeeAmountsDto extends zodDto(copyFeeAmountsSchema) {}
class CreateFeeConcessionDto extends zodDto(createFeeConcessionSchema) {}
class EndFeeConcessionDto extends zodDto(endFeeConcessionSchema) {}
class FeeConcessionsQueryDto extends zodDto(feeConcessionsQuerySchema) {}
class ConfirmSiblingsDto extends zodDto(confirmSiblingsSchema) {}
class RemoveSiblingDto extends zodDto(removeSiblingSchema) {}
class FeeStudentSearchDto extends zodDto(feeStudentSearchSchema) {}
class FeeLedgerQueryDto extends zodDto(feeLedgerQuerySchema) {}
class CancelFeeDueDto extends zodDto(cancelFeeDueSchema) {}
class WaiveFeeFineDto extends zodDto(waiveFeeFineSchema) {}
class RecalculateFeeDuesDto extends zodDto(recalculateFeeDuesSchema) {}
export class CollectFeeDto extends zodDto(collectFeeSchema) {}
class VoidFeePaymentDto extends zodDto(voidFeePaymentSchema) {}
class FeeClosingQueryDto extends zodDto(feeClosingQuerySchema) {}

const Id = (name = 'id') => Param(name, ParseUUIDPipe);

/** Fee setup (docs/fees.md): OWNER/ADMIN. Teachers have no fee route at all. */
@Controller('fees')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN')
export class FeeSetupController {
  constructor(
    private readonly setup: FeeSetupService,
    private readonly siblings: FeeSiblingsService,
  ) {}

  @Get('settings')
  settings(): Promise<FeeSettingsView> {
    return this.setup.settings();
  }

  @Put('settings')
  saveSettings(@Body() dto: FeeSettingsDto): Promise<FeeSettingsView> {
    return this.setup.saveSettings(dto);
  }

  @Get('heads')
  heads(): Promise<FeeHeadView[]> {
    return this.setup.listHeads();
  }

  @Post('heads')
  createHead(@Body() dto: CreateFeeHeadDto): Promise<FeeHeadView> {
    return this.setup.createHead(dto);
  }

  @Patch('heads/:id')
  updateHead(@Id() id: string, @Body() dto: UpdateFeeHeadDto): Promise<FeeHeadView> {
    return this.setup.updateHead(id, dto);
  }

  @Get('terms')
  terms(@Query() query: FeeTermsQueryDto): Promise<FeeTermView[]> {
    return this.setup.listTerms(query.academicYearId);
  }

  @Post('terms')
  createTerm(@Body() dto: CreateFeeTermDto): Promise<FeeTermView> {
    return this.setup.createTerm(dto);
  }

  @Patch('terms/:id')
  updateTerm(@Id() id: string, @Body() dto: UpdateFeeTermDto): Promise<FeeTermView> {
    return this.setup.updateTerm(id, dto);
  }

  @Delete('terms/:id')
  @HttpCode(204)
  async deleteTerm(@Id() id: string): Promise<void> {
    await this.setup.deleteTerm(id);
  }

  @Get('amounts')
  amounts(@Query() query: FeeAmountsQueryDto): Promise<FeeAmountsMatrix> {
    return this.setup.amounts(query.academicYearId);
  }

  @Put('amounts')
  setAmounts(@Body() dto: SetFeeAmountsDto): Promise<FeeAmountsMatrix> {
    return this.setup.setAmounts(dto);
  }

  @Post('amounts/copy')
  @HttpCode(200)
  copyAmounts(@Body() dto: CopyFeeAmountsDto): Promise<{ copied: number }> {
    return this.setup.copyAmounts(dto);
  }

  @Get('concessions')
  concessions(@Query() query: FeeConcessionsQueryDto): Promise<FeeConcessionView[]> {
    return this.setup.listConcessions(query);
  }

  @Post('concessions')
  createConcession(@Body() dto: CreateFeeConcessionDto): Promise<FeeConcessionView> {
    return this.setup.createConcession(dto);
  }

  @Post('concessions/:id/end')
  @HttpCode(200)
  endConcession(@Id() id: string, @Body() dto: EndFeeConcessionDto): Promise<FeeConcessionView> {
    return this.setup.endConcession(id, dto);
  }

  @Get('siblings')
  siblingsView(): Promise<FeeSiblingsView> {
    return this.siblings.view();
  }

  @Post('siblings')
  confirmSiblings(@Body() dto: ConfirmSiblingsDto): Promise<{ groupId: string; added: string[] }> {
    return this.siblings.confirm(dto.studentIds);
  }

  @Post('siblings/:groupId/members/:studentId/remove')
  @HttpCode(200)
  async removeSibling(
    @Id('groupId') groupId: string,
    @Id('studentId') studentId: string,
    @Body() dto: RemoveSiblingDto,
  ): Promise<{ ok: true }> {
    await this.siblings.remove(groupId, studentId, dto.reason);
    return { ok: true };
  }
}

/** Finding students at the fee counter: OWNER/ADMIN/ACCOUNTANT (phones masked for accountants). */
@Controller('fees')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class FeeStudentsController {
  constructor(
    private readonly students: FeeStudentsService,
    private readonly ledgers: FeeLedgerService,
  ) {}

  @Get('students')
  search(@Query() query: FeeStudentSearchDto): Promise<FeeStudentHit[]> {
    return this.students.search(query.q);
  }

  @Get('students/:id/ledger')
  ledger(@Id() id: string, @Query() query: FeeLedgerQueryDto): Promise<FeeLedger> {
    return this.ledgers.ledger(id, query);
  }
}

/** The fee counter: OWNER/ADMIN/ACCOUNTANT collect and print; only OWNER/ADMIN void. */
@Controller('fees')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class FeeCounterController {
  constructor(private readonly collection: FeeCollectionService) {}

  @Post('payments')
  collect(@Body() dto: CollectFeeDto): Promise<FeeReceipt> {
    return this.collection.collect(dto);
  }

  @Get('payments/:id')
  receipt(@Id() id: string): Promise<FeeReceipt> {
    return this.collection.receipt(id);
  }

  @Post('payments/:id/void')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  void(@Id() id: string, @Body() dto: VoidFeePaymentDto): Promise<FeeReceipt> {
    return this.collection.void(id, dto.reason);
  }

  @Get('closing')
  closing(@Query() query: FeeClosingQueryDto): Promise<FeeClosing> {
    return this.collection.closing(query);
  }
}

/** Corrections to dues: OWNER/ADMIN (cancel, waive a fine, recalculate, generate now). */
@Controller('fees/dues')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN')
export class FeeDuesController {
  constructor(private readonly dues: FeeDuesService) {}

  @Post('generate')
  @HttpCode(200)
  async generate(): Promise<{ created: number }> {
    return { created: await this.dues.ensureForTenant('admin') };
  }

  @Post('recalculate')
  @HttpCode(200)
  recalculate(@Body() dto: RecalculateFeeDuesDto): Promise<{ updated: number }> {
    return this.dues.recalculateUnpaid(dto.studentIds);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Id() id: string, @Body() dto: CancelFeeDueDto): Promise<{ ok: true }> {
    await this.dues.cancelDue(id, dto.reason);
    return { ok: true };
  }

  @Post(':id/waive-fine')
  @HttpCode(200)
  async waive(@Id() id: string, @Body() dto: WaiveFeeFineDto): Promise<{ ok: true }> {
    await this.dues.waiveFine(id, dto);
    return { ok: true };
  }
}

@Module({
  // AttendanceModule: the shared daily SMS cap (AttendanceSettingsService.smsDailyCap).
  imports: [BullModule.registerQueue({ name: FEES_QUEUE }), AttendanceModule],
  controllers: [FeeSetupController, FeeStudentsController, FeeCounterController, FeeDuesController],
  providers: [
    FeeSetupService,
    FeeSiblingsService,
    FeeStudentsService,
    FeeDuesService,
    FeeDuesProcessor,
    FeeLedgerService,
    FeeCollectionService,
  ],
  exports: [FeeCollectionService],
})
export class FeesModule {}
