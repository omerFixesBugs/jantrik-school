import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  findOrCreateUser,
  provisionTenant,
  withTenant,
  type ModuleKey,
  type TenantTx,
} from '@jantrik/db';
import { INVITATION_DAYS, type IsoDate } from '@jantrik/shared';
import { apiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantAccessService } from './tenant-access.service.js';

const INVITE_MS = INVITATION_DAYS * 24 * 3600 * 1000;
/** pg_advisory_xact_lock class for the platform's owner changes (with hashtext(tenant id)). */
const OWNER_LOCK = 4202;

export interface NewInstitute {
  name: string;
  slug: string;
  instituteTypeKey: string;
  modules: ModuleKey[];
  academicYear: { name: string; startDate: IsoDate; endDate: IsoDate };
  owner: OwnerInput;
}

export interface OwnerInput {
  phone: string;
  name: string;
  nameBn: string | null;
}

/**
 * Platform actions that write inside an institute: creating one (the template copy, the owner's
 * invitation, the institute's own audit entry) and managing that owner invitation. They run as
 * the API's main role in the institute's own RLS context, in one transaction each; the platform
 * login cannot (it reaches only the platform functions). The caller (src/platform) records the
 * platform side after this commits. Audit entries here have no actor (a platform admin is not an
 * institute user) and name the platform admin instead.
 */
@Injectable()
export class InstituteProvisioning {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TenantAccessService,
  ) {}

  /**
   * A new TRIAL institute with an OWNER invitation (14 days) and its setup wizard (part 5).
   * 409 SLUG_TAKEN on a clash.
   */
  async create(input: NewInstitute, platformAdminId: string): Promise<{ tenantId: string }> {
    try {
      const tenant = await provisionTenant(
        this.prisma.client,
        {
          slug: input.slug,
          name: input.name,
          instituteTypeKey: input.instituteTypeKey,
          modules: input.modules,
          status: 'TRIAL',
          academicYear: {
            name: input.academicYear.name,
            startDate: new Date(`${input.academicYear.startDate}T00:00:00Z`),
            endDate: new Date(`${input.academicYear.endDate}T00:00:00Z`),
          },
        },
        async (tx, { id: tenantId }) => {
          await this.inviteOwnerTx(tx, tenantId, input.owner);
          await tx.onboardingProgress.create({ data: { tenantId }, select: { id: true } });
          await tx.auditLog.create({
            data: {
              tenantId,
              actorUserId: null,
              entity: 'tenant',
              entityId: tenantId,
              action: 'CREATE',
              newValues: {
                via: 'platform',
                platformAdminId,
                name: input.name,
                slug: input.slug,
                instituteType: input.instituteTypeKey,
                modules: input.modules,
                owner: { name: input.owner.name, phone: input.owner.phone },
              },
            },
            select: { id: true },
          });
        },
      );
      return { tenantId: tenant.id };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        JSON.stringify(error.meta ?? {}).includes('slug')
      ) {
        throw apiError(409, 'SLUG_TAKEN', 'Another institute already uses this name in links', {
          field: 'slug',
        });
      }
      if (error instanceof Error && /Unknown or inactive institute type/.test(error.message)) {
        throw apiError(422, 'UNKNOWN_INSTITUTE_TYPE', 'Unknown institute type', {
          field: 'instituteTypeKey',
        });
      }
      throw error;
    }
  }

  /**
   * Invite an owner to an institute that has none (no active owner, no pending invitation):
   * e.g. after cancelling one sent to a wrong number.
   */
  async inviteOwner(
    tenantId: string,
    owner: OwnerInput,
    platformAdminId: string,
  ): Promise<{ userId: string }> {
    const userId = await this.inTenant(tenantId, async (tx) => {
      const owners = await this.lockOwnerRows(tx);
      const now = Date.now();
      if (owners.some((o) => o.status === 'ACTIVE')) {
        throw apiError(409, 'INSTITUTE_HAS_OWNER', 'The institute already has an active owner');
      }
      if (owners.some((o) => o.status === 'INVITED' && sentAt(o) + INVITE_MS > now)) {
        throw apiError(409, 'OWNER_INVITED', 'An owner invitation is already pending');
      }
      const id = await this.inviteOwnerTx(tx, tenantId, owner);
      await this.auditOwner(tx, tenantId, id, platformAdminId, null, {
        status: 'INVITED',
        name: owner.name,
        phone: owner.phone,
      });
      return id;
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
    return { userId };
  }

  /** Send an expired or declined owner invitation again (14 more days). */
  async resendOwnerInvitation(
    tenantId: string,
    userId: string,
    platformAdminId: string,
  ): Promise<void> {
    await this.inTenant(tenantId, async (tx) => {
      const owners = await this.lockOwnerRows(tx);
      if (owners.some((o) => o.status === 'ACTIVE')) {
        throw apiError(409, 'INSTITUTE_HAS_OWNER', 'The institute already has an active owner');
      }
      const row = owners.find((o) => o.user_id === userId);
      if (!row) throw new NotFoundException('No owner invitation for this person');
      const now = Date.now();
      const expired = row.status === 'INVITED' && sentAt(row) + INVITE_MS <= now;
      if (row.status !== 'DECLINED' && !expired) {
        throw apiError(409, 'NOT_REINVITABLE', 'Only a declined or expired invitation');
      }
      // One pending owner invitation at a time.
      if (
        owners.some(
          (o) => o.user_id !== userId && o.status === 'INVITED' && sentAt(o) + INVITE_MS > now,
        )
      ) {
        throw apiError(409, 'OWNER_INVITED', 'Another owner invitation is pending');
      }
      await tx.membership.updateMany({
        where: { userId, role: 'OWNER' },
        data: { status: 'INVITED', invitedAt: new Date() },
      });
      await this.auditOwner(
        tx,
        tenantId,
        userId,
        platformAdminId,
        { status: expired ? 'EXPIRED' : 'DECLINED' },
        { status: 'INVITED', reason: 'reinvite' },
      );
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
  }

  /** Withdraw a pending owner invitation (e.g. a wrong number). */
  async cancelOwnerInvitation(
    tenantId: string,
    userId: string,
    platformAdminId: string,
  ): Promise<void> {
    await this.inTenant(tenantId, async (tx) => {
      const owners = await this.lockOwnerRows(tx);
      // With an active owner, the institute manages its owners (and their invitations) itself.
      if (owners.some((o) => o.status === 'ACTIVE')) {
        throw apiError(409, 'INSTITUTE_HAS_OWNER', 'The institute already has an active owner');
      }
      const row = owners.find((o) => o.user_id === userId);
      if (!row) throw new NotFoundException('No owner invitation for this person');
      if (row.status !== 'INVITED' && row.status !== 'DECLINED') {
        throw apiError(409, 'NOT_INVITED', 'This owner has accepted; the institute manages them');
      }
      await tx.membership.deleteMany({
        where: { userId, role: 'OWNER', status: { in: ['INVITED', 'DECLINED'] } },
      });
      await this.auditOwner(
        tx,
        tenantId,
        userId,
        platformAdminId,
        { status: row.status },
        { reason: 'invitation_cancelled' },
      );
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
  }

  // ── helpers ──

  /** Find or create the person; an INVITED OWNER membership and the institute's staff profile. */
  private async inviteOwnerTx(tx: TenantTx, tenantId: string, owner: OwnerInput): Promise<string> {
    const userId = await findOrCreateUser(tx, owner.phone, owner.name, owner.nameBn);
    const staff = await tx.membership.findMany({
      where: { userId, role: { notIn: ['GUARDIAN', 'STUDENT'] } },
      select: { role: true, status: true },
    });
    // Old declined/expired owner rows of this person go; any other staff role means the
    // institute already manages them (the platform does not change institute staff).
    if (staff.some((m) => m.role !== 'OWNER')) {
      throw apiError(409, 'ALREADY_STAFF', 'This person is already staff here', {
        field: 'phone',
      });
    }
    await tx.membership.deleteMany({ where: { userId, role: 'OWNER' } });
    await tx.membership.create({
      data: { tenantId, userId, role: 'OWNER', status: 'INVITED', invitedAt: new Date() },
    });
    await tx.staffProfile.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, name: owner.name, nameBn: owner.nameBn, phone: owner.phone },
      update: { name: owner.name, nameBn: owner.nameBn, phone: owner.phone },
    });
    return userId;
  }

  /** Every OWNER row of the institute, locked (the same rows staff changes lock first). */
  private lockOwnerRows(tx: TenantTx) {
    return tx.$queryRaw<{ user_id: string; status: string; invited_at: Date | null }[]>`
      SELECT user_id::text, status::text, invited_at FROM memberships
      WHERE role = 'OWNER'
      ORDER BY id
      FOR UPDATE`;
  }

  private async auditOwner(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    platformAdminId: string,
    oldValues: Prisma.InputJsonValue | null,
    newValues: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: null,
        entity: 'membership',
        entityId: userId,
        action: 'UPDATE',
        oldValues: oldValues ?? undefined,
        newValues: {
          ...newValues,
          roles: ['OWNER'],
          via: 'platform',
          platformAdminId,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  /**
   * Its own transaction in the institute's context; 404 when the institute does not exist. One
   * platform owner change per institute at a time (locking the OWNER rows is not enough when
   * there are none yet).
   */
  private async inTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma.client, tenantId, async (tx) => {
      const found = await tx.tenant.findFirst({ select: { id: true } });
      if (!found) throw new NotFoundException('Institute not found');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OWNER_LOCK}::int, hashtext(${tenantId}))`;
      return fn(tx);
    });
  }
}

const sentAt = (row: { invited_at: Date | null }) => row.invited_at?.getTime() ?? 0;
