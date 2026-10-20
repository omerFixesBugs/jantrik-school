'use client';

import { toBanglaDigits, type MeContext } from '@jantrik/shared';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
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
  const pathname = usePathname();
  const navLabel = useNavLabel();
  const visible = NAV_ITEMS.filter((item) => canSee(item, context));
  return (
    <div className="flex flex-col gap-5">
      {NAV_GROUPS.map((group) => {
        const items = visible.filter((i) => i.group === group);
        if (items.length === 0) return null;
        const headingId = `nav-group-${group}`;
        return (
          <section key={group} aria-labelledby={headingId} className="flex flex-col gap-1">
            <h2
              id={headingId}
              className={cn(
                'text-muted-foreground px-3 pb-1 font-sans text-xs font-medium',
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
                        'relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[0.95rem] font-medium transition-colors',
                        'focus-visible:ring-ring/40 outline-none focus-visible:ring-3',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-primary-soft text-accent-foreground before:bg-primary before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full'
                          : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <item.icon
                        aria-hidden
                        className={cn('size-4.5 shrink-0', active && 'text-primary')}
                      />
                      <span className={cn('truncate', collapsed && 'sr-only')}>{text}</span>
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
      className={cn(
        'bg-canvas flex items-center gap-3 rounded-xl border p-3',
        collapsed && 'justify-center border-transparent bg-transparent p-0',
      )}
      title={collapsed ? context.tenant.name : undefined}
    >
      <span className="bg-accent-warm-soft text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
        <Building2Icon aria-hidden className="size-5" />
      </span>
      <div className={cn('flex min-w-0 flex-col', collapsed && 'sr-only')}>
        <span className="sr-only">{t('institute')}: </span>
        <span
          className="font-heading truncate text-[0.95rem] leading-snug font-semibold"
          data-testid={testIds ? 'institute-name' : undefined}
        >
          {context.tenant.name}
        </span>
        <span className="text-muted-foreground truncate text-xs">{type}</span>
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
        <span className="truncate text-sm font-medium">{name}</span>
        {role && <span className="text-muted-foreground truncate text-xs">{t(role)}</span>}
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
      <nav aria-label={t('navigation')} className="flex-1 overflow-y-auto px-3 py-4">
        <NavLinks context={context} collapsed={collapsed} onNavigate={onNavigate} />
      </nav>
      <div className="flex flex-col gap-3 border-t p-3">
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
  const name = displayUserName(session?.user, locale);
  const role = primaryRole(context.roles);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-11 gap-2 rounded-full px-1.5 sm:pr-3"
            aria-label={t('userMenu')}
            data-testid="user-menu"
          >
            <PersonAvatar name={name} />
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

export function AppShell({ context, children }: { context: MeContext; children: ReactNode }) {
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
      <aside
        className={cn(
          'bg-sidebar text-sidebar-foreground sticky top-0 hidden h-svh shrink-0 flex-col border-r transition-[width] duration-200 ease-out lg:flex',
          collapsed ? 'w-[76px]' : 'w-[264px]',
        )}
      >
        <div
          className={cn(
            'flex h-16 items-center gap-2 border-b px-4',
            collapsed && 'justify-center px-0',
          )}
        >
          <Link
            href="/dashboard"
            className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            <Logo compact={collapsed} />
          </Link>
        </div>
        <SidebarBody context={context} collapsed={collapsed} testIds />
        <div className={cn('px-3 pb-3', collapsed && 'flex justify-center')}>
          <Button
            variant="ghost"
            size="sm"
            className={cn('text-muted-foreground w-full justify-start', collapsed && 'w-auto')}
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
        <header className="bg-card/95 sticky top-0 z-20 flex min-h-16 items-center gap-2 border-b px-3 py-2 backdrop-blur sm:px-4 lg:px-8">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 lg:hidden"
                  aria-label={t('openMenu')}
                >
                  <MenuIcon aria-hidden className="size-5" />
                </Button>
              }
            />
            <SheetContent
              side="left"
              className="bg-sidebar flex w-[84%] max-w-80 flex-col gap-0 p-0 shadow-lg"
            >
              <div className="flex h-16 items-center border-b px-4">
                <SheetTitle render={<div />}>
                  <Logo />
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
                      className="hover:text-foreground flex items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <HouseIcon aria-hidden className="size-3.5" />
                      {tNav('dashboard')}
                    </Link>
                  </li>
                  <li aria-hidden>
                    <ChevronRightIcon className="size-3.5" />
                  </li>
                  <li>{tGroups(current.group)}</li>
                </ol>
              </nav>
            )}
            <h1 className="truncate text-lg leading-tight font-semibold sm:text-xl">{title}</h1>
            {/* Phone: the year sits under the title (no room on the right). */}
            {yearText && (
              // One line: on a very narrow screen it ends in "…" instead of wrapping over the title.
              <span className="bg-primary-soft text-accent-foreground mt-1 inline-flex h-6 w-fit max-w-full min-w-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap md:hidden">
                <CalendarDaysIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{yearText}</span>
              </span>
            )}
          </div>

          {yearText && (
            <span
              className="bg-primary-soft text-accent-foreground hidden h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium md:inline-flex"
              data-testid="academic-year"
            >
              <CalendarDaysIcon aria-hidden className="size-4" />
              {yearText}
            </span>
          )}
          <LanguageToggle />
          <UserMenu context={context} />
        </header>
        <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="bg-canvas flex min-h-svh w-full" aria-busy="true">
      <div className="bg-sidebar hidden w-[264px] shrink-0 flex-col border-r lg:flex">
        <div className="flex h-16 items-center border-b px-4">
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="bg-card flex h-16 items-center gap-3 border-b px-4 lg:px-8">
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 p-4 lg:p-8">
          <Skeleton className="h-10 w-72" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
      </div>
    </div>
  );
}
