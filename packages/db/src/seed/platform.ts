import { hash } from '@node-rs/argon2';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DEMO_STAFF_PASSWORD } from './demo.js';

/** The development platform admin (docs/demo-accounts.md). Production uses `pnpm platform:admin`. */
export const DEV_PLATFORM_ADMIN = {
  name: 'Jantrik Platform (dev)',
  phone: '+8801700000001',
  email: 'platform@jantrik.local',
};

/**
 * As the owner role (platform tables have no app grants). No authenticator yet: the first
 * login at /platform/login sets it up (QR code), within 30 days (development). Re-seeding keeps
 * an existing enrolment, and reopens the window while it is not set up.
 */
export async function seedPlatformAdmin(owner: PrismaClient): Promise<void> {
  const enrolBy = new Date(Date.now() + 30 * 86_400_000);
  const existing = await owner.platformAdmin.findUnique({
    where: { phone: DEV_PLATFORM_ADMIN.phone },
  });
  if (existing) {
    if (!existing.totpSecret) {
      await owner.platformAdmin.update({
        where: { id: existing.id },
        data: { totpEnrolBy: enrolBy },
      });
    }
    return;
  }
  await owner.$transaction(async (tx) => {
    const admin = await tx.platformAdmin.create({
      data: {
        ...DEV_PLATFORM_ADMIN,
        passwordHash: await hash(DEMO_STAFF_PASSWORD),
        totpEnrolBy: enrolBy,
      },
    });
    await tx.platformAuditLog.create({
      data: {
        actor: 'CLI',
        action: 'ADMIN_CREATE',
        entity: 'platform_admin',
        entityId: admin.id,
        details: { phone: admin.phone, name: admin.name, via: 'seed' },
      },
    });
  });
}
