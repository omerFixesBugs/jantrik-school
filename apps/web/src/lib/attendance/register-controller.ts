import type {
  AttendanceSessionState,
  AttendanceSheet,
  AttendanceStatus,
  IsoDate,
  RosterStudent,
  SubmitAttendanceResponse,
} from '@jantrik/shared';
import { ApiError, NetworkError } from '@/lib/api/errors';
import {
  latestDraft,
  readDraft,
  removeDraft,
  removeDraftIfConfirmed,
  writeDraft,
  type AttendanceDraft,
  type DraftKey,
  type DraftStudent,
} from './drafts';

/** What the teacher sees about saving. Never ambiguous: either the server confirmed it or not. */
export type SyncState =
  | { kind: 'loading' }
  /** The register can't be loaded and there is no draft on this phone. */
  | { kind: 'unavailable'; error: unknown }
  /** Nothing taken yet and nothing changed. */
  | { kind: 'fresh' }
  /** Changed on this phone, not submitted. */
  | { kind: 'local' }
  | { kind: 'sending' }
  /** Could not reach the server; tries again at `at` (epoch ms), or as soon as it is back online. */
  | { kind: 'retrying'; at: number }
  /** The server has exactly what is on screen. */
  | { kind: 'saved'; submittedAt: string }
  /** Someone else saved first; the teacher chooses. */
  | { kind: 'conflict'; server: AttendanceSessionState }
  /** Students joined or left the section; statuses were merged, the teacher should check. */
  | { kind: 'roster-changed'; added: number; removed: number }
  /** Refused for a reason retrying won't fix (edit window closed, holiday…). */
  | { kind: 'error'; code: string | undefined };

export interface RegisterState {
  sheet: AttendanceSheet | null;
  draft: AttendanceDraft | null;
  sync: SyncState;
}

export interface RegisterOptions {
  api: <T>(path: string, init?: RequestInit & { json?: unknown }) => Promise<T>;
  userId: string;
  tenantId: string;
  sectionId: string;
  periodNo: number;
  /** A past date from the URL; otherwise the server's today. */
  date?: IsoDate;
  sectionName: string;
  /** After the server confirmed a submit (refresh lists, dashboard). */
  onSaved?: (session: AttendanceSessionState) => void;
}

const RETRY_DELAYS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
/** Tap order on a student. */
export const CYCLE: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'];

const newId = () => crypto.randomUUID();
const isTransient = (e: unknown) =>
  e instanceof NetworkError || (e instanceof ApiError && (e.status >= 500 || e.status === 429));
const toDraftStudent = (s: RosterStudent | DraftStudent): DraftStudent => ({
  id: s.id,
  roll: s.roll,
  nameBn: s.nameBn,
  nameEn: s.nameEn,
});

/**
 * One register being taken: the working copy, its draft on the phone, and getting it to the
 * server. Plain TypeScript (no React), so the rules live in one place:
 *
 * - every change is written to the phone at once, with a new submissionId;
 * - a submit marks the draft "pending"; only the server's answer for that exact submissionId
 *   removes it, so a reload, a killed tab or a lost response never loses work;
 * - network errors and 5xx retry with backoff, when the browser is back online, and when the tab
 *   becomes visible; a pending draft found on load is sent again automatically;
 * - a conflict with our own earlier submit is resolved silently; someone else's is shown to the
 *   teacher (keep mine / keep theirs).
 */
export class RegisterController {
  private state: RegisterState = { sheet: null, draft: null, sync: { kind: 'loading' } };
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly o: RegisterOptions) {}

  // ── store interface (useSyncExternalStore) ──
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<RegisterState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private key(d: { date: IsoDate }): DraftKey {
    const { userId, tenantId, sectionId, periodNo } = this.o;
    return { userId, tenantId, sectionId, periodNo, date: d.date };
  }

  /** Change the working copy and keep it on the phone immediately. */
  private persist(draft: AttendanceDraft, sync?: SyncState) {
    writeDraft(draft);
    this.set(sync ? { draft, sync } : { draft });
  }

  // ── lifecycle ──
  start() {
    // React StrictMode (development) runs effects twice: start → dispose → start.
    this.disposed = false;
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.load();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private onWake = () => {
    if (this.state.sync.kind === 'retrying') void this.send();
    else if (this.state.sync.kind === 'unavailable' || (!this.state.sheet && this.state.draft))
      void this.load();
  };
  private onVisible = () => document.visibilityState === 'visible' && this.onWake();

  /** Load the register from the server; fall back to the phone's draft if it can't be reached. */
  async load() {
    const { sectionId, periodNo, date, userId, tenantId } = this.o;
    let sheet: AttendanceSheet;
    try {
      const q = new URLSearchParams({ sectionId, periodNo: String(periodNo) });
      if (date) q.set('date', date);
      sheet = await this.o.api<AttendanceSheet>(`/attendance/sessions?${q}`);
    } catch (error) {
      if (this.state.draft) return; // already showing the phone's copy
      const stored = latestDraft(userId, tenantId, sectionId, periodNo);
      if (stored && isTransient(error)) {
        this.set({
          draft: stored,
          sync:
            stored.state === 'pending' ? { kind: 'retrying', at: Date.now() } : { kind: 'local' },
        });
        if (stored.state === 'pending') this.scheduleRetry();
      } else {
        this.set({ sync: { kind: 'unavailable', error } });
      }
      return;
    }

    // Opened by a direct link: name the section from the register itself.
    const sectionName =
      this.o.sectionName || `${sheet.section.classLevel.nameBn}, ${sheet.section.name}`;
    const stored =
      readDraft(this.key(sheet)) ??
      (this.state.draft?.date === sheet.date ? this.state.draft : null);
    if (stored) {
      const merged = mergeRoster(stored, sheet.students);
      this.state.sheet = sheet;
      this.persist(
        { ...merged.draft, sectionName },
        stored.state === 'pending' ? { kind: 'sending' } : { kind: 'local' },
      );
      if (stored.state === 'pending') void this.send(); // a submit that never got its answer
      return;
    }
    const statuses = Object.fromEntries(
      sheet.students.map((st) => [
        st.id,
        sheet.session?.records.find((r) => r.studentId === st.id)?.status ?? 'PRESENT',
      ]),
    ) as Record<string, AttendanceStatus>;
    // In memory only: nothing to keep on the phone until the teacher changes something.
    this.set({
      sheet,
      draft: {
        v: 1,
        userId,
        tenantId,
        sectionId,
        sectionName,
        date: sheet.date,
        periodNo,
        baseVersion: sheet.session?.version ?? 0,
        submissionId: newId(),
        statuses,
        roster: sheet.students.map(toDraftStudent),
        state: 'draft',
        updatedAt: Date.now(),
      },
      sync: sheet.session
        ? { kind: 'saved', submittedAt: sheet.session.submittedAt }
        : { kind: 'fresh' },
    });
  }

  // ── editing ──
  private edit(change: (s: Record<string, AttendanceStatus>) => Record<string, AttendanceStatus>) {
    const d = this.state.draft;
    if (!d) return;
    this.attempt = 0;
    const sync =
      this.state.sync.kind === 'conflict' ? this.state.sync : ({ kind: 'local' } as const);
    this.persist(
      {
        ...d,
        statuses: change(d.statuses),
        submissionId: newId(),
        state: 'draft',
        updatedAt: Date.now(),
      },
      sync,
    );
  }

  cycle(studentId: string) {
    this.edit((s) => ({
      ...s,
      [studentId]: CYCLE[(CYCLE.indexOf(s[studentId] ?? 'PRESENT') + 1) % CYCLE.length]!,
    }));
  }

  markAllPresent() {
    this.edit((s) => Object.fromEntries(Object.keys(s).map((id) => [id, 'PRESENT' as const])));
  }

  setAllowNonWorkingDay(allow: boolean) {
    const d = this.state.draft;
    if (d) this.persist({ ...d, allowNonWorkingDay: allow });
  }

  // ── sending ──
  submit() {
    this.attempt = 0;
    return this.send();
  }

  private scheduleRetry() {
    clearTimeout(this.timer);
    const sync = this.state.sync;
    if (sync.kind !== 'retrying') return;
    this.timer = setTimeout(() => void this.send(), Math.max(0, sync.at - Date.now()));
  }

  private async send(): Promise<void> {
    const d = this.state.draft;
    if (!d || this.inflight || this.disposed) return;
    this.inflight = true;
    clearTimeout(this.timer);
    this.persist({ ...d, state: 'pending' }, { kind: 'sending' });
    try {
      const res = await this.o.api<SubmitAttendanceResponse>('/attendance/sessions', {
        method: 'PUT',
        json: {
          sectionId: d.sectionId,
          date: d.date,
          periodNo: d.periodNo,
          submissionId: d.submissionId,
          baseVersion: d.baseVersion,
          allowNonWorkingDay: d.allowNonWorkingDay,
          records: d.roster.map((st) => ({
            studentId: st.id,
            status: d.statuses[st.id] ?? 'PRESENT',
          })),
        },
      });
      this.attempt = 0;
      removeDraftIfConfirmed(this.key(d), d.submissionId);
      const current = this.state.draft!;
      const sheet = this.state.sheet ? { ...this.state.sheet, session: res.session } : null;
      if (current.submissionId !== d.submissionId) {
        // Changed again while this was in flight: that newer revision is still only on the phone.
        this.state.sheet = sheet;
        this.persist({ ...current, baseVersion: res.session.version }, { kind: 'local' });
      } else {
        this.set({
          sheet,
          draft: { ...current, baseVersion: res.session.version, state: 'draft' },
          sync: { kind: 'saved', submittedAt: res.session.submittedAt },
        });
      }
      this.o.onSaved?.(res.session);
    } catch (error) {
      this.inflight = false;
      await this.handleSendError(error, d);
    } finally {
      this.inflight = false;
    }
  }

  private async handleSendError(error: unknown, d: AttendanceDraft) {
    if (isTransient(error)) {
      const delay = RETRY_DELAYS[Math.min(this.attempt, RETRY_DELAYS.length - 1)]!;
      this.attempt += 1;
      this.set({ sync: { kind: 'retrying', at: Date.now() + delay } });
      this.scheduleRetry();
      return;
    }
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      let server =
        (error.body as { session?: AttendanceSessionState | null } | undefined)?.session ?? null;
      if (!server) {
        // Someone created the register a moment ago: fetch it.
        const q = new URLSearchParams({
          sectionId: d.sectionId,
          date: d.date,
          periodNo: String(d.periodNo),
        });
        server =
          (await this.o.api<AttendanceSheet>(`/attendance/sessions?${q}`).catch(() => null))
            ?.session ?? null;
      }
      if (server && server.updatedBy.id === this.o.userId) {
        // Our own earlier submit reached the server (its answer was lost): build on it.
        this.persist({ ...d, baseVersion: server.version, state: 'draft' });
        return this.send();
      }
      if (server) {
        this.persist({ ...d, state: 'draft' }, { kind: 'conflict', server });
        return;
      }
    }
    if (error instanceof ApiError && error.code === 'ROSTER_CHANGED') {
      const students = (error.body as { students?: RosterStudent[] } | undefined)?.students ?? [];
      const merged = mergeRoster({ ...d, state: 'draft', submissionId: newId() }, students);
      this.persist(merged.draft, {
        kind: 'roster-changed',
        added: merged.added,
        removed: merged.removed,
      });
      return;
    }
    this.persist(
      { ...d, state: 'draft' },
      { kind: 'error', code: error instanceof ApiError ? error.code : undefined },
    );
  }

  /** Conflict: keep mine (send it on top of theirs). */
  keepMine() {
    const { sync, draft } = this.state;
    if (sync.kind !== 'conflict' || !draft) return;
    this.persist({ ...draft, baseVersion: sync.server.version, submissionId: newId() });
    return this.submit();
  }

  /** Conflict: keep theirs (drop my draft, show what is saved). */
  keepTheirs() {
    const { sync, draft, sheet } = this.state;
    if (sync.kind !== 'conflict' || !draft) return;
    removeDraft(this.key(draft));
    const statuses = Object.fromEntries(
      draft.roster.map((st) => [
        st.id,
        sync.server.records.find((r) => r.studentId === st.id)?.status ?? 'PRESENT',
      ]),
    ) as Record<string, AttendanceStatus>;
    this.set({
      sheet: sheet ? { ...sheet, session: sync.server } : sheet,
      draft: {
        ...draft,
        statuses,
        baseVersion: sync.server.version,
        submissionId: newId(),
        state: 'draft',
      },
      sync: { kind: 'saved', submittedAt: sync.server.submittedAt },
    });
  }
}

/** Keep the teacher's statuses for students still on the roster; new students start PRESENT. */
export function mergeRoster(draft: AttendanceDraft, students: (RosterStudent | DraftStudent)[]) {
  const before = new Set(draft.roster.map((s) => s.id));
  const after = new Set(students.map((s) => s.id));
  const statuses = Object.fromEntries(
    students.map((s) => [s.id, draft.statuses[s.id] ?? 'PRESENT']),
  ) as Record<string, AttendanceStatus>;
  return {
    draft: { ...draft, roster: students.map(toDraftStudent), statuses },
    added: students.filter((s) => !before.has(s.id)).length,
    removed: draft.roster.filter((s) => !after.has(s.id)).length,
  };
}

/** The students whose status differs between my draft and the saved register. */
export function conflictDiff(draft: AttendanceDraft, server: AttendanceSessionState) {
  return draft.roster
    .map((st) => ({
      student: st,
      mine: draft.statuses[st.id] ?? 'PRESENT',
      theirs: server.records.find((r) => r.studentId === st.id)?.status ?? 'PRESENT',
    }))
    .filter((x) => x.mine !== x.theirs);
}
