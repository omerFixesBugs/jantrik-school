import type { AttendanceStatus, IsoDate } from '@jantrik/shared';

/**
 * Attendance drafts, kept on the phone so a teacher never loses work on bad internet.
 *
 * - Written synchronously on every tap (localStorage), so even a killed tab keeps the latest state.
 * - Keyed by user and tenant: on a shared phone, nobody else's drafts are shown or sent.
 * - Holds only what the register needs offline: student id, roll and name. Never phone numbers,
 *   photos or guardian details.
 * - Removed once the server confirms the draft's exact submissionId, or after 7 days.
 */

const PREFIX = 'jantrik.att:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftStudent {
  id: string;
  roll: number | null;
  nameBn: string | null;
  nameEn: string | null;
}

export interface AttendanceDraft {
  v: 1;
  userId: string;
  tenantId: string;
  sectionId: string;
  /** Section label as shown when it was taken (for lists while offline). */
  sectionName: string;
  /** The register's date, from the server (never the device clock). */
  date: IsoDate;
  periodNo: number;
  /** Server version the draft is based on (0 = the register did not exist). */
  baseVersion: number;
  /** New for every change, so a retry of an old revision can't be mistaken for this one. */
  submissionId: string;
  statuses: Record<string, AttendanceStatus>;
  roster: DraftStudent[];
  /** draft: not submitted yet; pending: submitted, waiting for the server to confirm. */
  state: 'draft' | 'pending';
  /** Admin override for a holiday or weekly off day. */
  allowNonWorkingDay?: boolean;
  updatedAt: number;
}

export interface DraftKey {
  userId: string;
  tenantId: string;
  sectionId: string;
  date: IsoDate;
  periodNo: number;
}

export const draftKey = (k: DraftKey): string =>
  `${PREFIX}${k.userId}:${k.tenantId}:${k.sectionId}:${k.date}:${k.periodNo}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // blocked storage (some private modes)
  }
}

function parse(raw: string | null): AttendanceDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as AttendanceDraft;
    return d?.v === 1 && typeof d.submissionId === 'string' ? d : null;
  } catch {
    return null;
  }
}

/** Every stored draft key (any user), dropping expired or unreadable ones. */
function keys(): string[] {
  const s = storage();
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(PREFIX)) out.push(key);
  }
  const now = Date.now();
  return out.filter((key) => {
    const d = parse(s.getItem(key));
    if (!d || now - d.updatedAt > MAX_AGE_MS) {
      try {
        s.removeItem(key);
      } catch {
        // ignore
      }
      return false;
    }
    return true;
  });
}

export function readDraft(k: DraftKey): AttendanceDraft | null {
  return parse(storage()?.getItem(draftKey(k)) ?? null);
}

/** Returns false if the phone refused to store it (full or blocked storage). */
export function writeDraft(d: AttendanceDraft): boolean {
  try {
    storage()?.setItem(draftKey(d), JSON.stringify({ ...d, updatedAt: Date.now() }));
    return storage() !== null;
  } catch {
    return false;
  }
}

/** Remove the draft only if it still is the revision the server confirmed. */
export function removeDraftIfConfirmed(k: DraftKey, submissionId: string): void {
  const s = storage();
  const d = readDraft(k);
  if (s && d && d.submissionId === submissionId) {
    try {
      s.removeItem(draftKey(k));
    } catch {
      // ignore
    }
  }
}

export function removeDraft(k: DraftKey): void {
  try {
    storage()?.removeItem(draftKey(k));
  } catch {
    // ignore
  }
}

/** This user's drafts in this tenant, newest first. */
export function listDrafts(userId: string, tenantId: string): AttendanceDraft[] {
  return keys()
    .map((key) => parse(storage()!.getItem(key)))
    .filter((d): d is AttendanceDraft => !!d && d.userId === userId && d.tenantId === tenantId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The newest draft of this user for a section and period (any date). */
export function latestDraft(
  userId: string,
  tenantId: string,
  sectionId: string,
  periodNo: number,
): AttendanceDraft | null {
  return (
    listDrafts(userId, tenantId).find(
      (d) => d.sectionId === sectionId && d.periodNo === periodNo,
    ) ?? null
  );
}

/**
 * How many drafts are on this phone, any user. For the "can't reach the server" screen, which
 * has no session: it shows a number only, never names.
 */
export function countAllDrafts(): number {
  return keys().length;
}
