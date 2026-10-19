import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { findOrCreateUser, type Role, type TenantTx } from '@jantrik/db';
import {
  INVITATION_DAYS,
  STAFF_ROLE_VALUES,
  addStaffSchema,
  isStaffRole,
  staffRolesSchema,
  staffSectionsSchema,
  type StaffMember,
  type StaffRole,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import type { Env } from '../config/env.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

class AddStaffDto extends zodDto(addStaffSchema) {}
class StaffRolesDto extends zodDto(staffRolesSchema) {}
class StaffSectionsDto extends zodDto(staffSectionsSchema) {}

const STAFF = [...STAFF_ROLE_VALUES] as Role[];
/** Roles that may be given a section to teach (same as attendance's section teachers). */
const TEACHING: StaffRole[] = ['OWNER', 'ADMIN', 'TEACHER'];
const INVITE_MS = INVITATION_DAYS * 24 * 3600 * 1000;
type MembershipStatus = 'ACTIVE' | 'DISABLED' | 'INVITED' | 'DECLINED';

/**
 * Names this institute uses for staff: the staff profile (what its admin typed), else, for staff
 * added before profiles existed, the person's own row (visible only once they are a member).
 * Never shows an invited person's global name: their row is hidden by RLS until they accept.
 */
export async function staffNames(
  tx: TenantTx,
  userIds: string[],
): Promise<Map<string, { name: string; nameBn: string | null }>> {
  const out = new Map<string, { name: string; nameBn: string | null }>();
  if (userIds.length === 0) return out;
  const profiles = await tx.staffProfile.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, name: true, nameBn: true },
  });
  for (const p of profiles) out.set(p.userId, { name: p.name, nameBn: p.nameBn });
  const missing = userIds.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const users = await tx.user.findMany({
      where: { id: { in: missing } },
      select: { id: true, name: true, nameBn: true },
    });
    for (const u of users) out.set(u.id, { name: u.name, nameBn: u.nameBn });
  }
  return out;
}

/**
 * Staff of the current institute. Rules: only an OWNER may change the roles or status of someone
 * who holds (or held) OWNER here, or grant OWNER; the last active OWNER can never be removed or
 * deactivated; nobody changes their own roles or status. Role and status changes lock, in one
 * fixed order, every active OWNER row and then the target's staff rows, and decide on the locked
 * rows, so concurrent requests serialise. Roles are cached for the guards: every change drops
 * the cache after commit. Everything is audited.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly access: TenantAccessService,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get me() {
    const p = this.context.requirePrincipal();
    return { tenantId: p.tenantId!, userId: p.userId };
  }

  async list(): Promise<StaffMember[]> {
    const memberships = await this.db.tx.membership.findMany({
      where: { role: { in: STAFF } },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, role: true, status: true, createdAt: true },
    });
    const ids = [...new Set(memberships.map((m) => m.userId))];
    const members = await this.members(ids);
    return members.sort(
      (a, b) =>
        Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') ||
        rank(a.roles) - rank(b.roles) ||
        a.name.localeCompare(b.name),
    );
  }

  /**
   * Invite someone by phone. The person is found or created, gets INVITED memberships and a staff
   * profile with the typed name/phone; access starts only when they accept (14 days). The response
   * is built only from the typed values, so it is the same whether or not the phone already
   * belonged to someone (user ids are random v4 UUIDs). No SMS. Rate-limited per institute.
   */
  async add(input: {
    phone: string;
    name: string;
    nameBn: string | null;
    roles: StaffRole[];
  }): Promise<StaffMember> {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    await this.rateLimit();
    if (input.roles.includes('OWNER')) requireOwner(await this.lockOwners(), this.me.userId);
    const userId = await findOrCreateUser(tx, input.phone, input.name, input.nameBn);
    const existing = await tx.membership.findMany({
      where: { userId, role: { in: STAFF } },
      select: { id: true, role: true, status: true, invitedAt: true },
    });
    const now = new Date();
    const previous = existing.length > 0 ? statusOf(existing, now) : null;
    if (existing.some((m) => statusOf([m], now) !== 'EXPIRED' && m.status !== 'DECLINED')) {
      throw apiError(409, 'ALREADY_STAFF', 'This person is already staff or invited here');
    }
    // Declined or expired before: this is a new invitation with the roles given now.
    if (existing.length > 0) {
      await tx.membership.deleteMany({ where: { id: { in: existing.map((m) => m.id) } } });
    }
    await tx.membership.createMany({
      data: input.roles.map((role) => ({
        tenantId,
        userId,
        role,
        status: 'INVITED' as const,
        invitedAt: now,
      })),
    });
    await tx.staffProfile.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, name: input.name, nameBn: input.nameBn, phone: input.phone },
      update: { name: input.name, nameBn: input.nameBn, phone: input.phone },
    });
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'CREATE',
      oldValues: previous ? { status: previous, roles: existing.map((m) => m.role) } : undefined,
      newValues: { roles: input.roles, status: 'INVITED', phone: input.phone, name: input.name },
    });
    return {
      userId,
      name: input.name,
      nameBn: input.nameBn,
      phone: input.phone,
      roles: STAFF_ROLE_VALUES.filter((r) => input.roles.includes(r)),
      status: 'INVITED',
      inviteExpiresAt: new Date(now.getTime() + INVITE_MS).toISOString(),
      isSelf: false,
      sections: [],
      since: now.toISOString(),
    };
  }

  /** Send a declined or expired invitation again (14 more days). */
  async reinvite(userId: string): Promise<StaffMember> {
    const tx = this.db.tx;
    this.assertNotSelf(userId);
    await this.rateLimit();
    const owners = await this.lockOwners();
    const current = await this.lockStaffRows(userId);
    const roles = current.map((m) => m.role as StaffRole);
    if (roles.includes('OWNER')) requireOwner(owners, this.me.userId);
    const status = statusOf(current, new Date());
    if (status !== 'DECLINED' && status !== 'EXPIRED') {
      throw apiError(
        409,
        'NOT_REINVITABLE',
        'Only a declined or expired invitation can be sent again',
      );
    }
    await tx.membership.updateMany({
      where: { userId, role: { in: STAFF } },
      data: { status: 'INVITED', invitedAt: new Date() },
    });
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'UPDATE',
      oldValues: { status, roles },
      newValues: { status: 'INVITED', roles, reason: 'reinvite' },
    });
    return this.member(userId);
  }

  /** Withdraw an invitation (e.g. a wrong number): the invited rows are removed. */
  async cancelInvitation(userId: string): Promise<void> {
    const tx = this.db.tx;
    this.assertNotSelf(userId);
    const owners = await this.lockOwners();
    const current = await this.lockStaffRows(userId);
    const roles = current.map((m) => m.role as StaffRole);
    if (roles.includes('OWNER')) requireOwner(owners, this.me.userId);
    const status = statusOf(current, new Date());
    if (status === 'ACTIVE' || status === 'DISABLED') {
      throw apiError(409, 'NOT_INVITED', 'This person is already staff; deactivate them instead');
    }
    await tx.membership.deleteMany({ where: { userId, role: { in: STAFF } } });
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'DELETE',
      oldValues: { status, roles },
      newValues: { reason: 'invitation_cancelled' },
    });
  }

  /** Staff additions and re-invitations per institute and hour. */
  private async rateLimit(): Promise<void> {
    await this.limiter.consume({
      key: `staff-invite:${this.me.tenantId}`,
      limit: this.config.get('STAFF_INVITES_PER_TENANT_PER_HOUR', { infer: true }),
      windowSec: 3600,
    });
  }

  async setRoles(userId: string, roles: StaffRole[]): Promise<StaffMember> {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    this.assertNotSelf(userId);
    const owners = await this.lockOwners();
    const current = await this.lockStaffRows(userId);
    const before = current.map((m) => m.role as StaffRole);
    if (before.includes('OWNER') || roles.includes('OWNER')) requireOwner(owners, this.me.userId);
    // New rows join the person's current state (an invitation stays an invitation).
    const status: MembershipStatus = current.some((m) => m.status === 'ACTIVE')
      ? 'ACTIVE'
      : (current[0]!.status as MembershipStatus);
    const invitedAt = current.find((m) => m.invited_at)?.invited_at ?? null;
    if (before.includes('OWNER') && !roles.includes('OWNER') && status === 'ACTIVE') {
      assertNotLastOwner(owners, userId);
    }
    const removed = before.filter((r) => !roles.includes(r));
    const added = roles.filter((r) => !before.includes(r));
    if (removed.length === 0 && added.length === 0) return this.member(userId);
    if (removed.length > 0) {
      await tx.membership.deleteMany({ where: { userId, role: { in: removed } } });
    }
    if (added.length > 0) {
      await tx.membership.createMany({
        data: added.map((role) => ({ tenantId, userId, role, status, invitedAt })),
      });
    }
    // No longer a teaching role: drop their section assignments.
    if (!roles.some((r) => TEACHING.includes(r)) && before.some((r) => TEACHING.includes(r))) {
      await tx.sectionTeacher.deleteMany({ where: { userId } });
    }
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'UPDATE',
      oldValues: { roles: before },
      newValues: { roles },
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
    return this.member(userId);
  }

  /** Access ends on the person's next request (memberships are re-checked every request). */
  async setStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<StaffMember> {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    this.assertNotSelf(userId);
    const owners = await this.lockOwners();
    const current = await this.lockStaffRows(userId);
    const roles = current.map((m) => m.role as StaffRole);
    if (roles.includes('OWNER')) requireOwner(owners, this.me.userId);
    const before = statusOf(current, new Date());
    if (before !== 'ACTIVE' && before !== 'DISABLED') {
      throw apiError(409, 'NOT_A_MEMBER_YET', 'An invitation: cancel or re-send it instead');
    }
    // Only the member rows; a pending extra role stays pending.
    const memberRows = current.filter((m) => m.status === 'ACTIVE' || m.status === 'DISABLED');
    if (memberRows.every((m) => m.status === status)) return this.member(userId);
    if (status === 'DISABLED' && roles.includes('OWNER')) assertNotLastOwner(owners, userId);
    await tx.membership.updateMany({
      where: { userId, role: { in: STAFF }, status: { in: ['ACTIVE', 'DISABLED'] } },
      data: { status },
    });
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'UPDATE',
      oldValues: { status: before, roles },
      newValues: { status, roles },
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
    return this.member(userId);
  }

  /** Replace the current-year sections this person teaches. */
  async setSections(userId: string, sectionIds: string[]): Promise<StaffMember> {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    const current = await this.staffMemberships(userId);
    const teaches = current.some(
      (m) => m.status === 'ACTIVE' && TEACHING.includes(m.role as StaffRole),
    );
    if (!teaches && sectionIds.length > 0) {
      throw apiError(422, 'NOT_TEACHING', 'Only active teachers or admins can be given sections');
    }
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    if (!year) throw apiError(422, 'NO_CURRENT_YEAR', 'There is no current academic year');
    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds }, academicYearId: year.id, isActive: true },
      select: { id: true },
    });
    if (sections.length !== sectionIds.length) {
      const found = new Set(sections.map((s) => s.id));
      throw apiError(422, 'INVALID_SECTIONS', 'Unknown, inactive or not in the current year', {
        sectionIds: sectionIds.filter((id) => !found.has(id)),
      });
    }
    const before = await tx.sectionTeacher.findMany({
      where: { userId, section: { academicYearId: year.id } },
      select: { sectionId: true, isClassTeacher: true },
    });
    const had = before.map((b) => b.sectionId);
    const remove = had.filter((id) => !sectionIds.includes(id));
    const add = sectionIds.filter((id) => !had.includes(id));
    if (remove.length + add.length === 0) return this.member(userId);
    if (remove.length > 0) {
      await tx.sectionTeacher.deleteMany({ where: { userId, sectionId: { in: remove } } });
    }
    for (const sectionId of add) {
      // The first teacher of a section becomes its class teacher (as in attendance settings);
      // deactivated staff, whose assignments are kept for reactivation, do not count.
      const others = await tx.sectionTeacher.count({
        where: {
          sectionId,
          user: { memberships: { some: { status: 'ACTIVE', role: { in: TEACHING } } } },
        },
      });
      await tx.sectionTeacher.create({
        data: { tenantId, sectionId, userId, isClassTeacher: others === 0 },
      });
    }
    await this.audit.record({
      entity: 'section_teachers',
      entityId: userId,
      action: 'UPDATE',
      oldValues: { sections: before },
      newValues: { sectionIds },
    });
    return this.member(userId);
  }

  // ── helpers ──

  /** The person's staff memberships here (404 when they are not staff of this institute). */
  private async staffMemberships(userId: string) {
    const rows = await this.db.tx.membership.findMany({
      where: { userId, role: { in: STAFF } },
      select: { role: true, status: true },
    });
    if (rows.length === 0) throw new NotFoundException('Staff member not found');
    return rows;
  }

  private assertNotSelf(userId: string): void {
    if (userId === this.me.userId) {
      throw apiError(403, 'SELF_CHANGE', 'You cannot change your own roles or status');
    }
  }

  /** Lock every active OWNER row (always first: one lock order for every change). */
  private async lockOwners(): Promise<string[]> {
    const rows = await this.db.tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id::text FROM memberships
      WHERE role = 'OWNER' AND status = 'ACTIVE'
      ORDER BY id
      FOR UPDATE`;
    return rows.map((r) => r.user_id);
  }

  /** Lock and read the person's staff memberships here (404 when they are not staff). */
  private async lockStaffRows(userId: string) {
    const rows = await this.db.tx.$queryRaw<
      { role: Role; status: MembershipStatus; invited_at: Date | null; invitedAt?: Date | null }[]
    >`
      SELECT role::text AS role, status::text AS status, invited_at FROM memberships
      WHERE user_id = ${userId}::uuid AND role::text = ANY(${STAFF as string[]})
      ORDER BY id
      FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Staff member not found');
    return rows.map((r) => ({ ...r, invitedAt: r.invited_at }));
  }

  private async member(userId: string): Promise<StaffMember> {
    const [m] = await this.members([userId]);
    if (!m) throw new NotFoundException('Staff member not found');
    return m;
  }

  private async members(userIds: string[]): Promise<StaffMember[]> {
    if (userIds.length === 0) return [];
    const tx = this.db.tx;
    const now = new Date();
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const memberships = await tx.membership.findMany({
      where: { userId: { in: userIds }, role: { in: STAFF } },
      select: { userId: true, role: true, status: true, invitedAt: true, createdAt: true },
    });
    const profiles = await tx.staffProfile.findMany({ where: { userId: { in: userIds } } });
    // Global rows are visible (RLS) only for ACTIVE/DISABLED members; used for staff added before
    // staff profiles existed. Invited people are known here only by their profile.
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, nameBn: true, phone: true },
    });
    const teaching = await tx.sectionTeacher.findMany({
      where: {
        userId: { in: userIds },
        section: { academicYearId: year?.id ?? '00000000-0000-0000-0000-000000000000' },
      },
      orderBy: [{ section: { classLevel: { sortOrder: 'asc' } } }, { section: { name: 'asc' } }],
      select: {
        userId: true,
        isClassTeacher: true,
        section: {
          select: {
            id: true,
            name: true,
            classLevel: { select: { id: true, nameBn: true, nameEn: true } },
          },
        },
      },
    });
    return userIds.flatMap((id) => {
      const mine = memberships.filter((m) => m.userId === id);
      if (mine.length === 0) return [];
      const profile = profiles.find((p) => p.userId === id);
      const user = users.find((u) => u.id === id);
      const who = profile ?? user;
      if (!who) return [];
      const status = statusOf(mine, now);
      // A member's roles are their member rows (a pending extra role is not one yet).
      const member = status === 'ACTIVE' || status === 'DISABLED';
      const roles = mine
        .filter((m) => !member || m.status === 'ACTIVE' || m.status === 'DISABLED')
        .map((m) => m.role)
        .filter(isStaffRole);
      const invitedAt = mine.find((m) => m.invitedAt)?.invitedAt ?? null;
      return [
        {
          userId: id,
          name: who.name,
          nameBn: who.nameBn,
          phone: who.phone,
          roles: STAFF_ROLE_VALUES.filter((r) => roles.includes(r)),
          status,
          inviteExpiresAt:
            status === 'INVITED' && invitedAt
              ? new Date(invitedAt.getTime() + INVITE_MS).toISOString()
              : null,
          isSelf: id === this.me.userId,
          sections: teaching
            .filter((t) => t.userId === id)
            .map((t) => ({ ...t.section, isClassTeacher: t.isClassTeacher })),
          since: mine
            .map((m) => m.createdAt)
            .sort((x, y) => x.getTime() - y.getTime())[0]!
            .toISOString(),
        } satisfies StaffMember,
      ];
    });
  }
}

/** One status for a person's staff rows: ACTIVE wins, then DISABLED, then the invitation state. */
function statusOf(
  rows: { status: string; invitedAt?: Date | null }[],
  now: Date,
): StaffMember['status'] {
  if (rows.some((r) => r.status === 'ACTIVE')) return 'ACTIVE';
  if (rows.some((r) => r.status === 'DISABLED')) return 'DISABLED';
  if (rows.some((r) => r.status === 'INVITED')) {
    const sent = Math.max(...rows.map((r) => r.invitedAt?.getTime() ?? 0));
    return sent + INVITE_MS > now.getTime() ? 'INVITED' : 'EXPIRED';
  }
  return 'DECLINED';
}

/** The caller must be among the (locked) active owners. */
function requireOwner(owners: string[], callerId: string): void {
  if (!owners.includes(callerId)) throw new ForbiddenException('Only an owner can change owners');
}

/** Refuse when `userId` is the only active owner (on rows locked by lockOwners). */
function assertNotLastOwner(owners: string[], userId: string): void {
  if (owners.every((o) => o === userId)) {
    throw apiError(409, 'LAST_OWNER', 'The institute must keep at least one active owner');
  }
}

const rank = (roles: StaffRole[]) =>
  Math.min(...roles.map((r) => STAFF_ROLE_VALUES.indexOf(r)), STAFF_ROLE_VALUES.length);

@Controller('staff')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(): Promise<StaffMember[]> {
    return this.staff.list();
  }

  @Post()
  add(@Body() dto: AddStaffDto): Promise<StaffMember> {
    return this.staff.add(dto);
  }

  @Put(':userId/roles')
  setRoles(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: StaffRolesDto,
  ): Promise<StaffMember> {
    return this.staff.setRoles(userId, dto.roles);
  }

  @Post(':userId/deactivate')
  @HttpCode(200)
  deactivate(@Param('userId', ParseUUIDPipe) userId: string): Promise<StaffMember> {
    return this.staff.setStatus(userId, 'DISABLED');
  }

  @Post(':userId/activate')
  @HttpCode(200)
  activate(@Param('userId', ParseUUIDPipe) userId: string): Promise<StaffMember> {
    return this.staff.setStatus(userId, 'ACTIVE');
  }

  @Post(':userId/reinvite')
  @HttpCode(200)
  reinvite(@Param('userId', ParseUUIDPipe) userId: string): Promise<StaffMember> {
    return this.staff.reinvite(userId);
  }

  @Post(':userId/cancel-invitation')
  @HttpCode(204)
  async cancelInvitation(@Param('userId', ParseUUIDPipe) userId: string): Promise<void> {
    await this.staff.cancelInvitation(userId);
  }

  @Put(':userId/sections')
  setSections(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: StaffSectionsDto,
  ): Promise<StaffMember> {
    return this.staff.setSections(userId, dto.sectionIds);
  }
}

@Module({ controllers: [StaffController], providers: [StaffService], exports: [StaffService] })
export class StaffModule {}
