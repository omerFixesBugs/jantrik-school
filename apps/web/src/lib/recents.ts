/**
 * The palette's recent items: the last records opened from it, per person and institute, in this
 * browser only. Office computers are shared, so signing out clears them all.
 */
const PREFIX = 'jantrik.recent.v1.';
const MAX = 6;

export interface RecentItem {
  id: string;
  label: string;
  href: string;
}

const key = (userId: string, tenantId: string) => `${PREFIX}${userId}.${tenantId}`;

export function readRecents(userId: string, tenantId: string): RecentItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(userId, tenantId)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r): r is RecentItem =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as RecentItem).id === 'string' &&
          typeof (r as RecentItem).label === 'string' &&
          typeof (r as RecentItem).href === 'string' &&
          /^\/(?!\/)/.test((r as RecentItem).href), // same-site paths only, never //host
      )
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function pushRecent(userId: string, tenantId: string, item: RecentItem) {
  try {
    const next = [item, ...readRecents(userId, tenantId).filter((r) => r.id !== item.id)].slice(
      0,
      MAX,
    );
    localStorage.setItem(key(userId, tenantId), JSON.stringify(next));
  } catch {
    // Private mode: nothing is remembered.
  }
}

/** Forget every person's recent items in this browser (on sign-out). */
export function clearRecents() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    // Storage blocked: there is nothing to clear.
  }
}
