import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  normalizePassword,
  passwordProblems,
  type PasswordCodeSent,
  type PasswordProblem,
  type PasswordStatus,
  type SetPasswordInput,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext, type Principal } from '../common/request-context.js';
import { revokedSessionKey } from '../common/revocation.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { REDIS_CALL_TIMEOUT_MS, withRedisDeadline } from '../redis/redis-deadline.js';
import { Db } from '../tenancy/db.service.js';
import { isCommonPassword, loadCommonPasswords } from './common-passwords.js';
import { listMemberships } from './login-lookup.js';
import { OTP_TTL_SEC, OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { ACCESS_TOKEN_TTL_SEC } from './token.service.js';

/** `PUT /me/password` tries per person per 15 minutes. */
export const PASSWORD_SET_LIMIT = 5;

/** `+8801711000002` → `017•••••002`: enough to recognise one's own number. */
export function phoneHint(phone: string): string {
  const local = phone.startsWith('+880') ? `0${phone.slice(4)}` : phone;
  return `${local.slice(0, 3)}•••••${local.slice(-3)}`;
}

/**
 * Staff set their own password (sprint 1 P1, S26). Runs in the current institute's request
 * transaction (P1-A), so the change is audited there. The only writer of users.password_hash
 * (password-writes.spec.ts).
 */
@Injectable()
export class PasswordSettingsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The common-password list is read at start-up: a missing file stops the API from starting. */
  onModuleInit(): void {
    loadCommonPasswords();
  }

  async status(principal: Principal): Promise<PasswordStatus> {
    const user = await this.db.tx.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { passwordHash: true, passwordChangedAt: true, phone: true },
    });
    return {
      hasPassword: user.passwordHash !== null,
      changedAt: user.passwordChangedAt?.toISOString() ?? null,
      phone: user.phone,
    };
  }

  /** A password code to the person's own phone, under the phone's SMS limits (P1-E: Jantrik pays). */
  async sendCode(principal: Principal, ip: string): Promise<PasswordCodeSent> {
    const phone = await this.ownPhone(principal);
    await this.otp.request(phone, ip, 'password');
    return { expiresIn: OTP_TTL_SEC, phoneHint: phoneHint(phone) };
  }

  /**
   * Set the password. The rules are checked before the code, so a refused password does not use
   * the code up. On success, in this transaction: the hash, the time, every other session of the
   * person revoked, and an audit row without values. After commit, those sessions' access tokens
   * stop working too.
   */
  async set(principal: Principal, ip: string, input: SetPasswordInput): Promise<void> {
    await this.limiter.consume({
      key: `pwd-set:${principal.userId}`,
      limit: PASSWORD_SET_LIMIT,
      windowSec: 900,
    });
    const phone = await this.ownPhone(principal);
    const password = normalizePassword(input.password);

    // The names of every institute the person is an active member of, here or elsewhere.
    const instituteNames = (await listMemberships(this.db.tx))
      .filter((m) => m.roles.length > 0)
      .map((m) => m.tenant.name);
    const problems: (PasswordProblem | 'TOO_COMMON')[] = passwordProblems(password, {
      phone,
      instituteNames,
    });
    if (isCommonPassword(password)) problems.push('TOO_COMMON');
    if (problems.length > 0) {
      throw apiError(422, 'PASSWORD_REJECTED', 'This password cannot be used', { problems });
    }

    const user = await this.otp.verify(phone, input.code, ip, 'password');
    if (user?.id !== principal.userId) {
      throw apiError(422, 'PASSWORD_CODE_INVALID', 'The code is wrong, expired or already used');
    }

    const passwordHash = await this.passwords.hash(password);
    const now = new Date();
    const tx = this.db.tx;
    await tx.user.update({
      where: { id: principal.userId },
      data: { passwordHash, passwordChangedAt: now },
    });
    // Every other session not yet revoked, in one statement, whatever its expiry: a refresh
    // that passed its check just before the session expired may still commit (and extend it);
    // a revoked session makes that commit roll back.
    const others = (
      await tx.session.updateManyAndReturn({
        where: {
          userId: principal.userId,
          revokedAt: null,
          NOT: { id: principal.sessionId },
        },
        data: { revokedAt: now, revokeReason: 'PASSWORD_CHANGED' },
        select: { id: true },
      })
    ).map((s) => s.id);
    await this.audit.record({
      entity: 'user_password',
      entityId: principal.userId,
      action: 'UPDATE',
    });

    // The revocation stands in the database (their refresh fails); this ends their access tokens
    // now rather than within 15 minutes. A failure is logged, never a failed answer.
    await this.context.afterCommit(() =>
      Promise.all(
        others.map((id) =>
          withRedisDeadline(
            () => this.redis.set(revokedSessionKey(id), '1', 'EX', ACCESS_TOKEN_TTL_SEC),
            REDIS_CALL_TIMEOUT_MS,
            'SERVICE_UNAVAILABLE',
          ),
        ),
      ),
    );
  }

  /** The person's own phone, from their own row (RLS: self). */
  private async ownPhone(principal: Principal): Promise<string> {
    const user = await this.db.tx.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { phone: true },
    });
    return user.phone;
  }
}
