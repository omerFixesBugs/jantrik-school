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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  feeCollectionsQuerySchema,
  feeDueListQuerySchema,
  feeReminderFilterSchema,
  sendFeeRemindersSchema,
  type FeeCollections,
  type FeeDueList,
  type FeeReminderPreview,
  type FeeReminderRun,
  type FeeReminderStatus,
  type FeeSummary,
  createMobileAccountSchema,
  feeSubmissionsQuerySchema,
  guardianSubmissionSchema,
  rejectSubmissionSchema,
  staffSubmissionSchema,
  updateMobileAccountSchema,
  verifySubmissionSchema,
  type FeeGuardianView,
  type FeeMobileAccountView,
  type FeeSubmissionView,
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
import {
  FEES_QUEUE,
  FeeDuesService,
  GENERATE_TENANT_JOB,
  RECALCULATE_TENANT_JOB,
} from './dues/fee-dues.service.js';
import { FeeDuesProcessor } from './dues/fee-dues.processor.js';
import { FeeLedgerService } from './dues/fee-ledger.service.js';
import { FeeMobileService } from './mobile/fee-mobile.service.js';
import { FeeRemindersService } from './reminders/fee-reminders.service.js';
import { FeeReportsService } from './reports/fee-reports.service.js';
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
class CreateMobileAccountDto extends zodDto(createMobileAccountSchema) {}
class UpdateMobileAccountDto extends zodDto(updateMobileAccountSchema) {}
class GuardianSubmissionDto extends zodDto(guardianSubmissionSchema) {}
class StaffSubmissionDto extends zodDto(staffSubmissionSchema) {}
class FeeSubmissionsQueryDto extends zodDto(feeSubmissionsQuerySchema) {}
class VerifySubmissionDto extends zodDto(verifySubmissionSchema) {}
class RejectSubmissionDto extends zodDto(rejectSubmissionSchema) {}
class FeeDueListQueryDto extends zodDto(feeDueListQuerySchema) {}
class FeeCollectionsQueryDto extends zodDto(feeCollectionsQuerySchema) {}
class FeeReminderFilterDto extends zodDto(feeReminderFilterSchema) {}
class SendFeeRemindersDto extends zodDto(sendFeeRemindersSchema) {}

/** A CSV download (attendance's pattern): UTF-8 with BOM, an ASCII filename, never cached. */
function sendCsv(res: Response, file: { filename: string; csv: string }): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return file.csv;
}

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

/** The institute's own bKash/Nagad numbers: everyone at the counter reads, only the OWNER changes. */
@Controller('fees/mobile-accounts')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class FeeMobileAccountsController {
  constructor(private readonly mobile: FeeMobileService) {}

  @Get()
  list(): Promise<FeeMobileAccountView[]> {
    return this.mobile.listAccounts();
  }

  @Post()
  @Roles('OWNER')
  create(@Body() dto: CreateMobileAccountDto): Promise<FeeMobileAccountView> {
    return this.mobile.createAccount(dto);
  }

  @Patch(':id')
  @Roles('OWNER')
  update(@Id() id: string, @Body() dto: UpdateMobileAccountDto): Promise<FeeMobileAccountView> {
    return this.mobile.updateAccount(id, dto);
  }
}

/** bKash/Nagad transfers waiting to be checked: staff record, verify or reject them. */
@Controller('fees/submissions')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class FeeSubmissionsController {
  constructor(private readonly mobile: FeeMobileService) {}

  @Get()
  list(@Query() query: FeeSubmissionsQueryDto): Promise<FeeSubmissionView[]> {
    return this.mobile.list(query.status);
  }

  @Post()
  create(@Body() dto: StaffSubmissionDto): Promise<FeeSubmissionView> {
    return this.mobile.submitAsStaff(dto);
  }

  @Post(':id/verify')
  @HttpCode(200)
  verify(@Id() id: string, @Body() dto: VerifySubmissionDto): Promise<FeeReceipt> {
    return this.mobile.verify(id, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Id() id: string, @Body() dto: RejectSubmissionDto): Promise<FeeSubmissionView> {
    return this.mobile.reject(id, dto.reason);
  }
}

/** A guardian's view of their own child's fees (404 for any other child). */
@Controller('me/children')
@RequireModule('FEES')
@Roles('GUARDIAN')
export class GuardianFeesController {
  constructor(private readonly mobile: FeeMobileService) {}

  @Get(':id/fees')
  fees(@Id() id: string): Promise<FeeGuardianView> {
    return this.mobile.guardianView(id);
  }

  @Post(':id/fees/submissions')
  submit(@Id() id: string, @Body() dto: GuardianSubmissionDto): Promise<FeeSubmissionView> {
    return this.mobile.submitAsGuardian(id, dto);
  }

  @Get(':id/fees/payments/:paymentId')
  receipt(@Id() id: string, @Id('paymentId') paymentId: string): Promise<FeeReceipt> {
    return this.mobile.guardianReceipt(id, paymentId);
  }
}

/** Reports and the dashboard card: OWNER/ADMIN/ACCOUNTANT. */
@Controller('fees')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class FeeReportsController {
  constructor(private readonly reports: FeeReportsService) {}

  @Get('summary')
  summary(): Promise<FeeSummary> {
    return this.reports.summary();
  }

  @Get('reports/dues')
  dues(@Query() q: FeeDueListQueryDto): Promise<FeeDueList> {
    return this.reports.dueList(q);
  }

  @Get('reports/dues/csv')
  async duesCsv(
    @Query() q: FeeDueListQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    return sendCsv(res, await this.reports.dueListCsv(q));
  }

  @Get('reports/collections')
  collections(@Query() q: FeeCollectionsQueryDto): Promise<FeeCollections> {
    return this.reports.collections(q);
  }

  @Get('reports/collections/csv')
  async collectionsCsv(
    @Query() q: FeeCollectionsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    return sendCsv(res, await this.reports.collectionsCsv(q));
  }
}

/** Due reminder SMS: OWNER/ADMIN (they cost the institute money). */
@Controller('fees/reminders')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN')
export class FeeRemindersController {
  constructor(private readonly reminders: FeeRemindersService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: FeeReminderFilterDto): Promise<FeeReminderPreview> {
    return this.reminders.preview(dto);
  }

  @Post()
  @HttpCode(202)
  send(@Body() dto: SendFeeRemindersDto): Promise<FeeReminderRun> {
    const { expectedRecipients, ...filter } = dto;
    return this.reminders.send(filter, expectedRecipients);
  }

  @Get(':runId')
  status(@Id('runId') runId: string): Promise<FeeReminderStatus> {
    return this.reminders.status(runId);
  }
}

/** Corrections to dues: OWNER/ADMIN (cancel, waive a fine, recalculate, generate now). */
@Controller('fees/dues')
@RequireModule('FEES')
@Roles('OWNER', 'ADMIN')
export class FeeDuesController {
  constructor(private readonly dues: FeeDuesService) {}

  /** The whole institute's dues, in the background (202). */
  @Post('generate')
  @HttpCode(202)
  async generate(): Promise<{ queued: true }> {
    await this.dues.enqueueTenantJob(GENERATE_TENANT_JOB);
    return { queued: true };
  }

  /** A few students (e.g. a family just confirmed): now. The whole institute: in the background. */
  @Post('recalculate')
  async recalculate(
    @Body() dto: RecalculateFeeDuesDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ updated: number } | { queued: true }> {
    if (dto.studentIds) {
      res.status(200);
      return this.dues.recalculateUnpaid(dto.studentIds);
    }
    await this.dues.enqueueTenantJob(RECALCULATE_TENANT_JOB);
    res.status(202);
    return { queued: true };
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
  controllers: [
    FeeSetupController,
    FeeStudentsController,
    FeeCounterController,
    FeeDuesController,
    FeeMobileAccountsController,
    FeeSubmissionsController,
    GuardianFeesController,
    FeeReportsController,
    FeeRemindersController,
  ],
  providers: [
    FeeSetupService,
    FeeSiblingsService,
    FeeStudentsService,
    FeeDuesService,
    FeeDuesProcessor,
    FeeLedgerService,
    FeeCollectionService,
    FeeMobileService,
    FeeReportsService,
    FeeRemindersService,
  ],
  exports: [FeeCollectionService],
})
export class FeesModule {}
