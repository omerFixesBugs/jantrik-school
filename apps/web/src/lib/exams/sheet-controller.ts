import {
  parseMarks,
  toBanglaDigits,
  type MarkSheetView,
  type ParsedMarks,
  type SaveMarkSheetResult,
} from '@jantrik/shared';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { randomId } from '@/lib/uuid';
import {
  readMarkDraft,
  removeMarkDraft,
  removeMarkDraftIfConfirmed,
  writeMarkDraft,
  type MarkDraft,
  type MarkDraftKey,
  type MarkDraftStudent,
} from './sheet-drafts';

/** What the teacher sees about saving: either the server has exactly this, or it does not yet. */
export type SheetSync =
  | { kind: 'loading' }
  /** The sheet can't be loaded and there is no draft on this phone. */
  | { kind: 'unavailable'; error: unknown }
  /** Nothing changed since it was loaded. */
  | { kind: 'saved'; at: string | null }
  /** Changed on this phone; it will be saved in a moment (or a cell needs fixing first). */
  | { kind: 'local' }
  | { kind: 'sending' }
  /** Could not reach the server; tries again at `at` (epoch ms), or once back online. */
  | { kind: 'retrying'; at: number }
  /** Someone else saved meanwhile; the teacher chooses. */
  | { kind: 'conflict'; server: MarkSheetView }
  /** Students joined or left; marks were kept for those still here. */
  | { kind: 'roster-changed'; added: number; removed: number }
  /** Refused for a reason retrying won't fix (locked, incomplete on submit…). */
  | { kind: 'error'; code: string | undefined; missing?: number };

export interface SheetState {
  view: MarkSheetView | null;
  draft: MarkDraft | null;
  sync: SheetSync;
}

export interface SheetOptions {
  api: <T>(path: string, init?: RequestInit & { json?: unknown }) => Promise<T>;
  userId: string;
  tenantId: string;
  examSubjectId: string;
  sectionId: string;
  /** Marks loaded from the server are shown in the UI language's digits. */
  locale: 'bn' | 'en';
  /** After the server confirmed a save (refresh lists and the grid). */
  onSaved?: (view: MarkSheetView) => void;
}

const RETRY_DELAYS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
/** A quiet pause in typing before the draft goes to the server. */
export const AUTOSAVE_MS = 3_000;

const isTransient = (e: unknown) =>
  e instanceof NetworkError || (e instanceof ApiError && (e.status >= 500 || e.status === 429));
export const cellKey = (studentId: string, key: string) => `${studentId}:${key}`;

/** What the server has for a cell, as the teacher would type it (in the UI's digits). */
function typed(view: MarkSheetView, studentId: string, key: string, locale: 'bn' | 'en'): string {
  const cell = view.students.find((s) => s.studentId === studentId)?.marks[key];
  if (!cell) return '';
  if (cell.absent) return locale === 'bn' ? 'অ' : 'a';
  if (cell.scoreH === null) return '';
  const whole = Math.floor(cell.scoreH / 100);
  const cents = cell.scoreH % 100;
  const text =
    cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
  return locale === 'bn' ? toBanglaDigits(text) : text;
}

function valuesOf(view: MarkSheetView, locale: 'bn' | 'en'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const st of view.students) {
    for (const c of view.examSubject.components) {
      out[cellKey(st.studentId, c.key)] = typed(view, st.studentId, c.key, locale);
    }
  }
  return out;
}

const rosterOf = (view: MarkSheetView): MarkDraftStudent[] =>
  view.students.map((s) => ({ id: s.studentId, roll: s.roll, nameBn: s.nameBn, nameEn: s.nameEn }));

/**
 * One mark sheet being entered: the working copy, its draft on the phone, and getting it to the
 * server. Plain TypeScript, like the attendance RegisterController:
 *
 * - every keystroke is written to the phone at once, with a new submissionId;
 * - after a short pause the whole sheet is saved as a draft (only when every cell parses);
 *   Submit sends it as SUBMIT;
 * - only the server's answer for that exact submissionId removes the phone's copy;
 * - network errors and 5xx retry with backoff, when back online and when the tab is visible;
 * - a conflict with our own earlier save is resolved silently; someone else's is shown.
 */
export class MarkSheetController {
  private state: SheetState = { view: null, draft: null, sync: { kind: 'loading' } };
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private inflight = false;
  /** Submit was asked for while a save was on its way: it goes once that save is answered. */
  private submitAfter = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private autosave: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly o: SheetOptions) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<SheetState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private get key(): MarkDraftKey {
    const { userId, tenantId, examSubjectId, sectionId } = this.o;
    return { userId, tenantId, examSubjectId, sectionId };
  }

  private persist(draft: MarkDraft, sync?: SheetSync) {
    writeMarkDraft(draft);
    this.set(sync ? { draft, sync } : { draft });
  }

  start() {
    this.disposed = false;
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.load();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.autosave);
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private onWake = () => {
    if (this.state.sync.kind === 'retrying') void this.send(this.state.draft?.action ?? 'SAVE');
    else if (this.state.sync.kind === 'unavailable' || (!this.state.view && this.state.draft))
      void this.load();
  };
  private onVisible = () => {
    if (document.visibilityState === 'visible') this.onWake();
    // Leaving the tab: save now rather than after the pause.
    else if (this.state.sync.kind === 'local') this.flush();
  };

  async load() {
    const { examSubjectId, sectionId } = this.o;
    let view: MarkSheetView;
    try {
      const q = new URLSearchParams({ examSubjectId, sectionId });
      view = await this.o.api<MarkSheetView>(`/exams/sheets?${q}`);
    } catch (error) {
      if (this.state.draft) return;
      const stored = readMarkDraft(this.key);
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
    const title = `${view.examSubject.subject.nameBn} — ${view.section.classLevel.nameBn} ${view.section.name}`;
    const stored = readMarkDraft(this.key);
    if (stored && view.mode !== 'READ_ONLY') {
      const merged = mergeRoster(stored, view, this.o.locale);
      this.state.view = view;
      this.persist(
        { ...merged.draft, title },
        stored.state === 'pending' ? { kind: 'sending' } : { kind: 'local' },
      );
      if (stored.state === 'pending') void this.send(stored.action);
      else this.scheduleAutosave();
      return;
    }
    this.set({
      view,
      draft: {
        v: 1,
        ...this.key,
        title,
        baseVersion: view.sheet.version,
        submissionId: randomId(),
        values: valuesOf(view, this.o.locale),
        roster: rosterOf(view),
        state: 'draft',
        action: 'SAVE',
        updatedAt: Date.now(),
      },
      sync: { kind: 'saved', at: view.sheet.updatedAt },
    });
  }

  // ── editing ──

  setValue(studentId: string, key: string, value: string) {
    const d = this.state.draft;
    if (!d) return;
    this.attempt = 0;
    const sync =
      this.state.sync.kind === 'conflict' ? this.state.sync : ({ kind: 'local' } as const);
    this.persist(
      {
        ...d,
        values: { ...d.values, [cellKey(studentId, key)]: value },
        submissionId: randomId(),
        state: 'draft',
        action: 'SAVE',
        updatedAt: Date.now(),
      },
      sync,
    );
    this.scheduleAutosave();
  }

  /** Absent in every part (or back to blank when they were all absent). */
  toggleAbsent(studentId: string) {
    const d = this.state.draft;
    const view = this.state.view;
    if (!d || !view) return;
    const keys = view.examSubject.components.map((c) => c.key);
    const allAbsent = keys.every((k) => parse(this, studentId, k).kind === 'absent');
    const values = { ...d.values };
    const absent = this.o.locale === 'bn' ? 'অ' : 'a';
    for (const k of keys) values[cellKey(studentId, k)] = allAbsent ? '' : absent;
    this.persist(
      { ...d, values, submissionId: randomId(), state: 'draft', action: 'SAVE' },
      { kind: 'local' },
    );
    this.scheduleAutosave();
  }

  /** Every cell's parse, for inline errors and the submit check. */
  parsed(studentId: string, key: string): ParsedMarks {
    return parse(this, studentId, key);
  }

  /** Cells that don't parse (block saving until fixed). */
  invalidCount(): number {
    const view = this.state.view;
    const d = this.state.draft;
    if (!view || !d) return 0;
    let n = 0;
    for (const st of d.roster) {
      for (const c of view.examSubject.components) {
        if (parse(this, st.id, c.key).kind === 'invalid') n++;
      }
    }
    return n;
  }

  /** Cells not entered yet (submit needs none). */
  blankCount(): number {
    const view = this.state.view;
    const d = this.state.draft;
    if (!view || !d) return 0;
    let n = 0;
    for (const st of d.roster) {
      for (const c of view.examSubject.components) {
        if (parse(this, st.id, c.key).kind === 'blank') n++;
      }
    }
    return n;
  }

  private scheduleAutosave() {
    clearTimeout(this.autosave);
    this.autosave = setTimeout(() => this.flush(), AUTOSAVE_MS);
  }

  /** Save the draft now (if every cell parses and something changed). */
  flush() {
    clearTimeout(this.autosave);
    if (this.state.sync.kind !== 'local' || this.invalidCount() > 0) return;
    this.attempt = 0;
    void this.send('SAVE');
  }

  submit() {
    clearTimeout(this.autosave);
    this.attempt = 0;
    if (this.invalidCount() > 0) return;
    // Tapping Submit right after typing: the field's blur has just started a save. Never drop
    // the submit; it follows that save.
    if (this.inflight) {
      this.submitAfter = true;
      return;
    }
    if (!this.markSubmit()) return;
    return this.send('SUBMIT');
  }

  /**
   * A submit is a new request: it gets its own submissionId. Reusing the last save's id would make
   * the server answer it as a replay of that save, and the sheet would stay a draft.
   */
  private markSubmit(): boolean {
    const d = this.state.draft;
    if (!d) return false;
    this.persist({ ...d, submissionId: randomId(), action: 'SUBMIT' });
    return true;
  }

  // ── sending ──

  private scheduleRetry() {
    clearTimeout(this.timer);
    const sync = this.state.sync;
    if (sync.kind !== 'retrying') return;
    this.timer = setTimeout(
      () => void this.send(this.state.draft?.action ?? 'SAVE'),
      Math.max(0, sync.at - Date.now()),
    );
  }

  private async send(action: 'SAVE' | 'SUBMIT'): Promise<void> {
    const d = this.state.draft;
    if (!d || this.inflight || this.disposed) return;
    this.inflight = true;
    clearTimeout(this.timer);
    this.persist({ ...d, state: 'pending', action }, { kind: 'sending' });
    try {
      const res = await this.o.api<SaveMarkSheetResult>('/exams/sheets', {
        method: 'PUT',
        json: {
          examSubjectId: d.examSubjectId,
          sectionId: d.sectionId,
          submissionId: d.submissionId,
          baseVersion: d.baseVersion,
          action,
          entries: d.roster.flatMap((st) =>
            (this.state.view?.examSubject.components ?? []).map((c) => ({
              studentId: st.id,
              key: c.key,
              value: d.values[cellKey(st.id, c.key)] ?? '',
            })),
          ),
        },
      });
      this.attempt = 0;
      removeMarkDraftIfConfirmed(this.key, d.submissionId);
      const current = this.state.draft!;
      if (current.submissionId !== d.submissionId) {
        // Typed again while this was in flight: the newer revision is still only on the phone.
        this.state.view = res;
        this.persist({ ...current, baseVersion: res.sheet.version }, { kind: 'local' });
        this.scheduleAutosave();
      } else {
        this.set({
          view: res,
          draft: { ...current, baseVersion: res.sheet.version, state: 'draft', action: 'SAVE' },
          sync: { kind: 'saved', at: res.sheet.updatedAt },
        });
      }
      this.o.onSaved?.(res);
    } catch (error) {
      this.inflight = false;
      await this.handleSendError(error, d, action);
    } finally {
      this.inflight = false;
      this.afterSend();
    }
  }

  /** A submit queued behind a save: sent now, or by the retry; dropped if the save needs a person. */
  private afterSend() {
    if (!this.submitAfter || this.disposed) return;
    const { sync, draft } = this.state;
    this.submitAfter = false;
    // The retry sends the draft's action: it becomes this submit.
    if (sync.kind === 'retrying' && draft) {
      this.markSubmit();
      return;
    }
    if ((sync.kind === 'saved' || sync.kind === 'local') && this.markSubmit()) {
      void this.send('SUBMIT');
    }
  }

  private async handleSendError(error: unknown, d: MarkDraft, action: 'SAVE' | 'SUBMIT') {
    if (isTransient(error)) {
      const delay = RETRY_DELAYS[Math.min(this.attempt, RETRY_DELAYS.length - 1)]!;
      this.attempt += 1;
      this.set({ sync: { kind: 'retrying', at: Date.now() + delay } });
      this.scheduleRetry();
      return;
    }
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      const server = (error.body as { sheet?: MarkSheetView } | undefined)?.sheet ?? null;
      if (server && server.sheet.updatedBy?.id === this.o.userId) {
        // Our own earlier save reached the server (its answer was lost): build on it.
        this.persist({ ...d, baseVersion: server.sheet.version, state: 'draft' });
        return this.send(action);
      }
      if (server) {
        this.persist({ ...d, state: 'draft' }, { kind: 'conflict', server });
        return;
      }
    }
    if (error instanceof ApiError && error.code === 'ROSTER_CHANGED') {
      const view = this.state.view;
      const students =
        (
          error.body as
            | {
                students?: {
                  studentId: string;
                  roll: number | null;
                  nameBn: string | null;
                  nameEn: string | null;
                }[];
              }
            | undefined
        )?.students ?? [];
      if (view) {
        const fresh: MarkSheetView = {
          ...view,
          students: students.map((s) => ({ ...s, studentCode: '', marks: {} })),
        };
        const merged = mergeRoster(
          { ...d, state: 'draft', submissionId: randomId() },
          fresh,
          this.o.locale,
        );
        this.state.view = {
          ...view,
          students: fresh.students.map(
            (s) => view.students.find((x) => x.studentId === s.studentId) ?? s,
          ),
        };
        this.persist(merged.draft, {
          kind: 'roster-changed',
          added: merged.added,
          removed: merged.removed,
        });
        return;
      }
    }
    const body =
      error instanceof ApiError ? (error.body as { missing?: number } | undefined) : undefined;
    this.persist(
      { ...d, state: 'draft', action: 'SAVE' },
      {
        kind: 'error',
        code: error instanceof ApiError ? error.code : undefined,
        missing: body?.missing,
      },
    );
  }

  /** Conflict: keep mine (save it on top of theirs). */
  keepMine() {
    const { sync, draft } = this.state;
    if (sync.kind !== 'conflict' || !draft) return;
    this.state.view = sync.server;
    this.persist({ ...draft, baseVersion: sync.server.sheet.version, submissionId: randomId() });
    return this.send('SAVE');
  }

  /** Conflict: keep theirs (drop my draft, show what is saved). */
  keepTheirs() {
    const { sync, draft } = this.state;
    if (sync.kind !== 'conflict' || !draft) return;
    removeMarkDraft(this.key);
    this.set({
      view: sync.server,
      draft: {
        ...draft,
        values: valuesOf(sync.server, this.o.locale),
        roster: rosterOf(sync.server),
        baseVersion: sync.server.sheet.version,
        submissionId: randomId(),
        state: 'draft',
        action: 'SAVE',
      },
      sync: { kind: 'saved', at: sync.server.sheet.updatedAt },
    });
  }
}

function parse(c: MarkSheetController, studentId: string, key: string): ParsedMarks {
  const { view, draft } = c.getSnapshot();
  const component = view?.examSubject.components.find((x) => x.key === key);
  if (!component || !draft) return { kind: 'blank' };
  return parseMarks(draft.values[cellKey(studentId, key)] ?? '', component.fullMarks);
}

/** Keep typed marks for students still on the sheet; newcomers start blank. */
export function mergeRoster(
  d: MarkDraft,
  view: MarkSheetView,
  locale: 'bn' | 'en',
): { draft: MarkDraft; added: number; removed: number } {
  const now = new Set(view.students.map((s) => s.studentId));
  const before = new Set(d.roster.map((s) => s.id));
  const values: Record<string, string> = {};
  for (const st of view.students) {
    for (const c of view.examSubject.components) {
      const k = cellKey(st.studentId, c.key);
      values[k] = before.has(st.studentId)
        ? (d.values[k] ?? '')
        : typed(view, st.studentId, c.key, locale);
    }
  }
  return {
    draft: { ...d, values, roster: rosterOf(view) },
    added: [...now].filter((id) => !before.has(id)).length,
    removed: [...before].filter((id) => !now.has(id)).length,
  };
}
