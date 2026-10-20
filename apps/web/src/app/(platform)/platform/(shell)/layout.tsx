'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3Icon,
  Building2Icon,
  HistoryIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  ReceiptTextIcon,
  SettingsIcon,
} from 'lucide-react';
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
import { DensityProvider } from '@/lib/density';
import { platformApi } from '@/lib/platform/platform-api';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/platform', key: 'navOverview', icon: LayoutDashboardIcon },
  { href: '/platform/institutes', key: 'navInstitutes', icon: Building2Icon },
  { href: '/platform/billing', key: 'navBilling', icon: ReceiptTextIcon },
  { href: '/platform/usage', key: 'navUsage', icon: BarChart3Icon },
  { href: '/platform/audit', key: 'navAudit', icon: HistoryIcon },
  { href: '/platform/settings', key: 'navSettings', icon: SettingsIcon },
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
      <div className="bg-canvas min-h-svh p-4 sm:px-6" data-board="slate">
        <Skeleton className="h-64 max-w-[1760px] rounded-lg" />
      </div>
    );
  }
  return (
    // Black slate (data-board): the same world as the institute app on a different board, so
    // Jantrik staff always know they are in the platform area (docs/design.md → App shell).
    <DensityProvider key={me.data.id} userId={me.data.id} role={null} platform>
      <div
        className="bg-canvas flex min-h-svh flex-col"
        data-board="slate"
        data-testid="platform-shell"
      >
        <a
          href="#main"
          className="bg-card text-foreground focus-visible:ring-ring sr-only z-50 rounded-md text-sm font-medium focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:px-3 focus-visible:py-2 focus-visible:ring-2"
        >
          {t('skipToContent')}
        </a>
        <header className="bg-board text-board-foreground sticky top-0 z-30">
          <div className="flex min-h-(--topbar-h) max-w-[1760px] items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Logo onBoard />
              <span className="bg-board-raised text-chalk-yellow rounded-full px-2.5 py-0.5 text-sm font-medium">
                {t('badge')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <LanguageToggle onBrand />
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
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
            className="flex max-w-[1760px] gap-1 overflow-x-auto px-2 sm:px-4"
          >
            {NAV.map((item) => {
              const active =
                item.href === '/platform'
                  ? pathname === '/platform'
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'focus-visible:ring-chalk-yellow flex min-h-(--control-h) shrink-0 items-center gap-2 rounded-t-md border-b-2 px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset',
                    active
                      ? 'border-chalk-yellow text-white'
                      : 'text-board-foreground border-transparent hover:border-white/40 hover:text-white',
                  )}
                >
                  <item.icon aria-hidden className={cn('size-4', active && 'text-chalk-yellow')} />
                  {t(item.key)}
                </Link>
              );
            })}
          </nav>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="w-full max-w-[1760px] flex-1 px-4 py-(--section-gap) outline-none sm:px-6"
        >
          {children}
        </main>
      </div>
    </DensityProvider>
  );
}
