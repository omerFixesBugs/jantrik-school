import type { StudentStatus } from './api.js';
import type { IsoDate } from './dates.js';

// Promotion and the new session (sprint 1 P5, docs/promotion.md): values, the roll numbering and
// the API's response shapes. The zod schemas live in promotion-schema.ts (the browser never loads
// zod).

export const ROLL_STRATEGIES = ['MERIT', 'NAME_BN', 'NAME_EN', 'MANUAL', 'KEEP'] as const;
export type RollStrategy = (typeof ROLL_STRATEGIES)[number];

/** S15: promoted students first, then repeaters, then new admits. */
export const ROLL_GROUPS = ['PROMOTED', 'REPEATER', 'NEW'] as const;
export type RollGroup = (typeof ROLL_GROUPS)[number];

export const PROMOTION_DECISIONS = ['PROMOTE', 'REPEAT', 'LEAVE'] as const;
export type PromotionDecision = (typeof PROMOTION_DECISIONS)[number];

/** The statuses a student may leave with (S14): never ACTIVE. */
export const LEAVE_STATUSES = ['GRADUATED', 'TRANSFERRED', 'DROPPED_OUT', 'INACTIVE'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const PROMOTION_RUN_STATUSES = ['DRAFT', 'APPLYING', 'APPLIED'] as const;
export type PromotionRunStatus = (typeof PROMOTION_RUN_STATUSES)[number];

export const PROMOTION_APPLY_OUTCOMES = [
  'ENROLLED',
  'ALREADY_ENROLLED',
  'LEFT',
  'SKIPPED_DEACTIVATED',
  'SKIPPED_LEFT',
] as const;
export type PromotionApplyOutcome = (typeof PROMOTION_APPLY_OUTCOMES)[number];

/** At most this many rows per bulk edit (one request transaction). */
export const PROMOTION_ROWS_PER_EDIT = 500;

// ─────────────────────────── Roll numbering ───────────────────────────

export interface RollCandidate {
  /** The enrolment in the new year. */
  id: string;
  group: RollGroup;
  nameBn: string | null;
  nameEn: string | null;
  studentCode: string;
  /** The roll in the old year (KEEP; MERIT's tie-break). */
  oldRoll: number | null;
  /** The class position in the merit exam; null = unranked or no result. */
  meritPosition: number | null;
}

let bnCollator: Intl.Collator | undefined;
let enCollator: Intl.Collator | undefined;
const bn = () => (bnCollator ??= new Intl.Collator('bn', { sensitivity: 'base' }));
const en = () => (enCollator ??= new Intl.Collator('en', { sensitivity: 'base' }));

/** Plain code-point order: the same everywhere (no locale), so ties never depend on the runtime. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareNameBn(a: RollCandidate, b: RollCandidate): number {
  return (
    bn().compare(a.nameBn ?? a.nameEn ?? '', b.nameBn ?? b.nameEn ?? '') ||
    byCode(a.studentCode, b.studentCode) ||
    byCode(a.id, b.id)
  );
}

function compareNameEn(a: RollCandidate, b: RollCandidate): number {
  return (
    en().compare(a.nameEn ?? a.nameBn ?? '', b.nameEn ?? b.nameBn ?? '') ||
    byCode(a.studentCode, b.studentCode) ||
    byCode(a.id, b.id)
  );
}

/** Ascending, null last. */
function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareMerit(a: RollCandidate, b: RollCandidate): number {
  return (
    nullsLast(a.meritPosition, b.meritPosition) ||
    nullsLast(a.oldRoll, b.oldRoll) ||
    compareNameBn(a, b)
  );
}

/** The order a strategy numbers a group in (KEEP's own rule is applied by assignRolls). */
export function sortForStrategy(
  candidates: readonly RollCandidate[],
  strategy: RollStrategy,
): RollCandidate[] {
  const list = [...candidates];
  if (strategy === 'MERIT') return list.sort(compareMerit);
  if (strategy === 'NAME_EN') return list.sort(compareNameEn);
  // NAME_BN; MANUAL proposes NAME_BN (the admin edits the numbers); KEEP's others by NAME_BN.
  return list.sort(compareNameBn);
}

/**
 * Proposed rolls for one section (S15, P5-A, P5-B): the groups in S15 order (promoted, repeaters,
 * new admits), each sorted by its own strategy. Numbers in `taken` (rolls already set in the
 * section: new admits given one by hand, earlier numbering) are skipped and never reassigned.
 *
 * - Each group continues after the highest number the groups before it used (the first one starts
 *   at 1), skipping taken numbers.
 * - KEEP: a student keeps their old roll when it is free (not taken, not used by an earlier group,
 *   not kept by a student before them by Bangla name); the rest follow after the highest number
 *   used so far, kept ones included, by Bangla name.
 *
 * Pure and deterministic: the same candidates in any order give the same map.
 */
export function assignRolls(
  candidates: readonly RollCandidate[],
  strategy: Record<RollGroup, RollStrategy>,
  taken: ReadonlySet<number>,
): Map<string, number> {
  const used = new Set<number>(taken);
  const out = new Map<string, number>();
  let highest = 0;
  const give = (id: string, roll: number) => {
    out.set(id, roll);
    used.add(roll);
    if (roll > highest) highest = roll;
  };
  const nextFree = (from: number) => {
    let n = from;
    while (used.has(n)) n++;
    return n;
  };

  for (const group of ROLL_GROUPS) {
    const members = candidates.filter((c) => c.group === group);
    if (members.length === 0) continue;
    const groupStrategy = strategy[group];
    let others = sortForStrategy(members, groupStrategy);
    if (groupStrategy === 'KEEP') {
      const rest: RollCandidate[] = [];
      for (const c of others) {
        if (c.oldRoll !== null && c.oldRoll >= 1 && !used.has(c.oldRoll)) give(c.id, c.oldRoll);
        else rest.push(c);
      }
      others = rest;
    }
    let n = highest + 1;
    for (const c of others) {
      n = nextFree(n);
      give(c.id, n);
      n++;
    }
  }
  return out;
}

/**
 * The next class after `classLevelId`: the active class level with the next higher sort order
 * (data, not institute type). Null for the top class (or when none is higher).
 */
export function nextClassLevel<T extends { id: string; sortOrder: number; isActive: boolean }>(
  classLevels: readonly T[],
  classLevelId: string,
): T | null {
  const current = classLevels.find((c) => c.id === classLevelId);
  if (!current) return null;
  const higher = classLevels
    .filter((c) => c.isActive && c.id !== current.id && c.sortOrder > current.sortOrder)
    .sort((a, b) => a.sortOrder - b.sortOrder || byCode(a.id, b.id));
  return higher[0] ?? null;
}

// ─────────────────────────── Responses ───────────────────────────

export interface PromotionRunCounts {
  total: number;
  promote: number;
  repeat: number;
  leave: number;
  /** Rows not applied yet. */
  pending: number;
  /** PROMOTE/REPEAT rows without a target section. */
  withoutSection: number;
  /** Rows without a result in the merit exam. */
  noResult: number;
}

export interface PromotionRunSummary {
  id: string;
  fromYear: { id: string; name: string };
  toYear: { id: string; name: string };
  classLevel: { id: string; nameBn: string; nameEn: string; sortOrder: number };
  rollStrategy: RollStrategy;
  meritExam: { id: string; nameBn: string; nameEn: string } | null;
  status: PromotionRunStatus;
  lastError: string | null;
  applyStartedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  counts: PromotionRunCounts;
}

export interface PromotionRunsOverview {
  toYear: { id: string; name: string };
  /** The year the runs start from (the year before the to-year), null when there is none. */
  fromYear: { id: string; name: string } | null;
  runs: PromotionRunSummary[];
  /** Active classes of the from-year with enrolments but no run yet. */
  classesWithoutRun: { id: string; nameBn: string; nameEn: string; students: number }[];
}

export interface PromotionRowView {
  id: string;
  student: {
    id: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
    status: StudentStatus;
    deactivated: boolean;
  };
  fromSection: { id: string; name: string } | null;
  fromRoll: number | null;
  resultPassed: boolean | null;
  meritPosition: number | null;
  /** No row in the merit exam's results (or no merit exam). */
  noResult: boolean;
  decision: PromotionDecision;
  targetClassLevel: { id: string; nameBn: string; nameEn: string } | null;
  targetSection: { id: string; name: string } | null;
  targetStudyGroup: { id: string; nameBn: string; nameEn: string } | null;
  leaveStatus: LeaveStatus | null;
  leftOn: IsoDate | null;
  leaveReason: string | null;
  appliedAt: string | null;
  applyOutcome: PromotionApplyOutcome | null;
  toEnrolmentId: string | null;
}

export interface PromotionRunDetail extends PromotionRunSummary {
  rows: PromotionRowView[];
  /** The next class (the default PROMOTE target), null for the top class. */
  nextClassLevel: { id: string; nameBn: string; nameEn: string } | null;
}

export interface ApplyCheckSection {
  section: { id: string; name: string };
  classLevel: { id: string; nameBn: string; nameEn: string };
  capacity: number | null;
  /** Enrolled in the section now (deactivated students not counted). */
  enrolled: number;
  /** Pending rows of this run going there. */
  incoming: number;
  /** enrolled + incoming > capacity. */
  full: boolean;
}

export interface PromotionApplyCheck {
  runId: string;
  status: PromotionRunStatus;
  sections: ApplyCheckSection[];
  /** Pending PROMOTE/REPEAT rows without a target section (they are enrolled without one). */
  withoutSection: number;
  pending: { promote: number; repeat: number; leave: number };
  /** Changes when a pending row, a target section or its enrolments change; apply sends it back. */
  version: string;
}

export interface RollsPreviewRow {
  enrolmentId: string;
  studentId: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  group: RollGroup;
  oldRoll: number | null;
  meritPosition: number | null;
  /** The roll already set (kept as is), or null. */
  roll: number | null;
  /** The proposed roll for rows without one. */
  proposed: number | null;
}

export interface RollsPreviewSection {
  section: { id: string; name: string };
  rows: RollsPreviewRow[];
}

export interface RollsPreview {
  toYear: { id: string; name: string };
  classLevel: { id: string; nameBn: string; nameEn: string };
  strategies: Record<RollGroup, RollStrategy>;
  sections: RollsPreviewSection[];
  /** Enrolments of the class in the to-year without a section (not numbered). */
  withoutSection: number;
  /** Hash of the class's to-year enrolment ids and rolls; saving sends it back. */
  version: string;
}

export interface SwitchCheck {
  toYear: { id: string; name: string; isCurrent: boolean };
  fromYear: { id: string; name: string } | null;
  /** Active classes of the from-year with students but no run into the to-year. */
  classesWithoutRun: { id: string; nameBn: string; nameEn: string; students: number }[];
  /** Runs not applied yet (DRAFT, APPLYING, or APPLIED with pending rows). */
  runsNotApplied: {
    runId: string;
    classLevel: { id: string; nameBn: string; nameEn: string };
    status: PromotionRunStatus;
    pending: number;
    lastError: string | null;
  }[];
  /** Classes of the from-year with students whose ANNUAL exam is not published (or missing). */
  classesWithoutPublishedAnnual: { id: string; nameBn: string; nameEn: string }[];
  /** ACTIVE students of the from-year not enrolled in the to-year (and not leavers). */
  notCarriedOver: number;
  /** Enrolments of the to-year in a section but without a roll. */
  withoutRoll: number;
  /** Nothing listed above. */
  clean: boolean;
}

export interface LeaveResult {
  studentId: string;
  status: LeaveStatus;
  leftOn: IsoDate;
}
