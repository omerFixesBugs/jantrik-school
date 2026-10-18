import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withContext, type Role } from '@jantrik/db';
import {
  normalizeBdPhone,
  type AuthClient,
  type AuthResponse,
  type MembershipSummary,
} from '@jantrik/shared';
import type { Principal } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import {
  findUserForLogin,
  listMemberships,
  listMembershipsFor,
  type LoginUser,
} from './login-lookup.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionMeta } from './session.service.js';
import { ACCESS_TOKEN_TTL_SEC, TokenService } from './token.service.js';

const invalidCredentials = () => new UnauthorizedException('Invalid credentials');

type ResponseUser = AuthResponse['user'];

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
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

    const user = await findUserForLogin(this.prisma.client, { phone, email });
    // Always verify (against a dummy hash if needed) so timing doesn't reveal unknown accounts.
    const ok = await this.passwords.verify(user?.password_hash, password);
    if (!user || !ok) throw invalidCredentials();
    await this.limiter.reset(accountKey);
    return this.completeLogin(user, client, meta);
  }

  /** Users with exactly one selectable tenant are switched into it automatically. */
  private async completeLogin(login: LoginUser, client: AuthClient, meta: SessionMeta) {
    // The login lookup (a SECURITY DEFINER function) returns only what checking credentials
    // needs. Profile fields are read afterwards as the user, under the normal users RLS.
    const { nameBn } = await withContext(this.prisma.client, { userId: login.id }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: login.id }, select: { nameBn: true } }),
    );
    const user: ResponseUser = { id: login.id, name: login.name, nameBn, locale: login.locale };
    const selectable = (await listMembershipsFor(this.prisma.client, user.id)).filter(
      (m) => m.selectable,
    );
    const active = selectable.length === 1 ? selectable[0] : undefined;
    const { sessionId, refreshToken } = await this.sessions.create({
      userId: user.id,
      client: client === 'web' ? 'WEB' : 'MOBILE',
      activeTenantId: active?.tenant.id ?? null,
      meta,
    });
    return this.buildResponse(user, sessionId, active, refreshToken);
  }

  async refresh(rawToken: string, meta: SessionMeta): Promise<AuthResponse> {
    const result = await this.sessions.rotate(rawToken, meta);
    if (result.kind === 'retry') return result.response;

    const { userId, sessionId, activeTenantId, refreshToken } = result;
    const user = await withContext(this.prisma.client, { userId }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    let active: MembershipSummary | undefined;
    if (activeTenantId) {
      active = (await listMembershipsFor(this.prisma.client, userId)).find(
        (m) => m.selectable && m.tenant.id === activeTenantId,
      );
      // Tenant suspended or membership removed since: continue without a tenant.
      if (!active) await this.sessions.setActiveTenant(sessionId, userId, null);
    }

    const response = await this.buildResponse(
      { id: user.id, name: user.name, nameBn: user.nameBn, locale: user.locale },
      sessionId,
      active,
      refreshToken,
    );
    await this.sessions.storeGrace(rawToken, response);
    return response;
  }

  logout(principal: Principal): Promise<void> {
    return this.sessions.revoke(principal.sessionId, principal.userId, 'LOGOUT');
  }

  // ── Authenticated routes: run inside the request transaction (user context only) ──

  async me(principal: Principal) {
    const user = await this.db.tx.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { id: true, name: true, nameBn: true, phone: true, email: true, locale: true },
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
      user: { id: user.id, name: user.name, nameBn: user.nameBn, locale: user.locale },
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
