/**
 * Notices (sprint 1 P6a, docs/notices.md): who sees a notice, and the views the API sends.
 * The rule lives here as a pure function so it is unit-tested once; the API applies the same
 * rule in its query (NoticesService) and both are tested against each other's cases.
 */

export const NOTICE_AUDIENCES = ['ALL', 'STAFF', 'GUARDIANS'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

export const NOTICE_STATUSES = ['DRAFT', 'PUBLISHED', 'WITHDRAWN'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/** What the manage page shows: "scheduled" and "expired" are computed, never stored (P6-A). */
export type NoticeState = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'EXPIRED' | 'WITHDRAWN';

export const NOTICE_LIMITS = {
  title: 150,
  body: 5000,
  withdrawnReason: 300,
  /** Publishing later: at most this many days ahead. */
  scheduleDays: 30,
  /** At most this many class/section targets on one notice. */
  targets: 100,
} as const;

export interface NoticeTargetRef {
  classLevelId: string;
  /** A section of that class, or null for the whole class. */
  sectionId: string | null;
}

/** The fields the visibility rule needs. */
export interface NoticeVisibilityFields {
  status: NoticeStatus;
  audience: NoticeAudience;
  publishAt: Date | string | null;
  expiresAt: Date | string | null;
  targets: NoticeTargetRef[];
}

/**
 * The viewer: `staff` when they hold any staff role in the institute; `children` are the
 * current-year enrolments (class, section) of their ACTIVE, not deleted children when they are a
 * guardian here (empty otherwise). A person with both sees the union.
 */
export interface NoticeViewer {
  staff: boolean;
  guardian: boolean;
  children: { classLevelId: string; sectionId: string | null }[];
}

const time = (d: Date | string | null): number | null =>
  d === null ? null : (d instanceof Date ? d : new Date(d)).getTime();

/** Live on the board: published, its time has come, not expired. */
export function noticeLive(
  n: Pick<NoticeVisibilityFields, 'status' | 'publishAt' | 'expiresAt'>,
  now: Date,
): boolean {
  if (n.status !== 'PUBLISHED') return false;
  const publish = time(n.publishAt);
  if (publish === null || publish > now.getTime()) return false;
  const expires = time(n.expiresAt);
  return expires === null || expires > now.getTime();
}

/**
 * Who sees a notice (review focus 5): staff see ALL and STAFF notices whatever their targets
 * (P6-G); a guardian sees ALL and GUARDIANS notices with no targets, or with a target matching one
 * of their children's class (and section, when the target names one).
 */
export function noticeVisibleTo(
  n: NoticeVisibilityFields,
  viewer: NoticeViewer,
  now: Date,
): boolean {
  if (!noticeLive(n, now)) return false;
  if (viewer.staff && (n.audience === 'ALL' || n.audience === 'STAFF')) return true;
  if (!viewer.guardian || n.audience === 'STAFF') return false;
  if (n.targets.length === 0) return true;
  return n.targets.some((t) =>
    viewer.children.some(
      (c) =>
        c.classLevelId === t.classLevelId && (t.sectionId === null || t.sectionId === c.sectionId),
    ),
  );
}

export function noticeState(
  n: Pick<NoticeVisibilityFields, 'status' | 'publishAt' | 'expiresAt'>,
  now: Date,
): NoticeState {
  if (n.status === 'DRAFT') return 'DRAFT';
  if (n.status === 'WITHDRAWN') return 'WITHDRAWN';
  const publish = time(n.publishAt);
  if (publish !== null && publish > now.getTime()) return 'SCHEDULED';
  const expires = time(n.expiresAt);
  return expires !== null && expires <= now.getTime() ? 'EXPIRED' : 'PUBLISHED';
}

// ── Views (API responses) ──────────────────────────────────────────────────────────────────────

/** A card on the board (GET /notices). */
export interface NoticeBoardItem {
  id: string;
  title: string;
  /** The first 200 characters, for the card. */
  excerpt: string;
  audience: NoticeAudience;
  pinned: boolean;
  publishAt: string;
  expiresAt: string | null;
  edited: boolean;
  read: boolean;
}

/** One notice (GET /notices/:id). */
export interface NoticeDetail extends Omit<NoticeBoardItem, 'excerpt'> {
  body: string;
}

export interface NoticeTargetView extends NoticeTargetRef {
  classNameBn: string | null;
  classNameEn: string | null;
  sectionName: string | null;
}

/** A row of GET /notices/manage, and the edit form's data (GET /notices/manage/:id). */
export interface NoticeManageItem {
  id: string;
  title: string;
  body: string;
  audience: NoticeAudience;
  status: NoticeStatus;
  state: NoticeState;
  pinned: boolean;
  publishAt: string | null;
  expiresAt: string | null;
  editedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  targets: NoticeTargetView[];
  readCount: number;
  createdAt: string;
}

/** GET /notices/:id/reads: how many of the audience opened it. */
export interface NoticeReadCounts {
  staff: { read: number; of: number };
  guardians: { read: number; of: number };
}
