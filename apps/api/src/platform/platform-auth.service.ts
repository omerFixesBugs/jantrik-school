import { randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  hashPlatformToken,
  normalizeBackupCode,
  platformKeys,
  totpUri,
  verifyTotp,
  withPlatformSession,
  type PlatformKeys,
  type TenantTx,
} from '@jantrik/db';
import {
  normalizeBdPhone,
  toAsciiDigits,
  todayIn,
  type PlatformAdminInfo,
  type PlatformAuditEntry,
  type PlatformLoginResponse,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { PasswordService } from '../auth/password.service.js';
import { apiError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_SEC,
  PLATFORM_IDLE_SEC,
  PLATFORM_MAX_SEC,
  VERIFY_PER_ADMIN_PER_15MIN,
  VERIFY_PER_ADMIN_PER_DAY,
} from './platform.constants.js';

const challengeKey = (id: string) => `platform:challenge:${id}`;
const attemptsKey = (id: string) => `platform:challenge:${id}:attempts`;

/** What the password step leaves for the code step (TOTP secrets stay encrypted in Redis). */
interface Challenge {
  adminId: string;
  /** The admin's stored (encrypted) secret; null until enrolled. */
  totp: string | null;
  /** First login: the new (encrypted) secret being set up. */
  enrol: string | null;
  /** The password hash the login started with: a password change in between voids the challenge. */
  passwordHash: string;
}

interface AdminRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totp_enabled_at: Date | null;
  backup_codes_left: number;
  session_expires_at: Date | null;
}

/**
 * Platform login: password, then a TOTP code from an authenticator app (or a one-time backup
 * code). Never SMS. The first login enrols the app (QR code) and hands out 10 backup codes once.
 * All the checks that must be atomic (a code or backup code used only once, enrolment, the new
 * session and its audit entry) happen in platform_complete_login.
 */
@Injectable()
export class PlatformAuthService {
  private readonly keys: PlatformKeys;

  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly passwords: PasswordService,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.keys = platformKeys({
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      PLATFORM_TOTP_KEY: config.get('PLATFORM_TOTP_KEY', { infer: true }),
      OTP_PEPPER: config.get('OTP_PEPPER', { infer: true }),
    });
  }

  /** Step 1. The same 401 for an unknown account, a wrong password or a disabled admin. */
  async login(identifier: string, password: string, ip: string): Promise<PlatformLoginResponse> {
    const phone = normalizeBdPhone(identifier);
    const email = phone ? null : identifier.trim().toLowerCase();
    const accountKey = `plogin-id:${phone ?? email}`;
    await this.limiter.consume(
      {
        key: `plogin-ip:${ip}`,
        limit: this.config.get('LOGIN_PER_IP_PER_15MIN', { infer: true }),
        windowSec: 900,
      },
      {
        key: accountKey,
        limit: this.config.get('LOGIN_PER_IDENTIFIER_PER_15MIN', { infer: true }),
        windowSec: 900,
      },
    );
    const [admin] = await this.prisma.client.$queryRaw<
      {
        id: string;
        name: string;
        password_hash: string;
        is_active: boolean;
        totp_secret: string | null;
        totp_enrol_by: Date | null;
      }[]
    >`SELECT * FROM platform_find_admin_for_login(${phone}, ${email})`;
    const ok = await this.passwords.verify(admin?.password_hash, password);
    if (!admin || !ok || !admin.is_active) {
      // Attempts on a real account (also a disabled one) are visible in the audit log.
      if (admin) await this.auditFailure(admin.id, ok ? 'INACTIVE' : 'BAD_PASSWORD', ip);
      throw apiError(401, 'INVALID_CREDENTIALS', 'Wrong phone/email or password');
    }
    await this.limiter.reset(accountKey);

    // Not set up yet: allowed only inside the window the CLI opened (create / reset-2fa), so a
    // leaked password alone cannot enrol a stranger's authenticator later.
    if (!admin.totp_secret && (!admin.totp_enrol_by || admin.totp_enrol_by <= new Date())) {
      await this.auditFailure(admin.id, 'ENROLMENT_CLOSED', ip);
      throw apiError(403, 'ENROLMENT_CLOSED', 'Ask a platform administrator to reset your 2FA');
    }
    const challengeId = randomBytes(24).toString('base64url');
    let enrol: PlatformLoginResponse['enrol'];
    if (!admin.totp_secret) {
      const secret = generateTotpSecret();
      enrol = { secret, uri: totpUri(secret, phone ?? email ?? admin.name) };
    }
    const challenge: Challenge = {
      adminId: admin.id,
      totp: admin.totp_secret,
      enrol: enrol ? encryptTotpSecret(enrol.secret, this.keys) : null,
      passwordHash: admin.password_hash,
    };
    await this.redis.set(
      challengeKey(challengeId),
      JSON.stringify(challenge),
      'EX',
      CHALLENGE_TTL_SEC,
    );
    return { challengeId, ...(enrol ? { enrol } : {}) };
  }

  /**
   * Step 2: a 6-digit code (TOTP; on the first login it confirms the enrolment) or a backup code.
   * Returns the new session token (for the cookie) and, after an enrolment, the backup codes.
   */
  async verify(
    challengeId: string,
    code: string,
    ip: string,
    userAgent: string | null,
  ): Promise<{ token: string; backupCodes?: string[] }> {
    await this.limiter.consume({
      key: `pverify-ip:${ip}`,
      limit: this.config.get('LOGIN_PER_IP_PER_15MIN', { infer: true }),
      windowSec: 900,
    });
    const raw = await this.redis.get(challengeKey(challengeId));
    if (!raw) throw apiError(401, 'CHALLENGE_EXPIRED', 'Sign in again');
    const challenge = JSON.parse(raw) as Challenge;
    await this.limiter.consume(
      {
        key: `pverify-admin:${challenge.adminId}`,
        limit: VERIFY_PER_ADMIN_PER_15MIN,
        windowSec: 900,
      },
      {
        key: `pverify-admin-day:${challenge.adminId}`,
        limit: VERIFY_PER_ADMIN_PER_DAY,
        windowSec: 86_400,
      },
    );
    const attempts = await this.redis.incr(attemptsKey(challengeId));
    if (attempts === 1) await this.redis.expire(attemptsKey(challengeId), CHALLENGE_TTL_SEC);
    if (attempts > CHALLENGE_MAX_ATTEMPTS) {
      // The counter is left to expire: concurrent requests keep counting past the limit.
      await this.redis.del(challengeKey(challengeId));
      await this.auditFailure(challenge.adminId, 'TOO_MANY_ATTEMPTS', ip);
      throw apiError(401, 'CHALLENGE_EXPIRED', 'Too many wrong codes; sign in again');
    }
    const fail = async (reason: string): Promise<never> => {
      await this.auditFailure(challenge.adminId, reason, ip);
      throw apiError(401, 'INVALID_CODE', 'Wrong code', {
        attemptsLeft: Math.max(0, CHALLENGE_MAX_ATTEMPTS - attempts),
      });
    };

    const digits = toAsciiDigits(code).replace(/\s/g, '');
    let method: 'ENROL' | 'TOTP' | 'BACKUP';
    let step: number | null = null;
    let backupHash: string | null = null;
    let backupCodes: string[] | undefined;
    if (/^\d{6}$/.test(digits)) {
      const stored = challenge.enrol ?? challenge.totp;
      const secret = stored ? decryptTotpSecret(stored, this.keys) : null;
      step = secret ? verifyTotp(secret, digits) : null;
      if (step === null) return fail('BAD_CODE');
      method = challenge.enrol ? 'ENROL' : 'TOTP';
      if (method === 'ENROL') backupCodes = generateBackupCodes();
    } else if (challenge.totp && normalizeBackupCode(code)) {
      method = 'BACKUP';
      backupHash = hashBackupCode(code, this.keys);
    } else {
      return fail('BAD_CODE');
    }

    const token = randomBytes(32).toString('base64url');
    try {
      await this.prisma.client.$queryRaw`
        SELECT platform_complete_login(${challenge.adminId}::uuid, ${method},
          ${step === null ? null : BigInt(step)}::bigint, ${backupHash},
          ${method === 'ENROL' ? challenge.enrol : null},
          ${backupCodes ? backupCodes.map((c) => hashBackupCode(c, this.keys)) : null}::text[],
          ${challenge.passwordHash}, ${challenge.totp},
          ${hashPlatformToken(token)}, ${ip}, ${userAgent?.slice(0, 300) ?? null},
          ${PLATFORM_IDLE_SEC}::int, ${PLATFORM_MAX_SEC}::int)::text AS id`;
    } catch (error) {
      const message = (error as Error).message;
      if (/PLATFORM_CODE_REUSED/.test(message)) return fail('CODE_REUSED');
      if (/PLATFORM_CODE_EXPIRED/.test(message)) return fail('BAD_CODE');
      if (/PLATFORM_CREDENTIALS_CHANGED/.test(message)) {
        await this.redis.del(challengeKey(challengeId));
        throw apiError(401, 'CHALLENGE_EXPIRED', 'Your sign-in details changed; sign in again');
      }
      if (/PLATFORM_ENROLMENT_CLOSED/.test(message)) {
        throw apiError(403, 'ENROLMENT_CLOSED', 'Ask a platform administrator to reset your 2FA');
      }
      if (/PLATFORM_BACKUP_CODE_INVALID/.test(message)) return fail('BAD_BACKUP_CODE');
      if (/PLATFORM_ADMIN_INACTIVE/.test(message)) {
        throw apiError(401, 'INVALID_CREDENTIALS', 'Wrong phone/email or password');
      }
      if (/PLATFORM_ALREADY_ENROLLED/.test(message)) {
        throw apiError(409, 'ALREADY_ENROLLED', 'Sign in again');
      }
      throw error;
    }
    await this.redis.del(challengeKey(challengeId), attemptsKey(challengeId));
    return { token, ...(backupCodes ? { backupCodes } : {}) };
  }

  /** The admin of a fresh session token (right after login, before the cookie round-trip). */
  async adminForToken(token: string): Promise<PlatformAdminInfo> {
    return withPlatformSession(this.prisma.client, hashPlatformToken(token), (tx) => this.me(tx));
  }

  async me(tx: TenantTx): Promise<PlatformAdminInfo> {
    const [row] = await tx.$queryRaw<AdminRow[]>`SELECT * FROM platform_me()`;
    if (!row) throw new UnauthorizedException();
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      totpEnabledAt: row.totp_enabled_at?.toISOString() ?? null,
      backupCodesLeft: row.backup_codes_left,
      sessionExpiresAt: row.session_expires_at?.toISOString() ?? null,
      // The platform works in Bangladesh time (as institutes are created and billed).
      today: todayIn('Asia/Dhaka'),
    };
  }

  async logout(tx: TenantTx): Promise<void> {
    await tx.$executeRaw`SELECT platform_end_session()`;
  }

  async audit(
    tx: TenantTx,
    before: string | undefined,
    beforeId: string | undefined,
    limit: number,
  ): Promise<PlatformAuditEntry[]> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        created_at: Date;
        actor: 'ADMIN' | 'CLI';
        admin_name: string | null;
        action: string;
        target_tenant_id: string | null;
        target_tenant_name: string | null;
        entity: string | null;
        entity_id: string | null;
        details: Record<string, unknown> | null;
        ip: string | null;
      }[]
    >`SELECT * FROM platform_list_audit(${before ? new Date(before) : null}::timestamptz,
        ${beforeId ?? null}::uuid, ${limit}::int)`;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at.toISOString(),
      actor: r.actor,
      adminName: r.admin_name,
      action: r.action,
      targetTenantId: r.target_tenant_id,
      targetTenantName: r.target_tenant_name,
      entity: r.entity,
      entityId: r.entity_id,
      details: r.details,
      ip: r.ip,
    }));
  }

  private async auditFailure(adminId: string, reason: string, ip: string): Promise<void> {
    await this.prisma.client
      .$executeRaw`SELECT platform_audit_login_failure(${adminId}::uuid, ${reason}, ${ip})`;
  }
}
