import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ModuleKey, Role } from '@jantrik/db';
import type { Request } from 'express';
import type { Principal } from './request-context.js';

export const IS_PUBLIC = 'jantrik:isPublic';
export const ROLES = 'jantrik:roles';
export const REQUIRED_MODULE = 'jantrik:requiredModule';
export const NO_RATE_LIMIT = 'jantrik:noRateLimit';

/** Route needs no access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller needs at least one of these roles in the selected tenant (checked on every request). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** Route belongs to a product module that must be enabled for the tenant. */
export const RequireModule = (moduleKey: ModuleKey) => SetMetadata(REQUIRED_MODULE, moduleKey);

/** Skip the global per-user / per-IP request limit (e.g. health checks). */
export const NoRateLimit = () => SetMetadata(NO_RATE_LIMIT, true);

/** The authenticated caller. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<Request & { principal?: Principal }>().principal,
);

export const USER_SCOPED = 'jantrik:userScoped';

export const PLATFORM = 'jantrik:platform';

/**
 * A platform route (Jantrik's own admins, /platform/*): the institute token guards skip it and
 * PlatformAuthGuard takes over. `login`: no session needed yet (the two login steps).
 */
export const PlatformRoute = (mode: 'session' | 'login' = 'session') => SetMetadata(PLATFORM, mode);

export const PLATFORM_TX_TIMEOUT = 'jantrik:platform-tx-timeout';
/**
 * A platform route whose request transaction may stay open longer than the default 15 s, e.g.
 * creating an institute (provisioning runs in its own transaction, up to 30 s, while the platform
 * transaction waits to record the plan and the audit entry).
 */
export const PlatformTxTimeout = (ms: number) => SetMetadata(PLATFORM_TX_TIMEOUT, ms);

/**
 * Run the request transaction with the user context only, ignoring the token's tenant.
 * For account-level routes (/auth/*) that must keep working even if the tenant is suspended.
 */
export const UserScoped = () => SetMetadata(USER_SCOPED, true);
