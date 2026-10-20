'use client';

import { isDensity, toBanglaDigits, type MeContext } from '@jantrik/shared';
import {
  Building2Icon,
  CalendarDaysIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HouseIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Logo } from '@/components/brand';
import { LanguageToggle } from '@/components/language-toggle';
import { PersonAvatar } from '@/components/person-avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { DensityProvider, useDensity } from '@/lib/density';
import { useLabel } from '@/lib/hooks';
import { displayUserName } from '@/lib/names';
import {
  canSee,
  NAV_GROUPS,
  NAV_ITEMS,
  navItemForPath,
  primaryRole,
  type NavKey,
} from '@/lib/navigation';
import { cn } from '@/lib/utils';

const COLLAPSED_KEY = 'jantrik.sidebar.collapsed';

/** Nav item text. Uses tenant labels, so a coaching centre reads "Course & Batch". */
export function useNavLabel() {
  const t = useTranslations();
  const label = useLabel();
  return (key: NavKey): string => {
    switch (key) {
      case 'students':
        return t('students.title', { student: label('student', 'Student') });
      case 'setup':
        return t('nav.setup');
      case 'staff':
        return t('nav.staff');
      default:
        return t(`nav.${key}`);
    }
  };
}

/** "শিক্ষাবর্ষ ২০২৬" / "Session 2026" — year names are dates, so Bangla digits in Bangla. */
function useYearText(context: MeContext): string | null {
  const t = useTranslations('shell');
  const locale = useLocale();
  const label = useLabel();
  const year = context.academicYear;
  if (!year) return null;
  return t('academicYear', {
    label: label('academic_year', 'Academic Year'),
    name: locale === 'bn' ? toBanglaDigits(year.name) : year.name,
  });
}

/** The sidebar's links, in chalk on the blackboard (docs/design.md → App shell). */
function NavLinks({
  context,
  collapsed,
  onNavigate,
}: {
  context: MeContext;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations('navGroups');
  const tShell = useTranslations('shell');
  const pathname = usePathname();
  const navLabel = useNavLabel();
  const visible = NAV_ITEMS.filter((item) => canSee(item, context));
  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => {
        const items = visible.filter((i) => i.group === group);
        if (items.length === 0) return null;
        const headingId = `nav-group-${group}`;
        return (
          <section key={group} aria-labelledby={headingId} className="flex flex-col gap-0.5">
            <h2
              id={headingId}
              className={cn(
                'text-board-muted px-3 pb-1 text-xs font-medium',
                collapsed && 'sr-only',
              )}
            >
              {t(group)}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const text = navLabel(item.key);
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? text : undefined}
                      className={cn(
                        'flex min-h-(--control-h) items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                        'focus-visible:ring-chalk-yellow outline-none focus-visible:ring-2',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-board-raised text-white'
                          : 'text-board-foreground hover:bg-board-raised/70 hover:text-white',
                      )}
                    >
                      <item.icon
                        aria-hidden
                        className={cn('size-4.5 shrink-0', active && 'text-chalk-yellow')}
                      />
                      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'sr-only')}>
                        {text}
                      </span>
                      {item.soon && (
                        <span
                          className={cn(
                            'text-board-muted border-board-line rounded-full border px-1.5 text-xs leading-5 font-normal',
                            collapsed && 'sr-only',
                          )}
                        >
                          {tShell('soon')}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Which institute you are working in: always visible, so nobody edits the wrong one. */
function InstituteCard({
  context,
  collapsed,
  testIds,
}: {
  context: MeContext;
  collapsed?: boolean;
  testIds?: boolean;
}) {
  const t = useTranslations('shell');
  const locale = useLocale() as Locale;
  const type =
    locale === 'bn' ? context.tenant.instituteType.nameBn : context.tenant.instituteType.nameEn;
  return (
    <div
      className={cn('flex items-center gap-3 px-1', collapsed && 'justify-center px-0')}
      title={collapsed ? context.tenant.name : undefined}
    >
      <span className="bg-board-raised text-chalk-yellow flex size-9 shrink-0 items-center justify-center rounded-md">
        <Building2Icon aria-hidden className="size-4.5" />
      </span>
      <div className={cn('flex min-w-0 flex-col', collapsed && 'sr-only')}>
        <span className="sr-only">{t('institute')}: </span>
        <span
          className="truncate text-sm leading-snug font-semibold text-white"
          data-testid={testIds ? 'institute-name' : undefined}
        >
          {context.tenant.name}
        </span>
        <span className="text-board-muted truncate text-xs">{type}</span>
      </div>
    </div>
  );
}

function UserCard({ context, collapsed }: { context: MeContext; collapsed?: boolean }) {
  const t = useTranslations('roles');
  const locale = useLocale() as Locale;
  const { session } = useAuth();
  const name = displayUserName(session?.user, locale);
  const role = primaryRole(context.roles);
  return (
    <div className={cn('flex items-center gap-3 px-1', collapsed && 'justify-center px-0')}>
      <PersonAvatar name={name} />
      <div className={cn('flex min-w-0 flex-col leading-tight', collapsed && 'sr-only')}>
        <span className="truncate text-sm font-medium text-white">{name}</span>
        {role && <span className="text-board-muted truncate text-xs">{t(role)}</span>}
      </div>
    </div>
  );
}

function SidebarBody({
  context,
  collapsed,
  onNavigate,
  testIds,
}: {
  context: MeContext;
  collapsed?: boolean;
  onNavigate?: () => void;
  testIds?: boolean;
}) {
  const t = useTranslations('shell');
  return (
    <>
      <nav aria-label={t('navigation')} className="flex-1 overflow-y-auto px-2.5 py-3">
        <NavLinks context={context} collapsed={collapsed} onNavigate={onNavigate} />
      </nav>
      <div className="border-board-line bg-board-deep flex flex-col gap-3 border-t p-3">
        <InstituteCard context={context} collapsed={collapsed} testIds={testIds} />
        <UserCard context={context} collapsed={collapsed} />
      </div>
    </>
  );
}

function UserMenu({ context }: { context: MeContext }) {
  const t = useTranslations('shell');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const router = useRouter();
  const { density, setDensity } = useDensity();
  const name = displayUserName(session?.user, locale);
  const role = primaryRole(context.roles);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="gap-2 rounded-full ps-1 pe-1 sm:pe-2.5"
            aria-label={t('userMenu')}
            data-testid="user-menu"
          >
            <PersonAvatar name={name} size="sm" className="size-7 data-[size=sm]:size-7" />
            <span className="hidden max-w-36 truncate text-sm font-medium xl:inline">{name}</span>
            <ChevronDownIcon aria-hidden className="text-muted-foreground hidden sm:block" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        {/* Base UI: a menu label must live inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-3 px-2.5 py-2">
            <PersonAvatar name={name} size="lg" />
            <span className="flex min-w-0 flex-col">
              <span className="text-foreground truncate text-sm font-semibold">{name}</span>
              {role && <span className="truncate text-xs">{tRoles(role)}</span>}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={density}
          onValueChange={(value) => {
            if (isDensity(value)) setDensity(value);
          }}
        >
          <DropdownMenuLabel>{t('density')}</DropdownMenuLabel>
          <DropdownMenuRadioItem value="compact" data-testid="density-compact">
            {t('densityCompact')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable" data-testid="density-comfortable">
            {t('densityComfortable')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/select-institute')}>
          <Building2Icon aria-hidden />
          {t('switchInstitute')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void client.logout()}
          data-testid="logout"
        >
          <LogOutIcon aria-hidden />
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The institute app's frame. Applies the signed-in person's density (lib/density.tsx). */
export function AppShell({ context, children }: { context: MeContext; children: ReactNode }) {
  const { session } = useAuth();
  return (
    <DensityProvider
      key={session?.user.id ?? 'none'}
      userId={session?.user.id ?? 'none'}
      role={primaryRole(context.roles)}
    >
      <Shell context={context}>{children}</Shell>
    </DensityProvider>
  );
}

function Shell({ context, children }: { context: MeContext; children: ReactNode }) {
  const t = useTranslations('shell');
  const tGroups = useTranslations('navGroups');
  const tNav = useTranslations('nav');
  const pathname = usePathname();
  const navLabel = useNavLabel();
  const yearText = useYearText(context);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // AppShell only renders in the browser (it needs the session), so reading storage here is safe.
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };

  const current = navItemForPath(pathname);
  const title = current ? navLabel(current.key) : '';

  return (
    <div className="bg-canvas flex min-h-svh w-full">
      {/* Keyboard users skip the sidebar and the top bar (about a dozen stops) on every page. */}
      <a
        href="#main"
        className="bg-card text-foreground focus-visible:ring-ring sr-only z-50 rounded-md text-sm font-medium focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:px-3 focus-visible:py-2 focus-visible:ring-2"
      >
        {t('skipToContent')}
      </a>
      {/* The blackboard: the sidebar on desktop (the drawer on phones, below). */}
      <aside
        className={cn(
          'bg-sidebar text-sidebar-foreground sticky top-0 hidden h-svh shrink-0 flex-col transition-[width] duration-200 ease-out lg:flex',
          collapsed ? 'w-16' : 'w-62',
        )}
      >
        <div
          className={cn(
            'border-board-line flex h-(--topbar-h) shrink-0 items-center gap-2 border-b px-4',
            collapsed && 'justify-center px-0',
          )}
        >
          <Link
            href="/dashboard"
            className="focus-visible:ring-chalk-yellow rounded-md outline-none focus-visible:ring-2"
          >
            <Logo compact={collapsed} onBoard />
          </Link>
        </div>
        <SidebarBody context={context} collapsed={collapsed} testIds />
        <div className={cn('bg-board-deep px-2.5 pb-2.5', collapsed && 'flex justify-center')}>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              // aria-expanded marks the sidebar's state, not an open menu: no ghost-button fill.
              'text-board-muted hover:bg-board-raised aria-expanded:text-board-muted focus-visible:ring-chalk-yellow focus-visible:ring-offset-board w-full justify-start hover:text-white aria-expanded:bg-transparent',
              collapsed && 'w-auto',
            )}
            onClick={toggleCollapsed}
            aria-label={collapsed ? t('expand') : t('collapse')}
            aria-expanded={!collapsed}
            title={collapsed ? t('expand') : undefined}
          >
            {collapsed ? (
              <PanelLeftOpenIcon aria-hidden className="size-4.5" />
            ) : (
              <>
                <PanelLeftCloseIcon aria-hidden className="size-4.5" />
                {t('collapse')}
              </>
            )}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-card sticky top-0 z-20 flex h-(--topbar-h) items-center gap-2 border-b px-3 sm:px-6">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden"
                  aria-label={t('openMenu')}
                >
                  <MenuIcon aria-hidden className="size-5" />
                </Button>
              }
            />
            <SheetContent
              side="left"
              className="bg-sidebar text-sidebar-foreground flex w-[84%] max-w-80 flex-col gap-0 border-0 p-0 data-[side=left]:border-r-0"
            >
              <div className="border-board-line flex h-(--topbar-h) shrink-0 items-center border-b px-4">
                <SheetTitle render={<div />}>
                  <Logo onBoard />
                </SheetTitle>
              </div>
              <SidebarBody context={context} onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col justify-center">
            {current && current.key !== 'dashboard' && (
              <nav aria-label={t('breadcrumb')} className="hidden sm:block">
                <ol className="text-muted-foreground flex items-center gap-1 text-xs">
                  <li>
                    <Link
                      href="/dashboard"
                      className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded outline-none focus-visible:ring-2"
                    >
                      <HouseIcon aria-hidden className="size-3.5" />
                      {tNav('dashboard')}
                    </Link>
                  </li>
                  <li aria-hidden>
                    <ChevronRightIcon className="size-3.5 rtl:rotate-180" />
                  </li>
                  <li>{tGroups(current.group)}</li>
                </ol>
              </nav>
            )}
            <h1 className="truncate text-lg leading-tight font-semibold">{title}</h1>
            {/* Phone: the year sits under the title (no room on the right). */}
            {yearText && (
              // One line: on a very narrow screen it ends in "…" instead of wrapping over the title.
              <span className="text-muted-foreground mt-0.5 inline-flex w-fit max-w-full min-w-0 items-center gap-1 text-xs whitespace-nowrap md:hidden">
                <CalendarDaysIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{yearText}</span>
              </span>
            )}
          </div>

          {yearText && (
            // A fact, not a control: plain text, so it never looks clickable.
            <span
              className="text-muted-foreground hidden shrink-0 items-center gap-1.5 text-sm md:inline-flex"
              data-testid="academic-year"
            >
              <CalendarDaysIcon aria-hidden className="size-4" />
              {yearText}
            </span>
          )}
          <LanguageToggle />
          <UserMenu context={context} />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="flex w-full max-w-[1760px] flex-1 flex-col gap-(--section-gap) px-4 py-(--section-gap) outline-none sm:px-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="bg-canvas flex min-h-svh w-full" aria-busy="true">
      <div className="bg-sidebar hidden w-62 shrink-0 flex-col lg:flex">
        <div className="border-board-line flex h-(--topbar-h) items-center border-b px-4">
          <Skeleton className="bg-board-raised h-8 w-36" />
        </div>
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="bg-board-raised h-(--control-h) w-full" />
          <Skeleton className="bg-board-raised h-(--control-h) w-full" />
          <Skeleton className="bg-board-raised h-(--control-h) w-full" />
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="bg-card flex min-h-(--topbar-h) items-center gap-3 border-b px-4 sm:px-6">
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="flex w-full max-w-[1760px] flex-col gap-(--section-gap) px-4 py-(--section-gap) sm:px-6">
          <Skeleton className="h-10 w-72" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        </div>
      </div>
    </div>
  );
}
