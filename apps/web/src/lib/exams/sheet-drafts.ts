/**
 * Mark sheet drafts, kept on the phone so a teacher never loses marks on bad internet (like the
 * attendance drafts in lib/attendance/drafts.ts).
 *
 * - Written synchronously on every keystroke (localStorage), so even a killed tab keeps them.
 * - Keyed by user, tenant, exam subject and section: nobody else's drafts are shown or sent.
 * - Holds only the sheet's own data: student id, roll, name and what was typed. Never phones,
 *   photos or guardian details.
 * - Removed once the server confirms the draft's exact submissionId, or after 14 days.
 */

const PREFIX = 'jantrik.marks:';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface MarkDraftStudent {
  id: string;
  roll: number | null;
  nameBn: string | null;
  nameEn: string | null;
}

export interface MarkDraft {
  v: 1;
  userId: string;
  tenantId: string;
  examSubjectId: string;
  sectionId: string;
  /** "Bangla — Class 6 ক" as shown when entered (for lists while offline). */
  title: string;
  /** Server version the draft is based on (0 = no sheet yet). */
  baseVersion: number;
  /** New for every change, so a retry of an old revision can't be mistaken for this one. */
  submissionId: string;
  /** `${studentId}:${componentKey}` → what was typed ('' is not entered, 'a'/'অ' absent). */
  values: Record<string, string>;
  roster: MarkDraftStudent[];
  /** draft: only on the phone; pending: sent, waiting for the server to confirm. */
  state: 'draft' | 'pending';
  /** What the pending send does. */
  action: 'SAVE' | 'SUBMIT';
  updatedAt: number;
}

export interface MarkDraftKey {
  userId: string;
  tenantId: string;
  examSubjectId: string;
  sectionId: string;
}

export const markDraftKey = (k: MarkDraftKey): string =>
  `${PREFIX}${k.userId}:${k.tenantId}:${k.examSubjectId}:${k.sectionId}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): MarkDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as MarkDraft;
    return d?.v === 1 && typeof d.submissionId === 'string' ? d : null;
  } catch {
    return null;
  }
}

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

export function readMarkDraft(k: MarkDraftKey): MarkDraft | null {
  return parse(storage()?.getItem(markDraftKey(k)) ?? null);
}

/** Returns false if the phone refused to store it (full or blocked storage). */
export function writeMarkDraft(d: MarkDraft): boolean {
  try {
    storage()?.setItem(markDraftKey(d), JSON.stringify({ ...d, updatedAt: Date.now() }));
    return storage() !== null;
  } catch {
    return false;
  }
}

/** Remove the draft only if it still is the revision the server confirmed. */
export function removeMarkDraftIfConfirmed(k: MarkDraftKey, submissionId: string): void {
  const s = storage();
  const d = readMarkDraft(k);
  if (s && d && d.submissionId === submissionId) {
    try {
      s.removeItem(markDraftKey(k));
    } catch {
      // ignore
    }
  }
}

export function removeMarkDraft(k: MarkDraftKey): void {
  try {
    storage()?.removeItem(markDraftKey(k));
  } catch {
    // ignore
  }
}

/** This user's mark drafts in this tenant, newest first. */
export function listMarkDrafts(userId: string, tenantId: string): MarkDraft[] {
  return keys()
    .map((key) => parse(storage()!.getItem(key)))
    .filter((d): d is MarkDraft => !!d && d.userId === userId && d.tenantId === tenantId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many mark drafts are on this phone, any user (the "can't reach the server" screen). */
export function countAllMarkDrafts(): number {
  return keys().length;
}
