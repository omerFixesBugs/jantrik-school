'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth/auth-provider';

/** The board's query keys (per institute), so a read or a publish can refresh them. */
export const noticeKeys = {
  board: (tenantId: string | undefined) => ['notices', tenantId, 'board'] as const,
  unread: (tenantId: string | undefined) => ['notices', tenantId, 'unread'] as const,
  manage: (tenantId: string | undefined) => ['notices', tenantId, 'manage'] as const,
};

/**
 * Unread notices for the badge. Fetched after first paint (a client query), again on focus at
 * most every 5 minutes; the API caches it per person for 2 (P6-I). Never blocks a page.
 */
export function useUnreadNotices(enabled: boolean) {
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  return useQuery({
    queryKey: noticeKeys.unread(tenantId),
    queryFn: () => client.api<{ count: number }>('/notices/unread-count'),
    enabled: enabled && Boolean(tenantId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** A date input's day (Asia/Dhaka) → the instant the notice leaves the board (that day's end). */
export function endOfDayInstant(day: string): string {
  const next = new Date(`${day}T00:00:00+06:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** A stored expiry → the date input's day (the day before the instant, Asia/Dhaka). */
export function expiryDay(instant: string): string {
  const d = new Date(new Date(instant).getTime() - 1 + 6 * 3_600_000);
  return d.toISOString().slice(0, 10);
}

/** A date and an HH:MM time picked in the form (Asia/Dhaka) → an ISO instant with offset. */
export const dhakaInstant = (day: string, time: string): string =>
  new Date(`${day}T${time}:00+06:00`).toISOString();
