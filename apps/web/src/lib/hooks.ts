'use client';

import { useQuery } from '@tanstack/react-query';
import type { MeContext } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LOCALE_COOKIE, type Locale } from '@/i18n/config';
import { ApiError, NetworkError } from './api/errors';
import { useAuth } from './auth/auth-provider';

/** Translated, user-facing message for any error thrown by the API client. */
export function useErrorMessage() {
  const t = useTranslations('errors');
  return useCallback(
    (error: unknown): string => {
      if (error instanceof NetworkError) return t('network');
      if (error instanceof ApiError) {
        if (error.status === 401) return t('invalidCredentials');
        if (error.status === 403) return t('forbidden');
        if (error.status === 429) return t('rateLimited', { seconds: error.retryAfter ?? 60 });
      }
      return t('generic');
    },
    [t],
  );
}

/** Seconds left until `until` (epoch ms), ticking every second; 0 when done. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

/** Switch the UI language: cookie (works on /login) + the user's saved preference. */
export function useSetLocale() {
  const router = useRouter();
  const { client, status } = useAuth();
  return useCallback(
    async (locale: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
      if (status === 'signed-in') {
        await client
          .api('/me/preferences', { method: 'PATCH', json: { locale } })
          .catch(() => undefined);
      }
      router.refresh();
    },
    [client, router, status],
  );
}

/** GET /me/context for the selected institute (loaded once per page). */
export function useMeContext(enabled = true) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['me-context', session?.tenant?.id],
    queryFn: () => client.api<MeContext>('/me/context'),
    enabled: enabled && Boolean(session?.tenant),
    staleTime: 5 * 60_000,
  });
}

/**
 * Tenant UI label (from tenant_labels), e.g. `section` → "ব্যাচ" for a coaching centre and
 * "শাখা" for a school. Never branch on institute type in code; use labels.
 */
export function useLabel() {
  const locale = useLocale() as Locale;
  const { data } = useMeContext();
  return useCallback(
    (key: string, fallback: string) => data?.labels[key]?.[locale] ?? fallback,
    [data, locale],
  );
}

/** Debounced copy of a value. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
