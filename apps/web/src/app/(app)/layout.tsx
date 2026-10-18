'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import { AppShell, ShellSkeleton } from '@/components/app-shell';
import { ConnectionScreen } from '@/components/connection-screen';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { NetworkError } from '@/lib/api/errors';
import { useErrorMessage, useMeContext } from '@/lib/hooks';

/**
 * Protected area. UX routing only — the API is the security boundary:
 * signed out → /login, no institute selected → /select-institute, otherwise the page is bound
 * to the session's institute (sent as X-Jantrik-Tenant) and /me/context is loaded once.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { client, status, session, retry } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const describe = useErrorMessage();
  // The page is bound to the first institute it sees. If the session later moves to another
  // institute, AuthClient blocks the page and shows the "institute changed" dialog instead of
  // following silently.
  const boundTenant =
    client?.getPageTenant() ?? (status === 'signed-in' ? (session?.tenant?.id ?? null) : null);

  useEffect(() => {
    if (status === 'signed-out') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (status === 'signed-in' && session && !client.getPageTenant()) {
      if (session.tenant) client.setPageTenant(session.tenant.id);
      else router.replace('/select-institute');
    }
  }, [status, session, client, router, pathname]);

  const context = useMeContext(Boolean(boundTenant));

  // The API can't be reached: keep the person signed in and keep trying.
  if (status === 'unreachable') return <ConnectionScreen onRetry={retry} />;
  if (context.isError && context.error instanceof NetworkError) {
    return <ConnectionScreen onRetry={() => void context.refetch()} />;
  }
  if (!boundTenant || context.isPending) return <ShellSkeleton />;
  if (context.isError) {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertDescription className="flex flex-col gap-3">
            {describe(context.error)}
            <Button variant="outline" onClick={() => void context.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    );
  }
  return <AppShell context={context.data}>{children}</AppShell>;
}
