import type { FeedPunch } from '@jantrik/shared';

/*
 * The live punch feed on the devices screen: the last 50 punches, polled every 5 s. Each poll asks
 * only for punches received after a point 60 s before the newest row held, and merges the answer
 * by punch id: a punch another device committed late can carry an earlier received time than rows
 * already shown, and a reviewed punch comes back with its new review.
 */

/** Rows shown. */
export const FEED_SIZE = 50;
/** How often the feed polls while the page is visible. */
export const FEED_POLL_MS = 5_000;
/** How far before the newest held row a poll starts (late commits land inside it). */
export const FEED_OVERLAP_MS = 60_000;
/** A poll's page: room for a burst at a gate; only the newest FEED_SIZE are kept. */
const POLL_LIMIT = 100;
/** The cursor's id part: below every real id, so every punch at that instant is included. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The API's cursor (`"<ms>_<uuid>"`) for the next poll; none before the first rows. */
export function pollCursor(held: readonly FeedPunch[]): string | undefined {
  if (held.length === 0) return undefined;
  const newest = Math.max(...held.map((p) => Date.parse(p.receivedAt)));
  return `${Math.max(0, newest - FEED_OVERLAP_MS)}_${NIL_UUID}`;
}

/** The feed request: the last 50, or a poll after `after`; only unreviewed flagged ones if asked. */
export function feedPath({ flagged, after }: { flagged: boolean; after?: string }): string {
  const q = new URLSearchParams({ limit: String(after ? POLL_LIMIT : FEED_SIZE) });
  if (flagged) q.set('flagged', 'true');
  if (after) q.set('after', after);
  return `/attendance/devices/punches?${q.toString()}`;
}

/** The API's order: received time, then punch time, then id, newest first. */
const newestFirst = (a: FeedPunch, b: FeedPunch): number =>
  Date.parse(b.receivedAt) - Date.parse(a.receivedAt) ||
  Date.parse(b.punchedAt) - Date.parse(a.punchedAt) ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The held rows and a poll's answer as one list: one row per punch (the answer wins), newest 50. */
export function mergePunches(
  held: readonly FeedPunch[],
  incoming: readonly FeedPunch[],
  size = FEED_SIZE,
): FeedPunch[] {
  const byId = new Map(held.map((p) => [p.id, p]));
  for (const p of incoming) byId.set(p.id, p);
  return [...byId.values()].sort(newestFirst).slice(0, size);
}

export type Elapsed = { unit: 'minute' | 'hour' | 'day'; value: number };

/** How long ago `since` was, in the largest sensible unit: minutes (≥ 1), hours, from 2 days days. */
export function elapsed(since: string, now: Date): Elapsed {
  const minutes = Math.max(1, Math.floor((now.getTime() - Date.parse(since)) / 60_000));
  if (minutes < 60) return { unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: 'hour', value: hours };
  return { unit: 'day', value: Math.floor(hours / 24) };
}
