'use client';

import { useQueryClient } from '@tanstack/react-query';
import { HistoryIcon, LayoutDashboardIcon, LogOutIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Logo } from '@/components/brand';
import { LanguageToggle } from '@/components/language-toggle';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/errors';
import { usePlatformMe } from '@/lib/platform/hooks';
import { platformApi } from '@/lib/platform/platform-api';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/platform', key: 'navOverview', icon: LayoutDashboardIcon },
  { href: '/platform/audit', key: 'navAudit', icon: HistoryIcon },
] as const;

/** Platform area shell: its own header and nav, never the institute app shell. */
export default function PlatformShellLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('platform');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = usePlatformMe();
  const signedOut = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (signedOut) router.replace('/platform/login');
  }, [signedOut, router]);

  const logout = async () => {
    await platformApi('/platform/auth/logout', { method: 'POST' }).catch(() => undefined);
    queryClient.clear();
    router.replace('/platform/login');
  };

  if (!me.data) {
    return (
      <div className="bg-canvas min-h-svh p-4">
        <Skeleton className="mx-auto h-64 max-w-[1200px] rounded-xl" />
      </div>
    );
  }
  return (
    <div className="bg-canvas flex min-h-svh flex-col" data-testid="platform-shell">
      <header className="bg-brand sticky top-0 z-30 text-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Logo inverted />
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-sm font-medium">
              {t('badge')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle onBrand />
            <Button
              size="sm"
              variant="outline"
              className="h-9 rounded-full border-white/30 bg-white/10 text-white shadow-none hover:bg-white/20 hover:text-white"
              onClick={() => void logout()}
              data-testid="platform-logout"
            >
              <LogOutIcon aria-hidden />
              <span className="hidden sm:inline">{t('logout')}</span>
              <span className="sr-only sm:hidden">{t('logout')}</span>
            </Button>
          </div>
        </div>
        <nav
          aria-label={t('nav')}
          className="mx-auto flex max-w-[1200px] gap-1 overflow-x-auto px-2 sm:px-4 lg:px-6"
        >
          {NAV.map((item) => {
            const active =
              item.href === '/platform' ? pathname === '/platform' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-2 border-b-[3px] px-3 py-2.5 text-sm font-medium',
                  active
                    ? 'border-accent-warm font-semibold text-white'
                    : 'border-transparent text-white hover:border-white/40',
                )}
              >
                <item.icon aria-hidden className="size-4" />
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </div>
  );
}
