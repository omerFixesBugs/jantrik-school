import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Role } from '@jantrik/db';
import {
  NOTICE_LIMITS,
  noticeState,
  type NoticeBoardItem,
  type NoticeDetail,
  type NoticeInput,
  type NoticeManageItem,
  type NoticeReadCounts,
  type NoticeTargetRef,
  type NoticeViewer,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { apiError } from '../common/api-error.js';
import { AuditService } from '../audit/audit.module.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { REDIS } from '../redis/redis.constants.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

/** Staff roles: everyone who works in the institute (not guardians, not students). */
export const STAFF_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF'];

/** The unread count is cached this long per person (P6-I). */
const UNREAD_TTL_SEC = 120;
/** The institute's notice version, bumped after every publish, edit and withdrawal. */
export const noticesVersionKey = (tenantId: string) => `tenant:${tenantId}:notices:ver`;
const unreadKey = (tenantId: string, userId: string, version: string) =>
  `tenant:${tenantId}:user:${userId}:notices:unread:v${version}`;

const NO_ID = '00000000-0000-0000-0000-000000000000';
const BOARD_LIMIT = 200;

const targetSelect = {
  classLevelId: true,
  sectionId: true,
  classLevel: { select: { nameBn: true, nameEn: true } },
  section: { select: { name: true } },
} satisfies Prisma.NoticeTargetSelect;

const manageSelect = {
  id: true,
  title: true,
  body: true,
  audience: true,
  status: true,
  pinned: true,
  publishAt: true,
  expiresAt: true,
  editedAt: true,
  withdrawnAt: true,
  withdrawnReason: true,
  createdAt: true,
  targets: { select: targetSelect, orderBy: { createdAt: 'asc' } },
  _count: { select: { reads: true } },
} satisfies Prisma.NoticeSelect;

/**
 * Notices (sprint 1 P6a, docs/notices.md). OWNER/ADMIN write them (S20); every member reads the
 * board. Visibility is computed when read from status, publish_at and expires_at (P6-A), with the
 * rule of `noticeVisibleTo` (@jantrik/shared) applied in SQL. Never deleted: withdrawn.
 */
@Injectable()
export class NoticesService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly access: TenantAccessService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ── Who is asking ─────────────────────────────────────────────────────────────────────────

  private me(): { tenantId: string; userId: string } {
    const principal = this.context.principal;
    if (!principal) throw new NotFoundException();
    return { tenantId: this.context.requireTenantId(), userId: principal.userId };
  }

  /** Staff role here; guardian with current-year children (ACTIVE, not deleted). */
  async viewer(): Promise<NoticeViewer> {
    const { tenantId, userId } = this.me();
    const roles = await this.access.getRoles(tenantId, userId);
    const staff = roles.some((r) => STAFF_ROLES.includes(r));
    const guardian = roles.includes('GUARDIAN');
    if (!guardian) return { staff, guardian, children: [] };
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const enrolments = await tx.enrolment.findMany({
      where: {
        academicYearId: year?.id ?? NO_ID,
        student: {
          deletedAt: null,
          status: 'ACTIVE',
          guardians: { some: { guardian: { userId } } },
        },
      },
      select: { classLevelId: true, sectionId: true },
    });
    return { staff, guardian, children: enrolments };
  }

  /** The SQL form of `noticeVisibleTo` (review focus 5). */
  private visibleWhere(viewer: NoticeViewer, now: Date): Prisma.NoticeWhereInput {
    const who: Prisma.NoticeWhereInput[] = [];
    if (viewer.staff) who.push({ audience: { in: ['ALL', 'STAFF'] } });
    if (viewer.guardian) {
      const matches: Prisma.NoticeTargetWhereInput[] = viewer.children.map((c) => ({
        classLevelId: c.classLevelId,
        OR: [{ sectionId: null }, ...(c.sectionId ? [{ sectionId: c.sectionId }] : [])],
      }));
      who.push({
        audience: { in: ['ALL', 'GUARDIANS'] },
        OR: [
          { targets: { none: {} } },
          ...(matches.length ? [{ targets: { some: { OR: matches } } }] : []),
        ],
      });
    }
    return {
      status: 'PUBLISHED',
      publishAt: { lte: now },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: who.length ? who : [{ id: NO_ID }] },
      ],
    };
  }

  // ── The board (every member) ──────────────────────────────────────────────────────────────

  async board(): Promise<NoticeBoardItem[]> {
    const { userId } = this.me();
    const now = this.clock.now();
    const rows = await this.db.tx.notice.findMany({
      where: this.visibleWhere(await this.viewer(), now),
      orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }, { id: 'desc' }],
      take: BOARD_LIMIT,
      select: {
        id: true,
        title: true,
        body: true,
        audience: true,
        pinned: true,
        publishAt: true,
        expiresAt: true,
        editedAt: true,
        reads: { where: { userId }, select: { id: true } },
      },
    });
    return rows.map(({ body, reads, ...n }) => ({
      ...this.cardOf(n),
      excerpt: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      read: reads.length > 0,
    }));
  }

  async detail(id: string): Promise<NoticeDetail> {
    const { userId } = this.me();
    const n = await this.db.tx.notice.findFirst({
      where: { id, ...this.visibleWhere(await this.viewer(), this.clock.now()) },
      select: {
        id: true,
        title: true,
        body: true,
        audience: true,
        pinned: true,
        publishAt: true,
        expiresAt: true,
        editedAt: true,
        reads: { where: { userId }, select: { id: true } },
      },
    });
    if (!n) throw new NotFoundException('Notice not found');
    const { reads, body, ...rest } = n;
    return { ...this.cardOf(rest), body, read: reads.length > 0 };
  }

  private cardOf(n: {
    id: string;
    title: string;
    audience: NoticeBoardItem['audience'];
    pinned: boolean;
    publishAt: Date | null;
    expiresAt: Date | null;
    editedAt: Date | null;
  }) {
    return {
      id: n.id,
      title: n.title,
      audience: n.audience,
      pinned: n.pinned,
      publishAt: (n.publishAt ?? new Date(0)).toISOString(),
      expiresAt: n.expiresAt?.toISOString() ?? null,
      edited: n.editedAt !== null,
    };
  }

  /** Marks a visible notice read by the caller (idempotent); their unread count drops. */
  async markRead(id: string): Promise<void> {
    const { tenantId, userId } = this.me();
    const visible = await this.db.tx.notice.count({
      where: { id, ...this.visibleWhere(await this.viewer(), this.clock.now()) },
    });
    if (!visible) throw new NotFoundException('Notice not found');
    const { count } = await this.db.tx.noticeRead.createMany({
      data: [{ tenantId, noticeId: id, userId }],
      skipDuplicates: true,
    });
    if (count > 0) {
      await this.context.afterCommit(async () => {
        const version = (await this.redis.get(noticesVersionKey(tenantId))) ?? '0';
        await this.redis.del(unreadKey(tenantId, userId, version));
      });
    }
  }

  /** Visible notices the caller has not opened; cached per person under the notice version. */
  async unreadCount(): Promise<{ count: number }> {
    const { tenantId, userId } = this.me();
    // Version first: a count that raced a publish is cached under the old version, never read.
    const version = (await this.redis.get(noticesVersionKey(tenantId))) ?? '0';
    const key = unreadKey(tenantId, userId, version);
    const hit = await this.redis.get(key);
    if (hit !== null) return { count: Number(hit) };
    const count = await this.db.tx.notice.count({
      where: {
        ...this.visibleWhere(await this.viewer(), this.clock.now()),
        reads: { none: { userId } },
      },
    });
    await this.redis.set(key, String(count), 'EX', UNREAD_TTL_SEC);
    return { count };
  }

  // ── Management (OWNER/ADMIN) ──────────────────────────────────────────────────────────────

  private manageItem(
    n: Prisma.NoticeGetPayload<{ select: typeof manageSelect }>,
  ): NoticeManageItem {
    return {
      id: n.id,
      title: n.title,
      body: n.body,
      audience: n.audience,
      status: n.status,
      state: noticeState(n, this.clock.now()),
      pinned: n.pinned,
      publishAt: n.publishAt?.toISOString() ?? null,
      expiresAt: n.expiresAt?.toISOString() ?? null,
      editedAt: n.editedAt?.toISOString() ?? null,
      withdrawnAt: n.withdrawnAt?.toISOString() ?? null,
      withdrawnReason: n.withdrawnReason,
      targets: n.targets.map((t) => ({
        classLevelId: t.classLevelId,
        sectionId: t.sectionId,
        classNameBn: t.classLevel.nameBn,
        classNameEn: t.classLevel.nameEn,
        sectionName: t.section?.name ?? null,
      })),
      readCount: n._count.reads,
      createdAt: n.createdAt.toISOString(),
    };
  }

  async manageList(): Promise<NoticeManageItem[]> {
    const rows = await this.db.tx.notice.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: manageSelect,
    });
    return rows.map((n) => this.manageItem(n));
  }

  async manageOne(id: string): Promise<NoticeManageItem> {
    const n = await this.db.tx.notice.findFirst({ where: { id }, select: manageSelect });
    if (!n) throw new NotFoundException('Notice not found');
    return this.manageItem(n);
  }

  /**
   * Targets narrow only the guardians part (P6-G): a STAFF notice takes none. Each must be one of
   * the institute's classes, or a current-year section of that class (422 TARGET_INVALID).
   */
  private async checkTargets(audience: NoticeInput['audience'], targets: NoticeTargetRef[]) {
    if (!targets.length) return [];
    if (audience === 'STAFF') {
      throw apiError(422, 'TARGET_INVALID', 'A notice for staff takes no class targets');
    }
    const unique = [
      ...new Map(targets.map((t) => [`${t.classLevelId}|${t.sectionId ?? ''}`, t])).values(),
    ];
    const classIds = [...new Set(unique.map((t) => t.classLevelId))];
    const sectionIds = [...new Set(unique.flatMap((t) => (t.sectionId ? [t.sectionId] : [])))];
    const [classes, sections] = await Promise.all([
      this.db.tx.classLevel.findMany({ where: { id: { in: classIds } }, select: { id: true } }),
      sectionIds.length
        ? this.db.tx.section.findMany({
            where: { id: { in: sectionIds }, academicYear: { isCurrent: true } },
            select: { id: true, classLevelId: true },
          })
        : [],
    ]);
    const classOk = new Set(classes.map((c) => c.id));
    const sectionClass = new Map(sections.map((s) => [s.id, s.classLevelId]));
    for (const t of unique) {
      const ok =
        classOk.has(t.classLevelId) &&
        (t.sectionId === null || sectionClass.get(t.sectionId) === t.classLevelId);
      if (!ok) throw apiError(422, 'TARGET_INVALID', 'A target is not a class or section here');
    }
    return unique;
  }

  private checkExpiry(expiresAt: Date | null, publishAt: Date | null, changed: boolean) {
    if (!expiresAt) return;
    const after = publishAt ?? this.clock.now();
    if ((changed && expiresAt <= this.clock.now()) || expiresAt <= after) {
      throw apiError(422, 'EXPIRY_INVALID', 'The expiry must be after the notice is published');
    }
  }

  private auditValues(input: NoticeInput, targets: NoticeTargetRef[]): Prisma.InputJsonValue {
    return {
      title: input.title,
      audience: input.audience,
      pinned: input.pinned,
      expiresAt: input.expiresAt?.toISOString() ?? null,
      targets: targets.map((t) => ({ classLevelId: t.classLevelId, sectionId: t.sectionId })),
      bodyLength: input.body.length,
    };
  }

  async create(input: NoticeInput): Promise<NoticeManageItem> {
    const { tenantId, userId } = this.me();
    const targets = await this.checkTargets(input.audience, input.targets);
    this.checkExpiry(input.expiresAt, null, true);
    const n = await this.db.tx.notice.create({
      data: {
        tenantId,
        title: input.title,
        body: input.body,
        audience: input.audience,
        expiresAt: input.expiresAt,
        pinned: input.pinned,
        createdById: userId,
      },
      select: { id: true },
    });
    if (targets.length) {
      await this.db.tx.noticeTarget.createMany({
        data: targets.map((t) => ({ tenantId, noticeId: n.id, ...t })),
      });
    }
    await this.audit.record({
      entity: 'notice',
      entityId: n.id,
      action: 'CREATE',
      newValues: this.auditValues(input, targets),
    });
    return this.manageOne(n.id);
  }

  /** Locks the notice row for this transaction (edits, publish and withdraw serialise). */
  private async lock(id: string) {
    const [row] = await this.db.tx.$queryRaw<
      { status: NoticeManageItem['status']; publish_at: Date | null; expires_at: Date | null }[]
    >`SELECT status, publish_at, expires_at FROM public.notices WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Notice not found');
    return row;
  }

  async update(id: string, input: NoticeInput): Promise<NoticeManageItem> {
    const { tenantId } = this.me();
    const before = await this.manageOne(id);
    const row = await this.lock(id);
    if (row.status === 'WITHDRAWN') {
      throw apiError(409, 'NOT_EDITABLE', 'A withdrawn notice cannot be edited');
    }
    const targets = await this.checkTargets(input.audience, input.targets);
    const expiryChanged =
      (input.expiresAt?.getTime() ?? null) !== (row.expires_at?.getTime() ?? null);
    this.checkExpiry(input.expiresAt, row.publish_at, expiryChanged);
    const published = row.status === 'PUBLISHED';
    await this.db.tx.notice.update({
      where: { id },
      data: {
        title: input.title,
        body: input.body,
        audience: input.audience,
        expiresAt: input.expiresAt,
        pinned: input.pinned,
        ...(published ? { editedAt: this.clock.now() } : {}),
      },
      select: { id: true },
    });
    await this.db.tx.noticeTarget.deleteMany({ where: { noticeId: id } });
    if (targets.length) {
      await this.db.tx.noticeTarget.createMany({
        data: targets.map((t) => ({ tenantId, noticeId: id, ...t })),
      });
    }
    await this.audit.record({
      entity: 'notice',
      entityId: id,
      action: 'UPDATE',
      oldValues: {
        title: before.title,
        audience: before.audience,
        pinned: before.pinned,
        expiresAt: before.expiresAt,
        targets: before.targets.map((t) => ({
          classLevelId: t.classLevelId,
          sectionId: t.sectionId,
        })),
        bodyLength: before.body.length,
      },
      newValues: this.auditValues(input, targets),
    });
    if (published) await this.bumpAfterCommit(tenantId);
    return this.manageOne(id);
  }

  /**
   * Publishes now, or later (at most 30 days ahead; 422 SCHEDULE_OUT_OF_RANGE). A draft, or a
   * notice still scheduled (to move its time), may be published; a live or withdrawn one not.
   */
  async publish(id: string, publishAt: Date | null): Promise<NoticeManageItem> {
    const { tenantId, userId } = this.me();
    const now = this.clock.now();
    const row = await this.lock(id);
    const scheduled = row.status === 'PUBLISHED' && row.publish_at !== null && row.publish_at > now;
    if (row.status !== 'DRAFT' && !scheduled) {
      throw apiError(409, 'NOT_EDITABLE', 'Only a draft or a scheduled notice can be published');
    }
    const at = publishAt ?? now;
    const max = now.getTime() + NOTICE_LIMITS.scheduleDays * 86_400_000;
    // A minute of slack for the admin's clock; earlier than that is a mistake, not "now".
    if (at.getTime() < now.getTime() - 60_000 || at.getTime() > max) {
      throw apiError(422, 'SCHEDULE_OUT_OF_RANGE', 'Publish now or within 30 days');
    }
    const effective = at < now ? now : at;
    if (row.expires_at && row.expires_at <= effective) {
      throw apiError(422, 'EXPIRY_INVALID', 'The expiry must be after the notice is published');
    }
    await this.db.tx.notice.update({
      where: { id },
      data: { status: 'PUBLISHED', publishAt: effective, publishedById: userId },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'notice',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: row.status, publishAt: row.publish_at?.toISOString() ?? null },
      newValues: { status: 'PUBLISHED', publishAt: effective.toISOString() },
    });
    await this.bumpAfterCommit(tenantId);
    return this.manageOne(id);
  }

  /** Hides it everywhere; kept for the record (409 NOT_EDITABLE when already withdrawn). */
  async withdraw(id: string, reason: string): Promise<NoticeManageItem> {
    const { tenantId, userId } = this.me();
    const row = await this.lock(id);
    if (row.status === 'WITHDRAWN') {
      throw apiError(409, 'NOT_EDITABLE', 'This notice is already withdrawn');
    }
    const now = this.clock.now();
    await this.db.tx.notice.update({
      where: { id },
      data: {
        status: 'WITHDRAWN',
        withdrawnAt: now,
        withdrawnById: userId,
        withdrawnReason: reason,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'notice',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: row.status },
      newValues: { status: 'WITHDRAWN', withdrawnReason: reason },
    });
    await this.bumpAfterCommit(tenantId);
    return this.manageOne(id);
  }

  /**
   * How many of the audience opened it. Staff: ACTIVE staff members (for ALL/STAFF notices).
   * Guardians: people with a login linked to a current-year ACTIVE child the targets name (for
   * ALL/GUARDIANS notices). A person in both counts in both.
   */
  async readCounts(id: string): Promise<NoticeReadCounts> {
    const n = await this.manageOne(id);
    const tx = this.db.tx;
    const staffIds =
      n.audience === 'GUARDIANS'
        ? []
        : (
            await tx.membership.findMany({
              where: { status: 'ACTIVE', role: { in: [...STAFF_ROLES] } },
              select: { userId: true },
              distinct: ['userId'],
            })
          ).map((m) => m.userId);
    let guardianIds: string[] = [];
    if (n.audience !== 'STAFF') {
      const year = await tx.academicYear.findFirst({
        where: { isCurrent: true },
        select: { id: true },
      });
      const enrolment: Prisma.EnrolmentWhereInput = {
        academicYearId: year?.id ?? NO_ID,
        ...(n.targets.length
          ? {
              OR: n.targets.map((t) => ({
                classLevelId: t.classLevelId,
                ...(t.sectionId ? { sectionId: t.sectionId } : {}),
              })),
            }
          : {}),
      };
      const guardians = await tx.guardian.findMany({
        where: {
          userId: { not: null },
          students: {
            some: {
              student: { deletedAt: null, status: 'ACTIVE', enrolments: { some: enrolment } },
            },
          },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      guardianIds = guardians.flatMap((g) => (g.userId ? [g.userId] : []));
    }
    const readers = new Set(
      (await tx.noticeRead.findMany({ where: { noticeId: id }, select: { userId: true } })).map(
        (r) => r.userId,
      ),
    );
    const count = (ids: string[]) => ids.filter((u) => readers.has(u)).length;
    return {
      staff: { read: count(staffIds), of: staffIds.length },
      guardians: { read: count(guardianIds), of: guardianIds.length },
    };
  }

  private async bumpAfterCommit(tenantId: string): Promise<void> {
    await this.context.afterCommit(async () => {
      await this.redis.incr(noticesVersionKey(tenantId));
    });
  }
}
