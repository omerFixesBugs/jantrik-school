import { z } from 'zod';
import { bdPhoneSchema } from './phone-schema.js';
import { STAFF_ROLE_VALUES } from './staff.js';

// The staff API's request schemas, apart from staff.ts so the browser can use the staff roles
// without loading zod (see dates-schema.ts).

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
