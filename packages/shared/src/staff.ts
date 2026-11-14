import type { Role } from './auth.js';

// Staff management (OWNER/ADMIN): people with a staff role in the institute.

/** Roles that work in the institute; GUARDIAN/STUDENT memberships are managed elsewhere. */
export const STAFF_ROLE_VALUES = ['OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF'] as const;
export type StaffRole = (typeof STAFF_ROLE_VALUES)[number];
export const isStaffRole = (r: Role): r is StaffRole =>
  (STAFF_ROLE_VALUES as readonly string[]).includes(r);

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
