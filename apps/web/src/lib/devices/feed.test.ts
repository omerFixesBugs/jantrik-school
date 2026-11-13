import type { FeedPunch } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { elapsed, feedPath, FEED_SIZE, mergePunches, pollCursor } from './feed';

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A punch received at `received` (ISO), punched at `punched` (defaults to the same). */
const punch = (n: number, received: string, punched = received): FeedPunch => ({
  id: ID(n),
  device: { id: ID(900), name: 'Gate', gate: null },
  deviceUserId: String(100 + n),
  punchedAt: punched,
  receivedAt: received,
  localDate: '2026-10-25',
  direction: 'IN',
  verifyKind: 'FINGERPRINT',
  flags: [],
  review: null,
  outcome: null,
  person: null,
  arrival: null,
});

describe('pollCursor', () => {
  it('has no cursor before the first rows', () => {
    expect(pollCursor([])).toBeUndefined();
  });

  it('starts 60 s before the newest received row, whatever the order held', () => {
    const rows = [
      punch(1, '2026-10-25T03:00:00.000Z'),
      punch(2, '2026-10-25T03:05:00.000Z'),
      punch(3, '2026-10-25T03:01:00.000Z'),
    ];
    const ms = Date.parse('2026-10-25T03:04:00.000Z');
    expect(pollCursor(rows)).toBe(`${ms}_00000000-0000-0000-0000-000000000000`);
  });

  it('matches the API cursor format', () => {
    const cursor = pollCursor([punch(1, '2026-10-25T03:00:00.000Z')])!;
    expect(cursor).toMatch(
      /^\d{1,15}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('feedPath', () => {
  it('asks for the last 50 on the first load', () => {
    expect(feedPath({ flagged: false })).toBe('/attendance/devices/punches?limit=50');
  });

  it('polls after the cursor with room for a burst, flagged when asked', () => {
    expect(feedPath({ flagged: true, after: '1_00000000-0000-0000-0000-000000000000' })).toBe(
      '/attendance/devices/punches?limit=100&flagged=true&after=1_00000000-0000-0000-0000-000000000000',
    );
  });
});

describe('mergePunches', () => {
  it('puts newer rows on top, newest received first', () => {
    const held = [punch(2, '2026-10-25T03:02:00.000Z'), punch(1, '2026-10-25T03:01:00.000Z')];
    const merged = mergePunches(held, [punch(3, '2026-10-25T03:03:00.000Z')]);
    expect(merged.map((p) => p.id)).toEqual([ID(3), ID(2), ID(1)]);
  });

  it('keeps one row per punch, the answer replacing what was held', () => {
    const held = [punch(1, '2026-10-25T03:01:00.000Z')];
    const reviewed = { ...punch(1, '2026-10-25T03:01:00.000Z'), review: 'OK' as const };
    const merged = mergePunches(held, [reviewed]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.review).toBe('OK');
  });

  it('places a late-committed punch by its received time, below newer rows', () => {
    const held = [punch(2, '2026-10-25T03:02:00.000Z'), punch(1, '2026-10-25T03:00:00.000Z')];
    const merged = mergePunches(held, [punch(3, '2026-10-25T03:01:00.000Z')]);
    expect(merged.map((p) => p.id)).toEqual([ID(2), ID(3), ID(1)]);
  });

  it('orders one upload (same received time) by punch time, then id, newest first', () => {
    const at = '2026-10-25T03:00:00.000Z';
    const merged = mergePunches(
      [],
      [
        punch(1, at, '2026-10-25T02:58:00.000Z'),
        punch(3, at, '2026-10-25T02:59:00.000Z'),
        punch(2, at, '2026-10-25T02:59:00.000Z'),
      ],
    );
    expect(merged.map((p) => p.id)).toEqual([ID(3), ID(2), ID(1)]);
  });

  it(`keeps only the newest ${FEED_SIZE}`, () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      punch(i, new Date(Date.UTC(2026, 9, 25, 3, 0, i)).toISOString()),
    );
    const merged = mergePunches(many.slice(0, 40), many.slice(40));
    expect(merged).toHaveLength(FEED_SIZE);
    expect(merged[0]!.id).toBe(ID(69));
    expect(merged.at(-1)!.id).toBe(ID(20));
  });

  it('never puts back a review: a poll answered before it does not undo it', () => {
    const at = '2026-10-25T03:01:00.000Z';
    const reviewed = { ...punch(1, at), flags: ['NEW_IP' as const], review: 'REJECTED' as const };
    const stale = { ...punch(1, at), flags: ['NEW_IP' as const], review: null };
    const merged = mergePunches([reviewed], [stale, punch(2, '2026-10-25T03:02:00.000Z')]);
    expect(merged.map((p) => [p.id, p.review])).toEqual([
      [ID(2), null],
      [ID(1), 'REJECTED'],
    ]);
  });

  it('takes a newer review from the answer (the last decision wins)', () => {
    const at = '2026-10-25T03:01:00.000Z';
    const held = [{ ...punch(1, at), review: 'OK' as const }];
    const merged = mergePunches(held, [{ ...punch(1, at), review: 'REJECTED' as const }]);
    expect(merged[0]!.review).toBe('REJECTED');
  });

  it('starting again keeps only the answer, still without undoing a review', () => {
    const held = [
      { ...punch(1, '2026-10-25T03:01:00.000Z'), review: 'OK' as const },
      punch(2, '2026-10-25T03:02:00.000Z'),
    ];
    const merged = mergePunches(held, [punch(1, '2026-10-25T03:01:00.000Z')], { replace: true });
    expect(merged.map((p) => [p.id, p.review])).toEqual([[ID(1), 'OK']]);
  });
});

describe('elapsed', () => {
  const now = new Date('2026-10-25T04:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('counts minutes under an hour (at least one)', () => {
    expect(elapsed(ago(25 * 60_000), now)).toEqual({ unit: 'minute', value: 25 });
    expect(elapsed(ago(10_000), now)).toEqual({ unit: 'minute', value: 1 });
  });

  it('counts whole hours under two days', () => {
    expect(elapsed(ago(60 * 60_000), now)).toEqual({ unit: 'hour', value: 1 });
    expect(elapsed(ago(47 * 3600_000 + 59 * 60_000), now)).toEqual({ unit: 'hour', value: 47 });
  });

  it('counts whole days from two days', () => {
    expect(elapsed(ago(48 * 3600_000), now)).toEqual({ unit: 'day', value: 2 });
    expect(elapsed(ago(9 * 86_400_000 + 3600_000), now)).toEqual({ unit: 'day', value: 9 });
  });

  it('treats a time ahead of this clock as just now', () => {
    expect(elapsed(ago(-5 * 60_000), now)).toEqual({ unit: 'minute', value: 1 });
  });
});
