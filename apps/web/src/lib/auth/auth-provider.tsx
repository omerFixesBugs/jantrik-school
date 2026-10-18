'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AuthTenant } from '@jantrik/shared';
import { AuthClient, type Session } from './auth-client';

/**
 * `unreachable`: the session could not be restored because the API did not answer (network
 * error, 5xx). Nothing is signed out: the app shows a "connecting…" screen and retries. Only a
 * real 401 from the refresh endpoint means signed out.
 */
type Status = 'loading' | 'signed-in' | 'signed-out' | 'unreachable';

interface AuthState {
  client: AuthClient;
  status: Status;
  session: Session | null;
  /** Try restoring the session again now (the "unreachable" screen's button). */
  retry: () => void;
}

/** Waits between session-restore attempts while the API is unreachable (ms). */
const RETRY_DELAYS = [2_000, 4_000, 8_000, 15_000, 30_000];

const AuthContext = createContext<AuthState | null>(null);

/** One AuthClient per tab. Exposes the session and handles cross-tab events. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Browser only. During server rendering no effect or event handler runs, so the client is
  // never used there.
  const [client] = useState(() =>
    typeof window === 'undefined' ? (null as unknown as AuthClient) : new AuthClient(),
  );

  const [status, setStatus] = useState<Status>(() =>
    client?.getSession() ? 'signed-in' : 'loading',
  );
  const [session, setSession] = useState<Session | null>(() => client?.getSession() ?? null);
  const [changedTo, setChangedTo] = useState<AuthTenant | null | undefined>(undefined);

  useEffect(() => {
    return client.subscribe((event) => {
      if (event.type === 'session') {
        setSession(event.session);
        setStatus('signed-in');
      } else if (event.type === 'signed-out') {
        // Logout in any tab clears this tab too.
        queryClient.clear();
        setSession(null);
        setStatus('signed-out');
      } else if (event.type === 'tenant-changed') {
        // Discard in-progress state; the dialog blocks the page until it reloads.
        void queryClient.cancelQueries();
        queryClient.clear();
        setChangedTo(event.tenant);
      }
    });
  }, [client, queryClient]);

  // Restore the session; while the API is unreachable, try again with backoff, when the browser
  // comes back online, and when the tab becomes visible.
  const [attempt, setAttempt] = useState(0);
  const pending = status === 'loading' || status === 'unreachable';
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    client
      .bootstrap()
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setStatus(s ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (!cancelled) setStatus('unreachable');
      });
    return () => {
      cancelled = true;
    };
    // `attempt` re-runs the restore; `pending` stops it once it succeeded.
  }, [client, attempt, pending]);

  useEffect(() => {
    if (status !== 'unreachable') return;
    const again = () => setAttempt((n) => n + 1);
    const timer = setTimeout(again, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
    const onVisible = () => document.visibilityState === 'visible' && again();
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, attempt]);

  const retry = () => setAttempt((n) => n + 1);

  return (
    <AuthContext.Provider value={{ client, status, session, retry }}>
      {children}
      <TenantChangedDialog tenant={changedTo} />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Blocking: no close button, no outside-click dismissal; the only way on is to reload. */
function TenantChangedDialog({ tenant }: { tenant: AuthTenant | null | undefined }) {
  const t = useTranslations('tenantChanged');
  return (
    <Dialog open={tenant !== undefined} disablePointerDismissal onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} data-testid="tenant-changed-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body', { name: tenant?.name ?? t('unknown') })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* Full reload on purpose: nothing from the previous institute may survive. */}
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
          <Button onClick={() => window.location.assign('/dashboard')}>{t('reload')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
