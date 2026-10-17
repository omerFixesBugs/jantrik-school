import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { withContext, type SessionClient, type SessionRevokeReason } from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { revokedSessionKey } from '../common/revocation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { ACCESS_TOKEN_TTL_SEC } from './token.service.js';

export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
/** A rotated token may be presented again within this window (network retry) — see docs/auth.md. */
export const REFRESH_GRACE_SEC = 30;

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

export type RotateResult =
  | {
      kind: 'rotated';
      sessionId: string;
      userId: string;
      activeTenantId: string | null;
      refreshToken: string;
    }
  /** Idempotent retry inside the grace window: the exact response issued the first time. */
  | { kind: 'retry'; response: AuthResponse };

interface TokenRow {
  token_id: string;
  session_id: string;
  user_id: string;
  token_expires_at: Date;
  rotated_at: Date | null;
  session_expires_at: Date;
  revoked_at: Date | null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const graceKey = (oldHash: string) => `rt:grace:${oldHash}`;
const invalid = () => new UnauthorizedException('Invalid credentials');

/**
 * Login sessions and their rotating refresh tokens. Only SHA-256 hashes of refresh tokens are
 * stored; the raw token exists only in the client (and, encrypted with a key derived from the
 * previous token, for 30 s in Redis to answer retries).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async create(input: {
    userId: string;
    client: SessionClient;
    activeTenantId: string | null;
    meta: SessionMeta;
  }): Promise<{ sessionId: string; refreshToken: string }> {
    const refreshToken = newToken();
    const expiresAt = inSeconds(REFRESH_TTL_SEC);
    const session = await withContext(this.prisma.client, { userId: input.userId }, async (tx) => {
      const s = await tx.session.create({
        data: {
          userId: input.userId,
          activeTenantId: input.activeTenantId,
          client: input.client,
          ip: input.meta.ip,
          userAgent: input.meta.userAgent,
          expiresAt,
        },
      });
      await tx.refreshToken.create({
        data: { userId: input.userId, sessionId: s.id, tokenHash: sha256(refreshToken), expiresAt },
      });
      return s;
    });
    return { sessionId: session.id, refreshToken };
  }

  /**
   * Exchange a refresh token for a new one.
   * - valid, unused token → rotate
   * - already-rotated token within 30 s whose replacement is unused → the same response again
   * - any other already-rotated token → REUSE: revoke the whole session
   */
  async rotate(rawToken: string, meta: SessionMeta): Promise<RotateResult> {
    const oldHash = sha256(rawToken);
    const row = await this.findToken(oldHash);
    if (!row || row.revoked_at) throw invalid();

    if (row.rotated_at) {
      const retry = await this.graceRetry(rawToken, oldHash, row);
      if (retry) return { kind: 'retry', response: retry };
      await this.revoke(row.session_id, row.user_id, 'REUSE_DETECTED');
      throw invalid();
    }

    const now = new Date();
    if (row.token_expires_at <= now || row.session_expires_at <= now) throw invalid();

    const refreshToken = newToken();
    const expiresAt = inSeconds(REFRESH_TTL_SEC);
    const session = await withContext(this.prisma.client, { userId: row.user_id }, async (tx) => {
      // Only one concurrent rotation of the same token can win.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: row.token_id, rotatedAt: null },
        data: { rotatedAt: now },
      });
      if (count === 0) return null;
      await tx.refreshToken.create({
        data: {
          userId: row.user_id,
          sessionId: row.session_id,
          tokenHash: sha256(refreshToken),
          expiresAt,
        },
      });
      return tx.session.update({
        where: { id: row.session_id },
        data: { lastUsedAt: now, expiresAt, ip: meta.ip, userAgent: meta.userAgent },
      });
    });

    if (!session) {
      // Lost a race with an identical concurrent request: answer like a retry once the winner
      // has stored its response; otherwise just fail (no revoke — this is not an attack).
      for (let i = 0; i < 10; i++) {
        await sleep(100);
        const retry = await this.graceRetry(rawToken, oldHash, { ...row, rotated_at: now });
        if (retry) return { kind: 'retry', response: retry };
      }
      throw invalid();
    }

    return {
      kind: 'rotated',
      sessionId: session.id,
      userId: session.userId,
      activeTenantId: session.activeTenantId,
      refreshToken,
    };
  }

  /** Remember the response for a rotated token, for idempotent retries within the window. */
  async storeGrace(oldRawToken: string, response: AuthResponse): Promise<void> {
    await this.redis.set(
      graceKey(sha256(oldRawToken)),
      encrypt(oldRawToken, JSON.stringify(response)),
      'EX',
      REFRESH_GRACE_SEC,
    );
  }

  async revoke(sessionId: string, userId: string, reason: SessionRevokeReason): Promise<void> {
    await withContext(this.prisma.client, { userId }, (tx) =>
      tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
    );
    // Access tokens of this session stop working immediately, not when they expire.
    await this.redis.set(revokedSessionKey(sessionId), '1', 'EX', ACCESS_TOKEN_TTL_SEC);
  }

  async setActiveTenant(sessionId: string, userId: string, tenantId: string | null): Promise<void> {
    await withContext(this.prisma.client, { userId }, (tx) =>
      tx.session.update({ where: { id: sessionId }, data: { activeTenantId: tenantId } }),
    );
  }

  private async findToken(tokenHash: string): Promise<TokenRow | undefined> {
    const rows = await this.prisma.client.$queryRaw<TokenRow[]>`
      SELECT token_id::text, session_id::text, user_id::text, token_expires_at, rotated_at,
             session_expires_at, revoked_at
      FROM auth_find_refresh_token(${tokenHash})`;
    return rows[0];
  }

  private async graceRetry(
    rawToken: string,
    oldHash: string,
    row: TokenRow,
  ): Promise<AuthResponse | undefined> {
    if (!row.rotated_at || Date.now() - row.rotated_at.getTime() > REFRESH_GRACE_SEC * 1000) {
      return undefined;
    }
    const sealed = await this.redis.get(graceKey(oldHash));
    if (!sealed) return undefined;
    const response = JSON.parse(decrypt(rawToken, sealed)) as AuthResponse;
    if (!response.refreshToken) return undefined;

    // The replacement must still be unused and the session alive.
    const replacement = await this.findToken(sha256(response.refreshToken));
    if (!replacement || replacement.rotated_at || replacement.revoked_at) return undefined;
    return response;
  }
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function inSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

// AES-256-GCM with a key derived from the previous refresh token: the cached response is
// readable only by whoever presents that token, so Redis contents alone are useless.
function keyFor(rawToken: string): Buffer {
  return createHash('sha256').update(`jantrik-refresh-grace:${rawToken}`).digest();
}

function encrypt(rawToken: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(rawToken), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(rawToken: string, sealed: string): string {
  const data = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(rawToken), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
