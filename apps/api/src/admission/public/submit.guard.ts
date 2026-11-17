import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { apiError } from '../../common/api-error.js';
import { RateLimiter } from '../../redis/rate-limiter.service.js';
import { PhoneTokens } from './phone-token.js';

/**
 * Runs before the submit's upload is read (guards run before interceptors; review of P3b, S3):
 * the per-address limit (10 an hour) and a phone token of ours that has not expired. Without
 * them a stranger could make the API buffer a 5 MB body for nothing. The route checks the
 * token's institute afterwards.
 */
@Injectable()
export class AdmissionSubmitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly phones: PhoneTokens,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    await this.limiter.consume({
      key: `adm-submit-ip:${req.ip ?? 'unknown'}`,
      limit: 10,
      windowSec: 3600,
    });
    const token = req.headers['x-admission-token'];
    // A form token only: a status token proves the phone for the status page, never a submit.
    if (!this.phones.valid(typeof token === 'string' ? token : undefined, 'form')) {
      throw apiError(401, 'ADMISSION_TOKEN_INVALID', 'Verify the phone again');
    }
    return true;
  }
}
