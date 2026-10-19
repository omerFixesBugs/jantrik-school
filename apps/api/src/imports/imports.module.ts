import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IMPORT_MAX_BYTES,
  importMappingSchema,
  importRowsQuerySchema,
  type ImportPreviewPage,
  type StudentImportSummary,
} from '@jantrik/shared';
import type { Job } from 'bullmq';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { StudentsModule } from '../students/students.module.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { templateCsv, templateXlsx } from './spreadsheet.js';
import { IMPORT_QUEUE, StudentImportService, type ImportJob } from './student-import.service.js';

class MappingDto extends zodDto(importMappingSchema) {}
class RowsQueryDto extends zodDto(importRowsQuerySchema) {}
class ReportQueryDto extends zodDto(z.object({ locale: z.enum(['bn', 'en']).default('bn') })) {}

/** Rows per job transaction (each row is a full admission). */
const CHUNK = 25;

/** Excel/CSV student import (OWNER/ADMIN). */
@Controller('student-imports')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class StudentImportsController {
  constructor(private readonly imports: StudentImportService) {}

  @Get('template.xlsx')
  async templateXlsx(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const l = await this.imports.lookups();
    const buffer = await templateXlsx({
      classLevels: l.classLevels.filter((c) => c.isActive).map((c) => `${c.nameBn} (${c.nameEn})`),
      sections: [...new Set(l.sections.filter((s) => s.isActive).map((s) => s.name))],
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(buffer);
  }

  @Get('template.csv')
  templateCsv(@Res({ passthrough: true }) res: Response): string {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.csv"');
    res.setHeader('Cache-Control', 'no-store');
    return templateCsv();
  }

  @Get()
  list(): Promise<StudentImportSummary[]> {
    return this.imports.list();
  }

  /** multipart/form-data with `file` (.xlsx or .csv, at most 5 MB). */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 0 } }),
  )
  upload(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
  ): Promise<StudentImportSummary> {
    return this.imports.upload(file);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<StudentImportSummary> {
    return this.imports.summary(id);
  }

  @Put(':id/mapping')
  mapping(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MappingDto,
  ): Promise<StudentImportSummary> {
    return this.imports.validate(id, dto.mapping);
  }

  @Get(':id/rows')
  rows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RowsQueryDto,
  ): Promise<ImportPreviewPage> {
    return this.imports.rows(id, q.filter, q.page);
  }

  @Post(':id/run')
  @HttpCode(202)
  run(@Param('id', ParseUUIDPipe) id: string): Promise<StudentImportSummary> {
    return this.imports.start(id);
  }

  @Get(':id/report.csv')
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.imports.reportCsv(id, q.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }
}

/** Runs an import for one tenant, chunk by chunk, acting as the admin who started it. */
@Processor(IMPORT_QUEUE)
export class StudentImportProcessor extends WorkerHost {
  private readonly logger = new Logger(StudentImportProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly imports: StudentImportService,
  ) {
    super();
  }

  async process(job: Job<ImportJob>): Promise<void> {
    const { tenantId, importId } = job.data;
    try {
      const claim = await this.jobs.run(tenantId, () => this.imports.claim(importId));
      if (!claim) return;
      // Each chunk reads its own starting point from the (locked) import row.
      for (;;) {
        const done = await this.jobs.run(
          tenantId,
          () => this.imports.runChunk(importId, CHUNK),
          claim,
        );
        if (done) break;
      }
    } catch (error) {
      // Not the message: database errors can contain row values (personal data).
      this.logger.error(`Import ${importId} failed: ${(error as Error).name}`);
      await this.jobs.run(tenantId, () => this.imports.fail(importId, 'ERROR'));
    }
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: IMPORT_QUEUE }), StudentsModule],
  controllers: [StudentImportsController],
  providers: [StudentImportService, StudentImportProcessor],
})
export class ImportsModule {}
