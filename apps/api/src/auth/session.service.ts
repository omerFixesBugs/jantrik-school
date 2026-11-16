import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { withContext, type SessionClient, type SessionRevokeReason } from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { apiError } from '../common/api-error.js';
import { revokedSessionKey } from '../common/revocation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS_CALL_TIMEOUT_MS, withRedisDeadline } from '../redis/redis-deadline.js';
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
export const REDIS_TIMEOUT_MS = REDIS_CALL_TIMEOUT_MS;
/**
 * The rotation's transaction may wait this long for a connection and run this long (Prisma's
 * maxWait and timeout), so a holder knows the latest moment it can still finish inside its lock.
 */
export const COMMIT_TIMEOUT_MS = 3_000;
/** Slack kept between the end of the commit and the lock's expiry. */
const LOCK_MARGIN_MS = 500;

/**
 * Inside the lock: `fence()` throws 503 REFRESH_BUSY when storing the answer and committing could
 * outlast the lock (another refresh could then take it); nothing has been stored or committed yet.
 */
export interface RefreshLock {
  fence(): void;
}

/** How a rotation's commit ended. */
export type CommitOutcome = 'committed' | 'rotated-meanwhile' | 'session-revoked';

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
  /** How long the lock lives (tests shorten it). */
  refreshLockTtlMs = REFRESH_LOCK_TTL_MS;
  /** How long a Redis call on the refresh path may take (tests shorten it). */
  redisTimeoutMs = REDIS_TIMEOUT_MS;
  /** The rotation transaction's limits (tests shorten them). */
  commitTimeoutMs = COMMIT_TIMEOUT_MS;

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
  async withRefreshLock<T>(rawToken: string, fn: (lock: RefreshLock) => Promise<T>): Promise<T> {
    const key = lockKey(sha256(rawToken));
    const holder = randomBytes(16).toString('hex');
    const ttl = this.refreshLockTtlMs;
    const deadline = Date.now() + this.refreshLockWaitMs;
    let sentAt: number;
    for (;;) {
      // The lock counts from before the request was sent: it may have been taken any time after.
      sentAt = performance.now();
      let taken: string | null;
      try {
        taken = await this.redisCall(() => this.redis.set(key, holder, 'PX', ttl, 'NX'));
      } catch (error) {
        // The SET may still be applied later (sent, reply too late): queue the release behind it
        // on the same connection, so such a lock never outlives this request.
        this.release(key, holder);
        throw error;
      }
      if (taken === 'OK') break;
      if (Date.now() >= deadline) {
        throw apiError(503, 'REFRESH_BUSY', 'Another refresh of this session is in progress');
      }
      await sleep(25);
    }
    // Storing the answer and committing can take this long in the worst case.
    const finishing = this.redisTimeoutMs + 2 * this.commitTimeoutMs + LOCK_MARGIN_MS;
    const lock: RefreshLock = {
      fence: () => {
        if (performance.now() - sentAt > ttl - finishing) {
          throw apiError(503, 'REFRESH_BUSY', 'The refresh took too long, try again');
        }
      },
    };
    try {
      return await fn(lock);
    } finally {
      // Sent, not awaited: the answer does not wait for it, and a failure leaves the lock to
      // expire on its own.
      this.release(key, holder);
    }
  }

  /** Deletes the lock if `holder` still has it; never throws, never waits. */
  private release(key: string, holder: string): void {
    void this.redis.eval(RELEASE_LOCK, 1, key, holder).catch(() => undefined);
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
   * Rotates a fresh token to `newRefreshToken`, after its answer was stored, with `rotatedAt`
   * taken before that store (so the stored answer outlives the 30-second window):
   * - `committed`;
   * - `rotated-meanwhile`: the token is already rotated, which only a lost lock allows; nothing
   *   changes (the caller answers 503, never 401);
   * - `session-revoked`: the session was revoked meanwhile (a logout, a reuse); everything is
   *   rolled back (the caller answers 401).
   * `staleTenantId`: clear the session's institute only if it is still this one (one the user can
   * no longer select), so an institute switch made meanwhile stays.
   */
  async commitRotation(
    token: FreshToken,
    newRefreshToken: string,
    meta: SessionMeta,
    opts: { rotatedAt: Date; staleTenantId: string | null },
  ): Promise<CommitOutcome> {
    const now = opts.rotatedAt;
    const expiresAt = inSeconds(REFRESH_TTL_SEC);
    try {
      return await withContext(
        this.prisma.client,
        { userId: token.userId },
        async (tx) => {
          const { count } = await tx.refreshToken.updateMany({
            where: { id: token.tokenId, rotatedAt: null },
            data: { rotatedAt: now },
          });
          if (count === 0) return 'rotated-meanwhile';
          await tx.refreshToken.create({
            data: {
              userId: token.userId,
              sessionId: token.sessionId,
              tokenHash: sha256(newRefreshToken),
              expiresAt,
            },
          });
          const live = await tx.session.updateMany({
            where: { id: token.sessionId, revokedAt: null },
            data: { lastUsedAt: now, expiresAt, ip: meta.ip, userAgent: meta.userAgent },
          });
          if (live.count === 0) throw new SessionRevokedMeanwhile();
          if (opts.staleTenantId) {
            await tx.session.updateMany({
              where: { id: token.sessionId, activeTenantId: opts.staleTenantId },
              data: { activeTenantId: null },
            });
          }
          return 'committed';
        },
        { maxWait: this.commitTimeoutMs, timeout: this.commitTimeoutMs },
      );
    } catch (error) {
      if (error instanceof SessionRevokedMeanwhile) return 'session-revoked';
      throw error;
    }
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
  private redisCall<T>(op: () => Promise<T>): Promise<T> {
    return withRedisDeadline(op, this.redisTimeoutMs, 'REFRESH_UNAVAILABLE');
  }

  async revoke(sessionId: string, userId: string, reason: SessionRevokeReason): Promise<void> {
    await withContext(this.prisma.client, { userId }, (tx) =>
      tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
    );
    // Access tokens of this session stop working immediately, not when they expire. The
    // revocation above stands whatever Redis does; a failure here is a 503, never a hang.
    await this.redisCall(() =>
      this.redis.set(revokedSessionKey(sessionId), '1', 'EX', ACCESS_TOKEN_TTL_SEC),
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

    // The replacement must belong to this session, still be unused, and the session be alive.
    const replacement = await this.findToken(sha256(response.refreshToken));
    if (
      !replacement ||
      replacement.session_id !== row.session_id ||
      replacement.rotated_at ||
      replacement.revoked_at
    ) {
      return undefined;
    }
    return response;
  }
}

/** A new opaque refresh token (256 bits). */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The answer in an opened sealed value, if it is one and names `sessionId`. */
function answerFor(opened: unknown, sessionId: string): AuthResponse | undefined {
  if (!opened || typeof opened !== 'object') return undefined;
  const sealed = opened as Partial<SealedAnswer>;
  return sealed.v === 2 && sealed.sessionId === sessionId ? sealed.response : undefined;
}

/** Thrown inside the rotation's transaction to roll it back: the session was revoked meanwhile. */
class SessionRevokedMeanwhile extends Error {}

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
