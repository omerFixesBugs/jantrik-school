import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withContext, type Role } from '@jantrik/db';
import {
  isStaffRole,
  normalizeBdPhone,
  type AuthClient,
  type AuthResponse,
  type MembershipSummary,
} from '@jantrik/shared';
import { apiError } from '../common/api-error.js';
import type { Principal } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import {
  findUserForPasswordLogin,
  listMemberships,
  listMembershipsFor,
  type LoginUser,
} from './login-lookup.js';
import { LoginPrismaService } from './login-prisma.service.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { newRefreshToken, SessionService, type SessionMeta } from './session.service.js';
import { ACCESS_TOKEN_TTL_SEC, TokenService } from './token.service.js';

const invalidCredentials = () => new UnauthorizedException('Invalid credentials');

type ResponseUser = AuthResponse['user'];

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly login: LoginPrismaService,
    private readonly db: Db,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly access: TenantAccessService,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  requestOtp(phone: string, ip: string): Promise<void> {
    return this.otp.request(phone, ip);
  }

  async loginWithOtp(phone: string, code: string, client: AuthClient, meta: SessionMeta) {
    const user = await this.otp.verify(phone, code, meta.ip ?? 'unknown');
    if (!user) throw invalidCredentials();
    return this.completeLogin(user, client, meta);
  }

  async loginWithPassword(
    identifier: string,
    password: string,
    client: AuthClient,
    meta: SessionMeta,
  ) {
    const phone = normalizeBdPhone(identifier);
    const email = phone ? null : identifier.toLowerCase();
    const accountKey = `login-id:${phone ?? email}`;
    // Counted before the check (race-safe: parallel guesses can't all slip past a read-only
    // check), then cleared on success: in effect only failed attempts count per account.
    // The per-IP counter keeps every attempt.
    await this.limiter.consume(
      {
        key: `login-ip:${meta.ip}`,
        limit: this.config.get('LOGIN_PER_IP_PER_15MIN', { infer: true }),
        windowSec: 900,
      },
      {
        key: accountKey,
        limit: this.config.get('LOGIN_PER_IDENTIFIER_PER_15MIN', { infer: true }),
        windowSec: 900,
      },
    );

    // On the password login's own database login (P1-J): no ordinary request can read a hash.
    const found = await findUserForPasswordLogin(this.login.client, { phone, email });
    // Always verify (against a dummy hash if needed) so timing doesn't reveal unknown accounts.
    const ok = await this.passwords.verify(found?.password_hash, password);
    if (!found || !ok) throw invalidCredentials();
    const user: LoginUser = { id: found.id, name: found.name, locale: found.locale };
    // Passwords are for staff (sprint 1 P1): an active staff membership in an open institute.
    // Anyone else gets the same answer as a wrong password, and it counts as a failed attempt.
    const memberships = await listMembershipsFor(this.prisma.client, user.id);
    if (!memberships.some((m) => m.selectable && m.roles.some(isStaffRole))) {
      throw invalidCredentials();
    }
    await this.limiter.reset(accountKey);
    return this.completeLogin(user, client, meta, memberships);
  }

  /** Users with exactly one selectable tenant are switched into it automatically. */
  private async completeLogin(
    login: LoginUser,
    client: AuthClient,
    meta: SessionMeta,
    memberships?: MembershipSummary[],
  ) {
    // The login lookup (a SECURITY DEFINER function) returns only what checking credentials
    // needs. Profile fields are read afterwards as the user, under the normal users RLS.
    const { nameBn, colorScheme } = await withContext(
      this.prisma.client,
      { userId: login.id },
      (tx) =>
        tx.user.findUniqueOrThrow({
          where: { id: login.id },
          select: { nameBn: true, colorScheme: true },
        }),
    );
    const user: ResponseUser = {
      id: login.id,
      name: login.name,
      nameBn,
      locale: login.locale,
      colorScheme,
    };
    const selectable = (
      memberships ?? (await listMembershipsFor(this.prisma.client, user.id))
    ).filter((m) => m.selectable);
    const active = selectable.length === 1 ? selectable[0] : undefined;
    const { sessionId, refreshToken } = await this.sessions.create({
      userId: user.id,
      client: client === 'web' ? 'WEB' : 'MOBILE',
      activeTenantId: active?.tenant.id ?? null,
      meta,
    });
    return this.buildResponse(user, sessionId, active, refreshToken);
  }

  /**
   * Exchange a refresh token for a new pair (docs/auth.md → Tokens and sessions). Refreshes of one
   * token are serialised by its lock; inside it, in this order:
   * 1. what the token is: a retry gets the stored answer again, reuse revokes the session;
   * 2. a fresh token's whole answer is built (user, memberships, the new tokens);
   * 3. the answer is stored for retries;
   * 4. only then is the rotation committed.
   * A failure at any step before 4 leaves the token unrotated, so the client's retry rotates it
   * normally instead of being taken for reuse. Before step 3 the lock is fenced: if storing and
   * committing could outlast it, the refresh stops there (503) rather than race a second one.
   */
  async refresh(rawToken: string, meta: SessionMeta): Promise<AuthResponse> {
    return this.sessions.withRefreshLock(rawToken, async (lock) => {
      const state = await this.sessions.inspect(rawToken);
      if (state.kind === 'retry') return state.response;

      const { token } = state;
      const userId = token.userId;
      const { user, activeTenantId } = await withContext(
        this.prisma.client,
        { userId },
        async (tx) => ({
          user: await tx.user.findUniqueOrThrow({ where: { id: userId } }),
          activeTenantId: (
            await tx.session.findUniqueOrThrow({
              where: { id: token.sessionId },
              select: { activeTenantId: true },
            })
          ).activeTenantId,
        }),
      );
      let active: MembershipSummary | undefined;
      if (activeTenantId) {
        active = (await listMembershipsFor(this.prisma.client, userId)).find(
          (m) => m.selectable && m.tenant.id === activeTenantId,
        );
      }

      const refreshToken = newRefreshToken();
      const response = await this.buildResponse(
        {
          id: user.id,
          name: user.name,
          nameBn: user.nameBn,
          locale: user.locale,
          colorScheme: user.colorScheme,
        },
        token.sessionId,
        active,
        refreshToken,
      );
      lock.fence();
      // Taken before the store, so the stored answer (30 s from now) outlives the database's
      // 30-second window, which counts from this time.
      const rotatedAt = new Date();
      await this.sessions.storeGrace(rawToken, token.sessionId, response);
      const outcome = await this.sessions.commitRotation(token, refreshToken, meta, {
        rotatedAt,
        // Tenant suspended or membership removed since: continue without a tenant.
        staleTenantId: activeTenantId && !active ? activeTenantId : null,
      });
      if (outcome === 'rotated-meanwhile') {
        // Only a lost lock lets this happen: retryable, never a sign-out.
        throw apiError(503, 'REFRESH_BUSY', 'Another refresh of this session is in progress');
      }
      if (outcome === 'session-revoked') throw new UnauthorizedException('Invalid credentials');
      return response;
    });
  }

  logout(principal: Principal): Promise<void> {
    return this.sessions.revoke(principal.sessionId, principal.userId, 'LOGOUT');
  }

  // ── Authenticated routes: run inside the request transaction (user context only) ──

  async me(principal: Principal) {
    const user = await this.db.tx.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        name: true,
        nameBn: true,
        phone: true,
        email: true,
        locale: true,
        colorScheme: true,
      },
    });
    if (!principal.tenantId) return { user };
    const membership = (await listMemberships(this.db.tx)).find(
      (m) => m.tenant.id === principal.tenantId && m.selectable,
    );
    if (!membership) return { user };
    const roles = await this.access.getRoles(principal.tenantId, principal.userId);
    const { status: _status, ...tenant } = membership.tenant;
    return { user, tenant, roles };
  }

  memberships(): Promise<MembershipSummary[]> {
    return listMemberships(this.db.tx);
  }

  async switchTenant(principal: Principal, tenantId: string) {
    const membership = (await listMemberships(this.db.tx)).find(
      (m) => m.tenant.id === tenantId && m.selectable,
    );
    if (!membership) throw new ForbiddenException('No access to this tenant');

    await this.db.tx.session.update({
      where: { id: principal.sessionId },
      data: { activeTenantId: tenantId },
    });
    const roles = await this.access.getRoles(tenantId, principal.userId);
    const accessToken = await this.tokens.signAccess({
      userId: principal.userId,
      sessionId: principal.sessionId,
      tenantId,
      roles,
    });
    const { status: _status, ...tenant } = membership.tenant;
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SEC, tenant, roles };
  }

  private async buildResponse(
    user: ResponseUser,
    sessionId: string,
    active: MembershipSummary | undefined,
    refreshToken: string,
  ): Promise<AuthResponse> {
    const roles: Role[] | undefined = active?.roles;
    const accessToken = await this.tokens.signAccess({
      userId: user.id,
      sessionId,
      ...(active ? { tenantId: active.tenant.id, roles } : {}),
    });
    const response: AuthResponse = {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      user: {
        id: user.id,
        name: user.name,
        nameBn: user.nameBn,
        locale: user.locale,
        colorScheme: user.colorScheme,
      },
      refreshToken,
    };
    if (active) {
      const { status: _status, ...tenant } = active.tenant;
      response.tenant = tenant;
      response.roles = active.roles;
    }
    return response;
  }
}
