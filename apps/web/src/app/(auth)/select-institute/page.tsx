'use client';

import { useQuery } from '@tanstack/react-query';
import type { MembershipSummary } from '@jantrik/shared';
import { Building2Icon, ChevronRightIcon, LogOutIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AuthClient } from '@/lib/auth/auth-client';
import { Logo } from '@/components/brand';
import { LanguageToggle } from '@/components/language-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';

export default function SelectInstitutePage() {
  const t = useTranslations('selectInstitute');
  const tShell = useTranslations('shell');
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  const router = useRouter();
  const { client, status, session } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const autoSwitched = useRef(false);

  useEffect(() => {
    client.setPageTenant(null); // this page is not bound to an institute
    if (status === 'signed-out') router.replace('/login');
  }, [client, status, router]);

  const memberships = useQuery({
    queryKey: ['memberships', session?.user.id],
    queryFn: () => client.api<MembershipSummary[]>('/auth/memberships'),
    enabled: status === 'signed-in',
  });

  const choose = async (tenantId: string) => {
    setSwitching(tenantId);
    setError(null);
    try {
      await switchAndReload(client, tenantId);
    } catch (e) {
      setError(e);
      setSwitching(null);
    }
  };

  const selectable = memberships.data?.filter((m) => m.selectable) ?? [];
  // Exactly one institute and none selected yet: no need to ask.
  const autoTarget = !session?.tenant && selectable.length === 1 ? selectable[0]!.tenant.id : null;

  useEffect(() => {
    if (!autoTarget || autoSwitched.current) return;
    autoSwitched.current = true;
    switchAndReload(client, autoTarget).catch(() => {
      autoSwitched.current = false;
    });
  }, [autoTarget, client]);

  return (
    <main className="bg-canvas flex min-h-svh flex-1 flex-col">
      <div className="bg-brand flex items-center justify-between px-4 py-3 text-white sm:px-8">
        <Logo inverted />
        <LanguageToggle onBrand />
      </div>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 py-8 sm:py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('subtitle')}</p>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(error)}</AlertDescription>
          </Alert>
        ) : null}
        {memberships.isPending ? (
          <>
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </>
        ) : memberships.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-2">
              {describe(memberships.error)}
              <Button size="sm" variant="outline" onClick={() => void memberships.refetch()}>
                {tCommon('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : memberships.data.length === 0 ? (
          <Alert>
            <AlertDescription>{t('none')}</AlertDescription>
          </Alert>
        ) : (
          <ul className="flex flex-col gap-3" aria-label={t('title')}>
            {memberships.data.map((m) => (
              <li key={m.tenant.id}>
                <Button
                  variant="outline"
                  className="hover:border-primary/40 hover:bg-primary-soft/40 h-auto min-h-20 w-full justify-start gap-4 rounded-xl p-4 text-left whitespace-normal"
                  disabled={!m.selectable || switching !== null}
                  aria-current={session?.tenant?.id === m.tenant.id ? 'true' : undefined}
                  onClick={() => void choose(m.tenant.id)}
                >
                  <span className="bg-accent-warm-soft text-foreground flex size-11 shrink-0 items-center justify-center rounded-lg">
                    <Building2Icon aria-hidden className="size-5" />
                  </span>
                  <span className="flex flex-1 flex-col items-start gap-1">
                    <span className="font-heading text-base font-semibold">{m.tenant.name}</span>
                    {!m.selectable && <Badge variant="secondary">{t('unavailable')}</Badge>}
                  </span>
                  {(switching ?? autoTarget) === m.tenant.id ? (
                    <span className="text-muted-foreground text-sm">{t('switching')}</span>
                  ) : (
                    <ChevronRightIcon aria-hidden className="text-muted-foreground size-5" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="ghost" className="self-start" onClick={() => void client.logout()}>
          <LogOutIcon aria-hidden />
          {tShell('logout')}
        </Button>
      </div>
    </main>
  );
}

async function switchAndReload(client: AuthClient, tenantId: string): Promise<void> {
  await client.switchTenant(tenantId);
  // Full reload on purpose: no state from the previous institute may survive.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign('/dashboard');
}
