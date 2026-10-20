'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { randomId } from '@/lib/uuid';

/*
 * Table state that outlives the page (docs/design.md → Principles 6): filters and sort live in the
 * URL (Back returns to the same view, a link shares it); column choices and saved views are
 * personal, per browser, keyed by person and institute (or "platform"), versioned.
 */

/** URL query params as state. `set` merges a patch (null removes a key) and keeps the scroll. */
export function useUrlParams(): {
  params: URLSearchParams;
  set: (patch: Record<string, string | null>) => void;
  replace: (query: string) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const params = useMemo(() => new URLSearchParams(search.toString()), [search]);
  const replace = useCallback(
    (query: string) => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }),
    [router, pathname],
  );
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      replace(next.toString());
    },
    [search, replace],
  );
  return { params, set, replace };
}

function readJson<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Which columns a person has hidden in one table (`scope` = `${userId}.${tenantId}`). */
export function useHiddenColumns(
  scope: string,
  table: string,
  defaults: readonly string[] = [],
): [string[], (hidden: string[]) => void] {
  const key = `jantrik.table.v1.${scope}.${table}`;
  const [hidden, setHidden] = useState<string[]>(() => readJson(key, isStringArray, [...defaults]));
  const update = useCallback(
    (next: string[]) => {
      writeJson(key, next);
      setHidden(next);
    },
    [key],
  );
  return [hidden, update];
}

export interface SavedView {
  id: string;
  name: string;
  /** The URL query the view stands for (filters and sort), without the leading "?". */
  query: string;
}

const isViews = (v: unknown): v is SavedView[] =>
  Array.isArray(v) &&
  v.every(
    (x) =>
      typeof x === 'object' &&
      x !== null &&
      typeof (x as SavedView).id === 'string' &&
      typeof (x as SavedView).name === 'string' &&
      typeof (x as SavedView).query === 'string',
  );

/** A person's saved views of one table. */
export function useSavedViews(scope: string, table: string) {
  const key = `jantrik.views.v1.${scope}.${table}`;
  const [views, setViews] = useState<SavedView[]>(() => readJson(key, isViews, []));
  const save = useCallback(
    (name: string, query: string) => {
      const next = [...views, { id: randomId(), name: name.trim(), query }];
      writeJson(key, next);
      setViews(next);
    },
    [key, views],
  );
  const remove = useCallback(
    (id: string) => {
      const next = views.filter((v) => v.id !== id);
      writeJson(key, next);
      setViews(next);
    },
    [key, views],
  );
  return { views, save, remove };
}

/** The same query regardless of parameter order (to tell which saved view is showing). */
export function canonicalQuery(query: string, keys: readonly string[]): string {
  const p = new URLSearchParams(query);
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = p.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}
