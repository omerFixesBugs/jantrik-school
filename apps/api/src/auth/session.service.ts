import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { withContext, type SessionClient, type SessionRevokeReason } from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { apiError } from '../common/api-error.js';
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

/** How long a second refresh of the same token waits for the first (then 503 REFRESH_BUSY). */
export const REFRESH_LOCK_WAIT_MS = 10_000;
/** The lock expires on its own after this long, should its holder die (longer than the wait). */
export const REFRESH_LOCK_TTL_MS = 15_000;
/** A Redis call on the refresh path that takes longer counts as Redis unavailable (503). */
export const REDIS_TIMEOUT_MS = 2_000;

/** A valid, unused refresh token (SessionService.inspect), ready to be rotated. */
export interface FreshToken {
  tokenId: string;
  sessionId: string;
  userId: string;
}

/** What is stored, encrypted, for retries of a rotated token. */
interface SealedAnswer {
  v: 2;
  sessionId: string;
  response: AuthResponse;
}

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
const lockKey = (oldHash: string) => `rt:lock:${oldHash}`;
const invalid = () => new UnauthorizedException('Invalid credentials');
/** Deletes the lock only if this holder still has it. */
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Login sessions and their rotating refresh tokens. Only SHA-256 hashes of refresh tokens are
 * stored; the raw token exists only in the client (and, encrypted with a key derived from the
 * previous token, for 30 s in Redis to answer retries).
 */
@Injectable()
export class SessionService {
  /** How long a second refresh of the same token waits for the lock (tests shorten it). */
  refreshLockWaitMs = REFRESH_LOCK_WAIT_MS;
  /** How long a Redis call on the refresh path may take (tests shorten it). */
  redisTimeoutMs = REDIS_TIMEOUT_MS;

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
    const refreshToken = newRefreshToken();
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
   * Runs `fn` holding the presented token's lock, so two refreshes of one token never overlap:
   * the second waits until the first has stored its answer, then sees it as a retry. Waits up to
   * `refreshLockWaitMs`, then 503 REFRESH_BUSY; Redis failing or silent gives 503
   * REFRESH_UNAVAILABLE. Neither changes anything (docs/auth.md → Tokens and sessions).
   */
  async withRefreshLock<T>(rawToken: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(sha256(rawToken));
    const holder = randomBytes(16).toString('hex');
    const deadline = Date.now() + this.refreshLockWaitMs;
    for (;;) {
      const taken = await this.redisCall(() =>
        this.redis.set(key, holder, 'PX', REFRESH_LOCK_TTL_MS, 'NX'),
      );
      if (taken === 'OK') break;
      if (Date.now() >= deadline) {
        throw apiError(503, 'REFRESH_BUSY', 'Another refresh of this session is in progress');
      }
      await sleep(25);
    }
    try {
      return await fn();
    } finally {
      // Only our own lock; a failure here leaves it to expire (REFRESH_LOCK_TTL_MS).
      await this.redisCall(() => this.redis.eval(RELEASE_LOCK, 1, key, holder)).catch(
        () => undefined,
      );
    }
  }

  /**
   * What a presented refresh token is (call it holding the token's lock):
   * - valid and unused → `fresh`;
   * - rotated within 30 s, its stored answer readable with it and naming its session, and the
   *   replacement unused → `retry`, the same answer again;
   * - any other rotated token → REUSE: the whole session is revoked (401);
   * - unknown, revoked or expired → 401.
   */
  async inspect(
    rawToken: string,
  ): Promise<{ kind: 'fresh'; token: FreshToken } | { kind: 'retry'; response: AuthResponse }> {
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
    return {
      kind: 'fresh',
      token: { tokenId: row.token_id, sessionId: row.session_id, userId: row.user_id },
    };
  }

  /**
   * Rotates a fresh token to `newRefreshToken` (after its answer was stored). False when the token
   * was rotated meanwhile, which the lock prevents for every refresh; 401 then, no revocation.
   */
  async commitRotation(
    token: FreshToken,
    newRefreshToken: string,
    meta: SessionMeta,
    opts: { clearActiveTenant: boolean },
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = inSeconds(REFRESH_TTL_SEC);
    return withContext(this.prisma.client, { userId: token.userId }, async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: token.tokenId, rotatedAt: null },
        data: { rotatedAt: now },
      });
      if (count === 0) return false;
      await tx.refreshToken.create({
        data: {
          userId: token.userId,
          sessionId: token.sessionId,
          tokenHash: sha256(newRefreshToken),
          expiresAt,
        },
      });
      await tx.session.update({
        where: { id: token.sessionId },
        data: {
          lastUsedAt: now,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
          // Tenant suspended or membership removed since: continue without a tenant.
          ...(opts.clearActiveTenant ? { activeTenantId: null } : {}),
        },
      });
      return true;
    });
  }

  /** The tenant a fresh token's session had selected (read as its user). */
  async activeTenantOf(token: FreshToken): Promise<string | null> {
    const s = await withContext(this.prisma.client, { userId: token.userId }, (tx) =>
      tx.session.findUniqueOrThrow({
        where: { id: token.sessionId },
        select: { activeTenantId: true },
      }),
    );
    return s.activeTenantId;
  }

  /**
   * Remember the answer for a token about to be rotated, for retries within the grace window:
   * at most 30 s in Redis, under the old token's hash, encrypted with a key derived from the old
   * token, and naming its session. Stored before the rotation is committed, so a Redis failure
   * here (503) leaves the token unrotated.
   */
  async storeGrace(oldRawToken: string, sessionId: string, response: AuthResponse): Promise<void> {
    const sealed: SealedAnswer = { v: 2, sessionId, response };
    await this.redisCall(() =>
      this.redis.set(
        graceKey(sha256(oldRawToken)),
        encrypt(oldRawToken, JSON.stringify(sealed)),
        'EX',
        REFRESH_GRACE_SEC,
      ),
    );
  }

  /** A Redis call on the refresh path: failing or silent past `redisTimeoutMs` → 503. */
  private async redisCall<T>(op: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Redis did not answer in time')),
        this.redisTimeoutMs,
      );
    });
    try {
      return await Promise.race([op(), timeout]);
    } catch {
      throw apiError(503, 'REFRESH_UNAVAILABLE', 'Sessions are unavailable, try again shortly');
    } finally {
      clearTimeout(timer);
    }
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
    const sealed = await this.redisCall(() => this.redis.get(graceKey(oldHash)));
    if (!sealed) return undefined;
    // Readable only with the presented token (the key is derived from it); anything else (a
    // value copied under this key from another token) is no answer.
    let opened: unknown;
    try {
      opened = JSON.parse(decrypt(rawToken, sealed));
    } catch {
      return undefined;
    }
    const response = answerFor(opened, row.session_id);
    if (!response?.refreshToken) return undefined;

    // The replacement must still be unused and the session alive.
    const replacement = await this.findToken(sha256(response.refreshToken));
    if (!replacement || replacement.rotated_at || replacement.revoked_at) return undefined;
    return response;
  }
}

/** A new opaque refresh token (256 bits). */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The answer in an opened sealed value, if it belongs to `sessionId`. A value written before the
 * answer named its session (the previous release, gone 30 s after the deploy) is the answer
 * itself; it was readable only with the same token.
 */
function answerFor(opened: unknown, sessionId: string): AuthResponse | undefined {
  if (!opened || typeof opened !== 'object') return undefined;
  if ((opened as { v?: unknown }).v === 2) {
    const sealed = opened as SealedAnswer;
    return sealed.sessionId === sessionId ? sealed.response : undefined;
  }
  return opened as AuthResponse;
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
