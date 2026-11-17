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
  Req,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  admissionApplicationsQuerySchema,
  admissionCycleClassesSchema,
  admissionCycleSchema,
  admissionCycleStatusSchema,
  admissionStatusSchema,
  approveAdmissionSchema,
  bulkApproveAdmissionSchema,
  staffAdmissionApplicationSchema,
  updateAdmissionApplicationSchema,
  updateAdmissionCycleSchema,
  type AdmissionApplicationDetail,
  type AdmissionApplicationsPage,
  type AdmissionBulkApproveStatus,
  type AdmissionCycleView,
  type AdmissionOptions,
  type AdmissionSectionOption,
} from '@jantrik/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { OwnTransaction, RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { ImageUpload, ImageUploads, type UploadedImage } from '../files/files.module.js';
import { StudentsModule } from '../students/students.module.js';
import { RequestTransaction } from '../tenancy/request-transaction.service.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AdmissionSmsProcessor } from './admission-sms.processor.js';
import { AdmissionApplicationsService } from './applications.service.js';
import { ADMISSION_SMS_QUEUE, AdmissionOtpService } from './public/admission-otp.service.js';
import { FormTickets } from './public/form-ticket.js';
import { PhoneTokens } from './public/phone-token.js';
import { AdmissionPublicController } from './public/public.controller.js';
import { AdmissionPublicService } from './public/public.service.js';
import { AdmissionSubmitGuard } from './public/submit.guard.js';
import { TurnstileVerifier } from './public/turnstile.js';
import { AdmissionApprovalProcessor } from './approval.processor.js';
import {
  ADMISSION_QUEUE,
  AdmissionApprovalService,
  type ApproveResult,
} from './approval.service.js';
import { AdmissionCyclesService } from './cycles.service.js';

class CycleDto extends zodDto(admissionCycleSchema) {}
class UpdateCycleDto extends zodDto(updateAdmissionCycleSchema) {}
class CycleStatusDto extends zodDto(admissionCycleStatusSchema) {}
class CycleClassesDto extends zodDto(admissionCycleClassesSchema) {}
class ApplicationsQueryDto extends zodDto(admissionApplicationsQuerySchema) {}
class CsvQueryDto extends zodDto(
  admissionApplicationsQuerySchema.extend({ locale: z.enum(['bn', 'en']).default('bn') }),
) {}
class StaffApplicationDto extends zodDto(staffAdmissionApplicationSchema) {}
class UpdateApplicationDto extends zodDto(updateAdmissionApplicationSchema) {}
class StatusDto extends zodDto(admissionStatusSchema) {}
class ApproveDto extends zodDto(approveAdmissionSchema) {}
class BulkApproveDto extends zodDto(bulkApproveAdmissionSchema) {}

const Id = () => Param('id', ParseUUIDPipe);
const WRITERS = ['OWNER', 'ADMIN'] as const;

/** Admission cycles and their classes (sprint 1 P3a, docs/admission.md). */
@Controller('admission')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class AdmissionCyclesController {
  constructor(private readonly cycles: AdmissionCyclesService) {}

  /** Years, classes and groups for the cycle form. */
  @Get('options')
  options(): Promise<AdmissionOptions> {
    return this.cycles.options();
  }

  @Get('cycles')
  list(): Promise<AdmissionCycleView[]> {
    return this.cycles.list();
  }

  @Post('cycles')
  create(@Body() dto: CycleDto): Promise<AdmissionCycleView> {
    return this.cycles.create(dto);
  }

  @Get('cycles/:id')
  get(@Id() id: string): Promise<AdmissionCycleView> {
    return this.cycles.get(id);
  }

  @Patch('cycles/:id')
  update(@Id() id: string, @Body() dto: UpdateCycleDto): Promise<AdmissionCycleView> {
    return this.cycles.update(id, dto);
  }

  @Post('cycles/:id/status')
  @HttpCode(200)
  status(@Id() id: string, @Body() dto: CycleStatusDto): Promise<AdmissionCycleView> {
    return this.cycles.setStatus(id, dto.status);
  }

  @Put('cycles/:id/classes')
  classes(@Id() id: string, @Body() dto: CycleClassesDto): Promise<AdmissionCycleView> {
    return this.cycles.setClasses(id, dto);
  }

  /** The sections an application of this class may be approved into (the cycle's year). */
  @Get('cycle-classes/:id/sections')
  sections(@Id() id: string): Promise<AdmissionSectionOption[]> {
    return this.cycles.sections(id);
  }
}

/** Applications: the list, staff entry, edits, status, photo and approval (OWNER/ADMIN). */
@Controller('admission')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class AdmissionApplicationsController {
  constructor(
    private readonly applications: AdmissionApplicationsService,
    private readonly approval: AdmissionApprovalService,
    private readonly uploads: ImageUploads,
    private readonly transaction: RequestTransaction,
  ) {}

  @Get('applications')
  list(@Query() q: ApplicationsQueryDto): Promise<AdmissionApplicationsPage> {
    return this.applications.list(q);
  }

  /** The same filter as CSV (UTF-8 with a BOM, ASCII digits), at most 10 000 rows. */
  @Get('applications.csv')
  async csv(@Query() q: CsvQueryDto, @Res({ passthrough: true }) res: Response): Promise<string> {
    const csv = await this.applications.csv(q, q.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="admission-applications.csv"');
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  /** A walk-in or paper application typed by staff (decision P3-J). */
  @Post('applications')
  create(@Body() dto: StaffApplicationDto): Promise<AdmissionApplicationDetail> {
    return this.applications.create(dto);
  }

  @Get('applications/:id')
  detail(@Id() id: string): Promise<AdmissionApplicationDetail> {
    return this.applications.detail(id);
  }

  @Patch('applications/:id')
  update(@Id() id: string, @Body() dto: UpdateApplicationDto): Promise<AdmissionApplicationDetail> {
    return this.applications.update(id, dto);
  }

  @Post('applications/:id/status')
  @HttpCode(200)
  status(@Id() id: string, @Body() dto: StatusDto): Promise<AdmissionApplicationDetail> {
    return this.applications.setStatus(id, dto.status, dto.reason);
  }

  /** The applicant's photo (a re-encoded JPEG): a strong ETag, never cached by others. */
  @Get('applications/:id/photo')
  async photo(@Id() id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const photo = await this.applications.photo(id);
    res.setHeader('ETag', `"${photo.sha256}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    res.type(photo.mime);
    res.send(Buffer.from(photo.bytes));
  }

  /** multipart/form-data with `file` (JPEG, PNG or WebP, at most 5 MB); stored as a JPEG. */
  @Put('applications/:id/photo')
  @OwnTransaction()
  @ImageUpload()
  async setPhoto(
    @Id() id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AdmissionApplicationDetail> {
    // A wrong or admitted application costs no decoding (as student photos, P2).
    await this.transaction.run(() => this.applications.assertEditable(id), { roles: WRITERS });
    const image = await this.uploads.prepare('APPLICANT_PHOTO', file);
    return this.transaction.run(() => this.applications.setPhoto(id, image), { roles: WRITERS });
  }

  @Post('applications/:id/approve')
  @HttpCode(200)
  async approve(
    @Id() id: string,
    @Body() dto: ApproveDto,
  ): Promise<ApproveResult & { application: AdmissionApplicationDetail }> {
    const result = await this.approval.approve(id, dto);
    return { ...result, application: await this.applications.detail(id) };
  }

  @Post('cycle-classes/:id/bulk-approve')
  @HttpCode(202)
  bulkApprove(@Id() id: string, @Body() dto: BulkApproveDto): Promise<AdmissionBulkApproveStatus> {
    return this.approval.startBulk(id, dto.sectionId);
  }

  @Get('cycle-classes/:id/bulk-approve')
  bulkStatus(@Id() id: string): Promise<AdmissionBulkApproveStatus> {
    return this.approval.bulkStatus(id);
  }
}

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMISSION_QUEUE }, { name: ADMISSION_SMS_QUEUE }),
    StudentsModule,
    AttendanceModule,
  ],
  controllers: [
    AdmissionCyclesController,
    AdmissionApplicationsController,
    AdmissionPublicController,
  ],
  providers: [
    AdmissionCyclesService,
    AdmissionApplicationsService,
    AdmissionApprovalService,
    AdmissionApprovalProcessor,
    AdmissionPublicService,
    AdmissionOtpService,
    PhoneTokens,
    FormTickets,
    TurnstileVerifier,
    AdmissionSubmitGuard,
    AdmissionSmsProcessor,
  ],
  exports: [AdmissionApplicationsService],
})
export class AdmissionModule {}
