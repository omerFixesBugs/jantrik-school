import { z } from 'zod';
import type { Role } from './auth.js';
import { bdPhoneSchema } from './phone.js';

// Staff management (OWNER/ADMIN): people with a staff role in the institute.

/** Roles that work in the institute; GUARDIAN/STUDENT memberships are managed elsewhere. */
export const STAFF_ROLE_VALUES = ['OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF'] as const;
export type StaffRole = (typeof STAFF_ROLE_VALUES)[number];
export const isStaffRole = (r: Role): r is StaffRole =>
  (STAFF_ROLE_VALUES as readonly string[]).includes(r);

const rolesSchema = z
  .array(z.enum(STAFF_ROLE_VALUES))
  .min(1)
  .max(STAFF_ROLE_VALUES.length)
  .refine((r) => new Set(r).size === r.length, 'Duplicate role');

/** POST /staff: find-or-create the person by phone, then give them the roles. No SMS is sent. */
export const addStaffSchema = z.object({
  phone: bdPhoneSchema,
  name: z.string().trim().min(1).max(100),
  nameBn: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v || null),
  roles: rolesSchema,
});
export type AddStaffInput = z.input<typeof addStaffSchema>;

/** PUT /staff/:userId/roles: the full set of staff roles. */
export const staffRolesSchema = z.object({ roles: rolesSchema });

/**
 * POST /me/invitations/:tenantId/accept: the roles the invitee was shown. Accepting fails with
 * 409 INVITATION_CHANGED when the institute changed them meanwhile.
 */
export const acceptInvitationSchema = z.object({ roles: rolesSchema });

/** PUT /staff/:userId/sections: the current-year sections this person teaches. */
export const staffSectionsSchema = z.object({
  sectionIds: z
    .array(z.uuid())
    .max(60)
    .refine((s) => new Set(s).size === s.length, 'Duplicate section'),
});

export interface StaffSection {
  id: string;
  name: string;
  classLevel: { id: string; nameBn: string; nameEn: string };
  isClassTeacher: boolean;
}

export interface StaffMember {
  userId: string;
  name: string;
  nameBn: string | null;
  /** E.164. */
  phone: string;
  roles: StaffRole[];
  /**
   * ACTIVE / DISABLED; INVITED (pending), EXPIRED (invited over 14 days ago) or DECLINED until
   * the person accepts.
   */
  status: 'ACTIVE' | 'DISABLED' | 'INVITED' | 'EXPIRED' | 'DECLINED';
  /** Pending invitation: when it expires. */
  inviteExpiresAt: string | null;
  /** The caller (cannot change their own roles or status). */
  isSelf: boolean;
  /** Current-year sections they teach. */
  sections: StaffSection[];
  since: string;
}
