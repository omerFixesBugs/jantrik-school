'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { ApiError, toApiError } from '@/lib/api/errors';
import { API_URL } from '@/lib/auth/auth-client';

/** The token the test stand-in hands out (the API's fake verifier and Cloudflare's test keys). */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<void> | null = null;
/** Loads Cloudflare's script once, only when a check is shown (never on the first paint). */
function loadScript(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.append(s);
  });
  return loading;
}

/**
 * Cloudflare Turnstile (decision P3-M). Each code request and each submit needs a fresh token.
 * Without a site key (CI, the e2e suite) a plain "I am not a robot" box stands in; only the
 * API's fake verifier accepts its token.
 */
export function TurnstileBox({
  action,
  onToken,
  resetKey,
}: {
  action: 'admission-otp' | 'admission-submit';
  onToken: (token: string) => void;
  /** Change it to get a new widget (a token is single use). */
  resetKey: number;
}) {
  const t = useTranslations('admissions.apply');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    let id: string | null = null;
    let live = true;
    void loadScript().then(() => {
      if (!live || !box.current || !window.turnstile) return;
      id = window.turnstile.render(box.current, {
        sitekey: SITE_KEY,
        action,
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    });
    return () => {
      live = false;
      if (id) window.turnstile?.remove(id);
    };
  }, [action, onToken, resetKey]);

  if (!SITE_KEY) {
    return (
      <label className="flex min-h-11 items-center gap-3 rounded-md border px-3 text-sm">
        <input
          key={resetKey}
          type="checkbox"
          className="accent-primary size-5"
          onChange={(e) => onToken(e.target.checked ? DUMMY_TOKEN : '')}
          data-testid="turnstile-standin"
        />
        {t('robotCheck')}
      </label>
    );
  }
  return <div ref={box} className="min-h-16" />;
}

/** A call to the public admission API (no session; the phone token when there is one). */
export async function publicApi<T>(
  path: string,
  init: { method?: string; json?: unknown; form?: FormData; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers['X-Admission-Token'] = init.token;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/public/admission${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      credentials: 'omit',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}
