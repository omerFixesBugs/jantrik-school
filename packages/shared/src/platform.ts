import { z } from 'zod';

// Platform area (/platform): Jantrik's own staff. Separate login (password + TOTP), separate
// session (an httpOnly cookie), never an institute user. See docs/platform.md.

/** Every platform request sends this as X-Jantrik-Client (CSRF defence with SameSite=Strict). */
export const PLATFORM_CLIENT = 'platform';

/** POST /platform/auth/login: step 1. */
export const platformLoginSchema = z.object({
  /** Phone (any common BD format) or email. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

/** POST /platform/auth/verify: step 2, a 6-digit authenticator code or a backup code. */
export const platformVerifySchema = z.object({
  challengeId: z.string().min(20).max(100),
  code: z.string().trim().min(6).max(12),
});

export interface PlatformLoginResponse {
  challengeId: string;
  /** Only on the first login: set up the authenticator app (QR code of `uri`, or the key). */
  enrol?: { secret: string; uri: string };
}

export interface PlatformAdminInfo {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totpEnabledAt: string | null;
  backupCodesLeft: number;
  /** The session's hard end (8 h after login). */
  sessionExpiresAt: string | null;
}

export interface PlatformVerifyResponse {
  admin: PlatformAdminInfo;
  /** Only right after enrolment: the 10 one-time backup codes, shown once. */
  backupCodes?: string[];
}

export const platformAuditQuerySchema = z.object({
  /** Keyset paging: the last row's createdAt and id. */
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface PlatformAuditEntry {
  id: string;
  createdAt: string;
  actor: 'ADMIN' | 'CLI';
  adminName: string | null;
  action: string;
  targetTenantId: string | null;
  targetTenantName: string | null;
  entity: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}
