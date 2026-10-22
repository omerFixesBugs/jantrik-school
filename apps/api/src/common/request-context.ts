import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { TenantTx } from '@jantrik/db';
import { ClsService, type ClsStore } from 'nestjs-cls';

/** Authenticated caller, from a verified access token. */
export interface Principal {
  userId: string;
  sessionId: string;
  /** Selected tenant, if any. */
  tenantId?: string;
}

/** A signed-in platform admin, from the session cookie (never an institute user). */
export interface PlatformPrincipal {
  adminId: string;
  sessionId: string;
  /** SHA-256 of the session token: the platform functions' context. */
  tokenHash: string;
  name: string;
}

export interface JantrikClsStore extends ClsStore {
  principal?: Principal;
  platform?: PlatformPrincipal;
  /** The request's RLS-scoped transaction (set by TenantContextInterceptor). */
  tx?: TenantTx;
  /** Side effects to run once the request transaction has committed. */
  afterCommit?: (() => unknown | Promise<unknown>)[];
  /** The tenant of a background job (TenantJobRunner), which may run without a person. */
  jobTenantId?: string;
}

/**
 * Per-request state in AsyncLocalStorage (nestjs-cls): the caller, the RLS transaction, and
 * side effects deferred until commit.
 */
@Injectable()
export class RequestContext {
  private readonly logger = new Logger(RequestContext.name);

  constructor(private readonly cls: ClsService<JantrikClsStore>) {}

  get principal(): Principal | undefined {
    return this.cls.isActive() ? this.cls.get('principal') : undefined;
  }

  setPrincipal(principal: Principal): void {
    this.cls.set('principal', principal);
  }

  get platform(): PlatformPrincipal | undefined {
    return this.cls.isActive() ? this.cls.get('platform') : undefined;
  }

  setPlatform(platform: PlatformPrincipal): void {
    this.cls.set('platform', platform);
  }

  requirePlatform(): PlatformPrincipal {
    const platform = this.platform;
    if (!platform) throw new InternalServerErrorException('No platform session');
    return platform;
  }

  requirePrincipal(): Principal {
    const principal = this.principal;
    if (!principal) throw new InternalServerErrorException('No authenticated principal');
    return principal;
  }

  /**
   * The tenant this work belongs to: the caller's selected tenant, or the tenant of a background
   * job (which may run with no person, e.g. the nightly fee dues run).
   */
  requireTenantId(): string {
    const tenantId =
      this.principal?.tenantId ?? (this.cls.isActive() ? this.cls.get('jobTenantId') : undefined);
    if (!tenantId) throw new InternalServerErrorException('No tenant selected');
    return tenantId;
  }

  get tx(): TenantTx | undefined {
    return this.cls.isActive() ? this.cls.get('tx') : undefined;
  }

  /**
   * Run `fn` after the request transaction commits; dropped if it rolls back. Use for anything
   * with an outside effect (queue jobs, SMS, cache invalidation). Outside a request transaction
   * (e.g. public auth routes) it runs immediately.
   */
  async afterCommit(fn: () => unknown | Promise<unknown>): Promise<void> {
    const queue = this.cls.isActive() ? this.cls.get('afterCommit') : undefined;
    if (queue) {
      queue.push(fn);
      return;
    }
    await fn();
  }

  /** Used by TenantContextInterceptor. */
  beginTransaction(tx: TenantTx): void {
    this.cls.set('tx', tx);
    this.cls.set('afterCommit', []);
  }

  /** Used by TenantContextInterceptor: returns queued callbacks and clears request tx state. */
  endTransaction(): (() => unknown | Promise<unknown>)[] {
    const queue = this.cls.get('afterCommit') ?? [];
    this.cls.set('tx', undefined);
    this.cls.set('afterCommit', undefined);
    return queue;
  }

  /** Run committed side effects; a failure is logged, never turned into a failed response. */
  async runAfterCommit(callbacks: (() => unknown | Promise<unknown>)[]): Promise<void> {
    for (const fn of callbacks) {
      try {
        await fn();
      } catch (error) {
        this.logger.error(`afterCommit callback failed: ${(error as Error).message}`);
      }
    }
  }
}
