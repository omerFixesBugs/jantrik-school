import { z } from 'zod';
import { bdPhoneSchema } from './phone.js';

/**
 * Which client is logging in. `web` gets the refresh token as an httpOnly cookie,
 * `mobile` gets it in the response body.
 */
export const authClientSchema = z.enum(['web', 'mobile']);
export type AuthClient = z.infer<typeof authClientSchema>;

export const otpRequestSchema = z.object({
  phone: bdPhoneSchema,
});

export const otpVerifySchema = z.object({
  phone: bdPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  client: authClientSchema.default('web'),
});

export const passwordLoginSchema = z.object({
  /** Phone (any common BD format) or email. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  client: authClientSchema.default('web'),
});

export const refreshSchema = z.object({
  /** Mobile only; web sends the httpOnly cookie instead. */
  refreshToken: z.string().min(20).max(200).optional(),
});

export const switchTenantSchema = z.object({
  tenantId: z.uuid(),
});

export const ROLES = [
  'OWNER',
  'ADMIN',
  'TEACHER',
  'ACCOUNTANT',
  'STAFF',
  'GUARDIAN',
  'STUDENT',
] as const;
export type Role = (typeof ROLES)[number];

export interface AuthTenant {
  id: string;
  slug: string;
  name: string;
}

export interface AuthResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** `nameBn`: the name in Bangla script, for the Bangla UI (falls back to `name`). */
  user: { id: string; name: string; nameBn: string | null; locale: 'bn' | 'en' };
  /** Present when the session has a selected tenant. */
  tenant?: AuthTenant;
  /** Roles in `tenant`. A UI hint only — the API re-checks roles on every request. */
  roles?: Role[];
  /** Mobile clients only. */
  refreshToken?: string;
}

export interface MembershipSummary {
  tenant: AuthTenant & { status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' };
  roles: Role[];
  /** Membership active and tenant ACTIVE or TRIAL. */
  selectable: boolean;
  /** A pending (not expired) invitation to staff roles here: accept or decline. */
  invitation: { roles: Role[]; expiresAt: string } | null;
}

/** Invitations expire this many days after they were sent (or re-sent). */
export const INVITATION_DAYS = 14;

/** GET /me/invitations: the caller's pending staff invitations. */
export interface StaffInvitation {
  tenant: { id: string; name: string };
  roles: Role[];
  invitedAt: string;
  expiresAt: string;
}
