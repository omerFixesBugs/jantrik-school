import type { MarkCell, MarkSheetView } from '@jantrik/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { AUTOSAVE_MS, cellKey, MarkSheetController } from './sheet-controller';
import { readMarkDraft, writeMarkDraft, type MarkDraft } from './sheet-drafts';

// The phone's storage and page events, as the controller uses them (no browser here).
const store = new Map<string, string>();
const localStorage = {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
Object.assign(globalThis, {
  window: { localStorage, addEventListener() {}, removeEventListener() {} },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
});

const ME = 'user-me';
const KEY = { userId: ME, tenantId: 't1', examSubjectId: 'es1', sectionId: 'sec1' };
const S1 = 'student-1';
const S2 = 'student-2';
const S3 = 'student-3';

type Marks = Record<string, number | 'ABSENT' | undefined>;

/** A sheet with one part (CQ, full 70); marks in whole numbers per student. */
function view(
  version: number,
  marks: Marks,
  opts: { by?: string; students?: string[]; mode?: MarkSheetView['mode'] } = {},
): MarkSheetView {
  const students = opts.students ?? [S1, S2];
  return {
    exam: { id: 'e1', nameBn: 'বার্ষিক', nameEn: 'Annual', status: 'OPEN', resultMode: 'GPA' },
    examSubject: {
      id: 'es1',
      subject: { id: 'sub1', code: 'BAN', nameBn: 'বাংলা', nameEn: 'Bangla' },
      studyGroupId: null,
      isElective: false,
      passRule: 'PER_COMPONENT',
      examDate: null,
      startTime: null,
      fullMarks: 70,
      components: [
        { key: 'CQ', kind: 'CQ', nameBn: 'সৃজনশীল', nameEn: 'CQ', fullMarks: 70, passMarks: 23 },
      ],
      passGroups: [],
    },
    section: {
      id: 'sec1',
      name: 'ক',
      academicYearId: 'y1',
      classLevel: { id: 'c6', code: 'CLASS_6', nameBn: 'ষষ্ঠ', nameEn: 'Six' },
    },
    sheet: {
      id: 'sheet1',
      status: 'DRAFT',
      version,
      returnNote: null,
      updatedAt: '2026-10-21T08:00:00.000Z',
      updatedBy: opts.by ? { id: opts.by, name: 'X', nameBn: null } : null,
      submittedAt: null,
      submittedBy: null,
      lockedAt: null,
      lockedBy: null,
    },
    grading: null,
    mode: opts.mode ?? 'TEACHER',
    students: students.map((id, i) => {
      const m = marks[id];
      return {
        studentId: id,
        studentCode: `S-${i}`,
        nameBn: null,
        nameEn: id,
        roll: i + 1,
        marks: (m === undefined
          ? {}
          : {
              CQ:
                m === 'ABSENT'
                  ? { scoreH: null, absent: true }
                  : { scoreH: m * 100, absent: false },
            }) as Record<string, MarkCell>,
      };
    }),
  };
}

const conflict = (server: MarkSheetView) =>
  new ApiError(409, 'VERSION_CONFLICT', 'Changed', undefined, { sheet: server });

interface Put {
  baseVersion: number;
  action: 'SAVE' | 'SUBMIT';
  submissionId: string;
  values: Record<string, string>;
}

/** A scripted API: GETs answer `current`; each PUT takes the next scripted answer. */
function harness(current: MarkSheetView) {
  const puts: Put[] = [];
  const answers: ((put: Put) => Promise<MarkSheetView>)[] = [];
  const state = { current };
  const api = vi.fn(async (_path: string, init?: { method?: string; json?: unknown }) => {
    if (!init?.method) return state.current;
    const body = init.json as {
      baseVersion: number;
      action: 'SAVE' | 'SUBMIT';
      submissionId: string;
      entries: { studentId: string; key: string; value: string }[];
    };
    const put: Put = {
      baseVersion: body.baseVersion,
      action: body.action,
      submissionId: body.submissionId,
      values: Object.fromEntries(body.entries.map((e) => [cellKey(e.studentId, e.key), e.value])),
    };
    puts.push(put);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected PUT ${puts.length}`);
    return next(put);
  });
  const controller = new MarkSheetController({
    api: api as never,
    ...KEY,
    locale: 'en',
  });
  /** The server accepts the PUT: version + 1, the values it carried, by me. */
  const accept = (put: Put) => {
    const marks: Marks = {};
    for (const [k, v] of Object.entries(put.values)) {
      const [id] = k.split(':');
      marks[id!] = v === '' ? undefined : v === 'a' ? 'ABSENT' : Number(v);
    }
    state.current = view(state.current.sheet.version + 1, marks, {
      by: ME,
      students: state.current.students.map((s) => s.studentId),
    });
    if (put.action === 'SUBMIT') state.current.sheet.status = 'SUBMITTED';
    return Promise.resolve({ ...state.current, replayed: false });
  };
  return { api, controller, puts, answers, state, accept };
}

const draft = (patch: Partial<MarkDraft>): MarkDraft => ({
  v: 1,
  ...KEY,
  title: 'Bangla',
  baseVersion: 1,
  submissionId: 'old-submission',
  values: { [cellKey(S1, 'CQ')]: '30', [cellKey(S2, 'CQ')]: '' },
  roster: [
    { id: S1, roll: 1, nameBn: null, nameEn: S1 },
    { id: S2, roll: 2, nameBn: null, nameEn: S2 },
  ],
  state: 'draft',
  action: 'SAVE',
  updatedAt: Date.now(),
  ...patch,
});

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a draft left on this phone', () => {
  it('never overwrites marks saved since on another device: the teacher chooses', async () => {
    // The phone kept 30 for student 1 (version 1); the office PC has since saved 50 (version 3).
    writeMarkDraft(draft({}));
    const h = harness(view(3, { [S1]: 50, [S2]: 40 }, { by: ME }));
    await h.controller.load();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(h.puts).toHaveLength(0);
    expect(h.controller.getSnapshot().sync.kind).toBe('conflict');
  });

  it('holding exactly what the server has is simply dropped', async () => {
    writeMarkDraft(draft({ values: { [cellKey(S1, 'CQ')]: '50', [cellKey(S2, 'CQ')]: '40' } }));
    const h = harness(view(3, { [S1]: 50, [S2]: 40 }, { by: ME }));
    await h.controller.load();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(h.puts).toHaveLength(0);
    expect(h.controller.getSnapshot().sync.kind).toBe('saved');
    expect(readMarkDraft(KEY)).toBeNull();
  });

  it('whose save reached the server (the answer was lost) goes on from there, silently', async () => {
    // Sent 30 for student 1 (outcome unknown), then typed 35 for student 2.
    writeMarkDraft(
      draft({
        state: 'pending',
        values: { [cellKey(S1, 'CQ')]: '30', [cellKey(S2, 'CQ')]: '35' },
        sent: [{ [cellKey(S1, 'CQ')]: '30', [cellKey(S2, 'CQ')]: '' }],
      }),
    );
    const h = harness(view(2, { [S1]: 30 }, { by: ME }));
    h.answers.push(h.accept);
    await h.controller.load();
    await flushPromises();
    expect(h.controller.getSnapshot().sync.kind).toBe('saved');
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.baseVersion).toBe(2);
    expect(h.puts[0]!.values[cellKey(S2, 'CQ')]).toBe('35');
  });

  it('is not used on a sheet the office is correcting', async () => {
    writeMarkDraft(draft({}));
    const h = harness(view(3, { [S1]: 50, [S2]: 40 }, { by: ME, mode: 'CORRECTION' }));
    await h.controller.load();
    expect(h.controller.getSnapshot().draft!.values[cellKey(S1, 'CQ')]).toBe('50');
  });
});

describe('a version conflict while saving', () => {
  it('with the server holding what this phone sent is resolved silently', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    // The first save reaches the server but its answer is lost.
    h.answers.push(async (put) => {
      await h.accept(put);
      throw new NetworkError();
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(h.controller.getSnapshot().sync.kind).toBe('retrying');
    h.controller.setValue(S2, 'CQ', '40');
    h.answers.push(() => Promise.reject(conflict(h.state.current)));
    h.answers.push(h.accept);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    await flushPromises();
    expect(h.controller.getSnapshot().sync.kind).toBe('saved');
    expect(h.puts.at(-1)!.values[cellKey(S2, 'CQ')]).toBe('40');
  });

  it('with marks this phone never sent (my other device) asks the teacher', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    h.answers.push(() => Promise.reject(conflict(view(4, { [S1]: 55, [S2]: 60 }, { by: ME }))));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    await flushPromises();
    expect(h.controller.getSnapshot().sync.kind).toBe('conflict');
    expect(h.puts).toHaveLength(1);
  });

  it('keeps marks typed while the refused save was on its way', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    let refuse!: () => void;
    h.answers.push(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(conflict(view(2, { [S1]: 10 }, { by: 'someone-else' })));
        }),
    );
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    h.controller.setValue(S2, 'CQ', '44');
    refuse();
    await flushPromises();
    expect(h.controller.getSnapshot().sync.kind).toBe('conflict');
    expect(h.controller.getSnapshot().draft!.values[cellKey(S2, 'CQ')]).toBe('44');
  });
});

describe('retrying', () => {
  it('"Send now" sends at once instead of waiting for the next try', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    h.answers.push(() => Promise.reject(new NetworkError()));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(h.controller.getSnapshot().sync.kind).toBe('retrying');
    h.answers.push(h.accept);
    h.controller.retryNow();
    await flushPromises();
    expect(h.puts).toHaveLength(2);
    expect(h.controller.getSnapshot().sync.kind).toBe('saved');
  });
});

describe('a changed roster', () => {
  it("keeps a newcomer's marks already on the server", async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    // Student 3 moved into this section, with 45 entered in their old one.
    const moved = view(1, { [S3]: 45 }, { by: ME, students: [S1, S2, S3] });
    h.answers.push(() => {
      h.state.current = moved;
      return Promise.reject(
        new ApiError(409, 'ROSTER_CHANGED', 'Roster', undefined, {
          students: moved.students.map(({ studentId, roll, nameBn, nameEn }) => ({
            studentId,
            roll,
            nameBn,
            nameEn,
          })),
        }),
      );
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    await flushPromises();
    const { sync, draft: d } = h.controller.getSnapshot();
    expect(sync.kind).toBe('roster-changed');
    expect(d!.values[cellKey(S3, 'CQ')]).toBe('45');
    expect(d!.values[cellKey(S1, 'CQ')]).toBe('30');
  });
});

describe('submitting', () => {
  it('a submit confirmed during a save is kept on the phone if the page is left', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    h.controller.setValue(S2, 'CQ', '40');
    h.answers.push(() => new Promise(() => {})); // the save never answers here
    h.controller.flush();
    h.controller.submit();
    h.controller.dispose();
    const stored = readMarkDraft(KEY)!;
    expect(stored.action).toBe('SUBMIT');
    expect(stored.state).toBe('pending');
  });

  it('a submit after a save gets its own request id', async () => {
    const h = harness(view(1, {}, { by: ME }));
    await h.controller.load();
    h.controller.setValue(S1, 'CQ', '30');
    h.controller.setValue(S2, 'CQ', '40');
    h.answers.push(h.accept, h.accept);
    h.controller.flush();
    await flushPromises();
    await h.controller.submit();
    expect(h.puts.map((p) => p.action)).toEqual(['SAVE', 'SUBMIT']);
    expect(h.puts[1]!.submissionId).not.toBe(h.puts[0]!.submissionId);
    expect(h.state.current.sheet.status).toBe('SUBMITTED');
  });
});
