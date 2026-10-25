import type {
  AttendanceSessionState,
  AttendanceSheet,
  AttendanceStatus,
  SheetStudent,
} from '@jantrik/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { writeDraft, type AttendanceDraft } from './drafts';
import { RegisterController } from './register-controller';

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
const TODAY = '2026-10-25';

function student(id: string, suggested: AttendanceStatus | null = null): SheetStudent {
  return {
    id,
    studentCode: `S-${id}`,
    roll: Number(id.replace(/\D/g, '')) || null,
    nameBn: null,
    nameEn: id,
    arrival:
      suggested === 'PRESENT' || suggested === 'LATE'
        ? { at: '2026-10-25T01:45:00.000Z', status: suggested }
        : null,
    suggested,
  };
}

function sheet(students: SheetStudent[], session: AttendanceSessionState | null = null) {
  return {
    today: TODAY,
    date: TODAY,
    periodNo: 0,
    mode: 'DAILY',
    section: { id: 'sec1', name: 'ক', classLevel: { id: 'c6', nameBn: 'ষষ্ঠ', nameEn: 'Six' } },
    nonWorkingDay: null,
    canSubmit: true,
    blockedReason: null,
    students,
    session,
  } satisfies AttendanceSheet;
}

function controller(answer: AttendanceSheet, put = vi.fn()) {
  const api = vi.fn(async (path: string, init?: { method?: string; json?: unknown }) => {
    if (init?.method === 'PUT') return put(init.json);
    if (path.startsWith('/attendance/sessions')) return answer;
    throw new Error(`unexpected ${path}`);
  });
  const c = new RegisterController({
    api: api as never,
    userId: ME,
    tenantId: 't1',
    sectionId: 'sec1',
    periodNo: 0,
    sectionName: 'ষষ্ঠ, ক',
  });
  return { c, api, put };
}

beforeEach(() => store.clear());

describe('a register not taken yet', () => {
  it("starts from the device's suggestion when there is one", async () => {
    const { c } = controller(
      sheet([student('s1', 'PRESENT'), student('s2', 'LATE'), student('s3', 'ABSENT')]),
    );
    await c.load();
    const { draft, sync } = c.getSnapshot();
    expect(draft?.statuses).toEqual({ s1: 'PRESENT', s2: 'LATE', s3: 'ABSENT' });
    expect(draft?.baseVersion).toBe(0);
    // Only the starting state: nothing is kept on the phone until the teacher changes something.
    expect(sync).toEqual({ kind: 'fresh' });
    expect(store.size).toBe(0);
  });

  it('starts with everyone present without a suggestion', async () => {
    const { c } = controller(sheet([student('s1'), student('s2')]));
    await c.load();
    expect(c.getSnapshot().draft?.statuses).toEqual({ s1: 'PRESENT', s2: 'PRESENT' });
  });

  it('submits the suggested statuses as the teacher left them', async () => {
    const put = vi.fn(async () => ({
      today: TODAY,
      replayed: false,
      session: {
        id: 'r1',
        version: 1,
        submittedAt: '2026-10-25T04:00:00.000Z',
        source: 'MANUAL',
        updatedBy: { id: ME, name: 'Me', nameBn: null },
        updatedByDevice: false,
        records: [],
      },
    }));
    const { c } = controller(sheet([student('s1', 'LATE'), student('s2', 'ABSENT')]), put);
    await c.load();
    c.cycle('s2'); // ABSENT → LATE
    await c.submit();
    expect(put).toHaveBeenCalledOnce();
    expect((put.mock.calls[0] as unknown[])[0]).toMatchObject({
      baseVersion: 0,
      records: [
        { studentId: 's1', status: 'LATE' },
        { studentId: 's2', status: 'LATE' },
      ],
    });
    expect(c.getSnapshot().sync.kind).toBe('saved');
  });

  it("keeps a draft's statuses and starts only new students from the suggestion", async () => {
    const stored: AttendanceDraft = {
      v: 1,
      userId: ME,
      tenantId: 't1',
      sectionId: 'sec1',
      sectionName: 'ষষ্ঠ, ক',
      date: TODAY,
      periodNo: 0,
      baseVersion: 0,
      submissionId: 'sub-1',
      statuses: { s1: 'LEAVE' },
      roster: [{ id: 's1', roll: 1, nameBn: null, nameEn: 's1' }],
      state: 'draft',
      updatedAt: Date.now(),
    };
    writeDraft(stored);
    const { c } = controller(sheet([student('s1', 'PRESENT'), student('s2', 'ABSENT')]));
    await c.load();
    const { draft, sync } = c.getSnapshot();
    expect(draft?.statuses).toEqual({ s1: 'LEAVE', s2: 'ABSENT' });
    expect(sync).toEqual({ kind: 'local' });
  });
});

describe('the device wrote the register meanwhile', () => {
  const deviceSession = (statuses: Record<string, AttendanceStatus>): AttendanceSessionState => ({
    id: 'r1',
    version: 1,
    submittedAt: '2026-10-25T03:00:00.000Z',
    source: 'DEVICE',
    updatedBy: { id: '', name: '', nameBn: null },
    updatedByDevice: true,
    records: Object.entries(statuses).map(([studentId, status]) => ({
      studentId,
      status,
      note: null,
      source: 'DEVICE' as const,
    })),
  });
  const conflict = (session: AttendanceSessionState) =>
    new ApiError(409, 'VERSION_CONFLICT', 'conflict', undefined, { session });

  it('takes it silently when it says what the screen says', async () => {
    const server = deviceSession({ s1: 'LATE', s2: 'ABSENT' });
    const put = vi.fn(async () => {
      throw conflict(server);
    });
    const { c } = controller(sheet([student('s1', 'LATE'), student('s2', 'ABSENT')]), put);
    await c.load();
    c.cycle('s2');
    c.cycle('s2');
    c.cycle('s2');
    c.cycle('s2'); // back to ABSENT: a draft on the phone, the same as the device's
    expect(store.size).toBe(1);
    await c.submit();
    expect(put).toHaveBeenCalledOnce();
    const { sync, draft, sheet: shown } = c.getSnapshot();
    expect(sync).toEqual({ kind: 'saved', submittedAt: server.submittedAt });
    expect(draft?.baseVersion).toBe(1);
    expect(shown?.session).toEqual(server);
    expect(store.size).toBe(0);
  });

  it('asks the teacher when a status differs', async () => {
    const server = deviceSession({ s1: 'LATE', s2: 'ABSENT' });
    const put = vi.fn(async () => {
      throw conflict(server);
    });
    const { c } = controller(sheet([student('s1', 'LATE'), student('s2', 'ABSENT')]), put);
    await c.load();
    c.cycle('s2'); // ABSENT → LATE
    await c.submit();
    expect(c.getSnapshot().sync).toEqual({ kind: 'conflict', server });
    expect(store.size).toBe(1);
  });
});

describe('a register taken already', () => {
  it('shows the saved statuses, a DEVICE register too', async () => {
    const session: AttendanceSessionState = {
      id: 'r1',
      version: 1,
      submittedAt: '2026-10-25T03:30:00.000Z',
      source: 'DEVICE',
      updatedBy: { id: '', name: '', nameBn: null },
      updatedByDevice: true,
      records: [
        { studentId: 's1', status: 'LATE', note: null, source: 'DEVICE' },
        { studentId: 's2', status: 'ABSENT', note: null, source: 'DEVICE' },
      ],
    };
    // The API never suggests once a register exists; a stray suggestion is ignored all the same.
    const { c } = controller(sheet([student('s1', 'PRESENT'), student('s2', null)], session));
    await c.load();
    const { draft, sync } = c.getSnapshot();
    expect(draft?.statuses).toEqual({ s1: 'LATE', s2: 'ABSENT' });
    expect(draft?.baseVersion).toBe(1);
    expect(sync).toEqual({ kind: 'saved', submittedAt: session.submittedAt });
  });
});
