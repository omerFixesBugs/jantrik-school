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
import { findOrCreateUser, type Role } from '@jantrik/db';
import {
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
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

class AddStaffDto extends zodDto(addStaffSchema) {}
class StaffRolesDto extends zodDto(staffRolesSchema) {}
class StaffSectionsDto extends zodDto(staffSectionsSchema) {}

const STAFF = [...STAFF_ROLE_VALUES] as Role[];
/** Roles that may be given a section to teach (same as attendance's section teachers). */
const TEACHING: StaffRole[] = ['OWNER', 'ADMIN', 'TEACHER'];

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

  async add(input: { phone: string; name: string; nameBn: string | null; roles: StaffRole[] }) {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    if (input.roles.includes('OWNER')) requireOwner(await this.lockOwners(), this.me.userId);
    const userId = await findOrCreateUser(tx, input.phone, input.name, input.nameBn);
    const existing = await tx.membership.findMany({
      where: { userId, role: { in: STAFF } },
      select: { status: true },
    });
    if (existing.length > 0) {
      throw apiError(409, 'ALREADY_STAFF', 'This person is already staff here', {
        userId,
        status: existing[0]!.status,
      });
    }
    await tx.membership.createMany({
      data: input.roles.map((role) => ({ tenantId, userId, role })),
    });
    // Visible now that they have a membership here. created_at equals now() (at its stored
    // precision) only for a person inserted by this transaction.
    const [fresh] = await tx.$queryRaw<{ created: boolean }[]>`
      SELECT created_at = now()::timestamptz(3) AS created FROM users WHERE id = ${userId}::uuid`;
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'CREATE',
      newValues: {
        roles: input.roles,
        status: 'ACTIVE',
        phone: input.phone,
        // false: an existing person (e.g. a guardian here, or known to another institute) was linked.
        newPerson: fresh?.created ?? false,
      },
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
    return this.member(userId);
  }

  async setRoles(userId: string, roles: StaffRole[]): Promise<StaffMember> {
    const tx = this.db.tx;
    const { tenantId } = this.me;
    this.assertNotSelf(userId);
    const owners = await this.lockOwners();
    const current = await this.lockStaffRows(userId);
    const before = current.map((m) => m.role as StaffRole);
    if (before.includes('OWNER') || roles.includes('OWNER')) requireOwner(owners, this.me.userId);
    const status = current.some((m) => m.status === 'ACTIVE') ? 'ACTIVE' : 'DISABLED';
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
        data: added.map((role) => ({ tenantId, userId, role, status })),
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
    const before = current.some((m) => m.status === 'ACTIVE') ? 'ACTIVE' : 'DISABLED';
    if (current.every((m) => m.status === status)) return this.member(userId);
    if (status === 'DISABLED' && roles.includes('OWNER')) assertNotLastOwner(owners, userId);
    await tx.membership.updateMany({ where: { userId, role: { in: STAFF } }, data: { status } });
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
    const rows = await this.db.tx.$queryRaw<{ role: Role; status: 'ACTIVE' | 'DISABLED' }[]>`
      SELECT role::text AS role, status::text AS status FROM memberships
      WHERE user_id = ${userId}::uuid AND role::text = ANY(${STAFF as string[]})
      ORDER BY id
      FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Staff member not found');
    return rows;
  }

  private async member(userId: string): Promise<StaffMember> {
    const [m] = await this.members([userId]);
    if (!m) throw new NotFoundException('Staff member not found');
    return m;
  }

  private async members(userIds: string[]): Promise<StaffMember[]> {
    if (userIds.length === 0) return [];
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        nameBn: true,
        phone: true,
        memberships: {
          where: { role: { in: STAFF } },
          select: { role: true, status: true, createdAt: true },
        },
      },
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
    return users
      .filter((u) => u.memberships.length > 0)
      .map((u) => {
        const roles = u.memberships.map((m) => m.role).filter(isStaffRole);
        return {
          userId: u.id,
          name: u.name,
          nameBn: u.nameBn,
          phone: u.phone,
          roles: STAFF_ROLE_VALUES.filter((r) => roles.includes(r)),
          status: u.memberships.some((m) => m.status === 'ACTIVE') ? 'ACTIVE' : 'DISABLED',
          isSelf: u.id === this.me.userId,
          sections: teaching
            .filter((t) => t.userId === u.id)
            .map((t) => ({ ...t.section, isClassTeacher: t.isClassTeacher })),
          since: u.memberships
            .map((m) => m.createdAt)
            .sort((a, b) => a.getTime() - b.getTime())[0]!
            .toISOString(),
        } satisfies StaffMember;
      });
  }
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

  @Put(':userId/sections')
  setSections(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: StaffSectionsDto,
  ): Promise<StaffMember> {
    return this.staff.setSections(userId, dto.sectionIds);
  }
}

@Module({ controllers: [StaffController], providers: [StaffService] })
export class StaffModule {}
