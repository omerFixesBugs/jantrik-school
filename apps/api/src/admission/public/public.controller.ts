import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  UPLOAD_MAX_BYTES,
  type AdmissionPublicForm,
  type AdmissionPublicStatus,
} from '@jantrik/shared';
import type { Request } from 'express';
import { apiError } from '../../common/api-error.js';
import { Public } from '../../common/decorators.js';
import { AdmissionPublicService } from './public.service.js';
import { AdmissionSubmitGuard } from './submit.guard.js';

/** Institute slugs as the API makes them (lower case, digits, hyphens). */
const slugParam = (slug: string): string => {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw apiError(404, 'ADMISSION_UNKNOWN', 'No such institute');
  }
  return slug;
};

/**
 * The public admission form (sprint 1 P3b, docs/admission.md → The public form): no login. The
 * applicant's phone is proved by a code, then carried in `X-Admission-Token` (30 minutes).
 */
@Controller('public/admission/:slug')
@Public()
export class AdmissionPublicController {
  constructor(private readonly admission: AdmissionPublicService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  form(
    @Param('slug') slug: string,
    @Req() req: Request,
  ): Promise<AdmissionPublicForm & { formTicket: string }> {
    return this.admission.form(slugParam(slug), req.ip ?? 'unknown');
  }

  @Post('otp')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  otp(
    @Param('slug') slug: string,
    @Body() body: { phone?: unknown; turnstileToken?: unknown },
    @Req() req: Request,
  ): Promise<{ expiresIn: number }> {
    return this.admission.requestOtp(slugParam(slug), body ?? {}, req.ip ?? 'unknown');
  }

  @Post('otp/verify')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  verify(
    @Param('slug') slug: string,
    @Body() body: { phone?: unknown; code?: unknown; purpose?: unknown },
    @Req() req: Request,
  ): Promise<{ phoneToken: string; expiresIn: number }> {
    return this.admission.verifyOtp(slugParam(slug), body ?? {}, req.ip ?? 'unknown');
  }

  /**
   * multipart/form-data: `payload` (the form as JSON), `cycleClassId`, `turnstileToken`,
   * `formTicket`, `website` (a honeypot, empty) and an optional `photo` (at most 5 MB, refused
   * while it streams; decoded two at a time per process).
   */
  @Post('applications')
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  @UseGuards(AdmissionSubmitGuard)
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 8, fieldSize: 64 * 1024, parts: 10 },
    }),
  )
  submit(
    @Param('slug') slug: string,
    @Headers('x-admission-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
    @UploadedFile() photo: { buffer: Buffer } | undefined,
    @Req() req: Request,
  ): Promise<{ applicationNo: string }> {
    return this.admission.submit(
      slugParam(slug),
      token,
      body ?? {},
      photo?.buffer,
      req.ip ?? 'unknown',
    );
  }

  @Post('status')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  status(
    @Param('slug') slug: string,
    @Headers('x-admission-token') token: string | undefined,
    @Body() body: { applicationNo?: unknown },
    @Req() req: Request,
  ): Promise<AdmissionPublicStatus> {
    return this.admission.status(slugParam(slug), token, body ?? {}, req.ip ?? 'unknown');
  }
}
