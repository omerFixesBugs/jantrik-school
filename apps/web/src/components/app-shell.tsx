'use client';

import { toBanglaDigits, type MeContext } from '@jantrik/shared';
import { Building2Icon, LogOutIcon, MenuIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { LanguageToggle } from '@/components/language-toggle';
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';
import { canSee, NAV_ITEMS, type NavKey } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/** Nav item text. Uses tenant labels, so a coaching centre reads "Course & Batch". */
export function useNavLabel() {
  const t = useTranslations();
  const label = useLabel();
  return (key: NavKey): string => {
    switch (key) {
      case 'students':
        return t('students.title', { student: label('student', 'Student') });
      case 'sections':
        return t('nav.classesAndSections', {
          classLevel: label('class_level', 'Class'),
          section: label('section', 'Section'),
        });
      default:
        return t(`nav.${key}`);
    }
  };
}

function NavLinks({ context, onNavigate }: { context: MeContext; onNavigate?: () => void }) {
  const pathname = usePathname();
  const navLabel = useNavLabel();
  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.filter((item) => canSee(item, context)).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-sidebar-accent/60',
              )}
            >
              <item.icon aria-hidden className="size-4 shrink-0" />
              {navLabel(item.key)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function UserMenu() {
  const t = useTranslations('shell');
  const { client, session } = useAuth();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={t('userMenu')} data-testid="user-menu">
            <UserIcon aria-hidden />
            <span className="hidden max-w-32 truncate sm:inline">{session?.user.name}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        {/* Base UI: a menu label must live inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{session?.user.name}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/select-institute')}>
          <Building2Icon aria-hidden />
          {t('switchInstitute')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void client.logout()} data-testid="logout">
          <LogOutIcon aria-hidden />
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ context, children }: { context: MeContext; children: ReactNode }) {
  const t = useTranslations('shell');
  const locale = useLocale();
  const label = useLabel();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const year = context.academicYear;
  // Year names are dates: Bangla digits in the Bangla UI (see format.ts digit rule).
  const yearName = year ? (locale === 'bn' ? toBanglaDigits(year.name) : year.name) : null;

  return (
    <div className="flex min-h-svh w-full">
      <aside className="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 border-r p-3 md:block">
        <nav aria-label={t('navigation')}>
          <NavLinks context={context} />
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 sticky top-0 z-10 flex h-14 items-center gap-2 border-b px-3 backdrop-blur">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label={t('openMenu')}
                >
                  <MenuIcon aria-hidden />
                </Button>
              }
            />
            <SheetContent side="left" className="bg-sidebar w-72 p-3">
              <SheetHeader className="px-0">
                <SheetTitle>{context.tenant.name}</SheetTitle>
              </SheetHeader>
              <nav aria-label={t('navigation')}>
                <NavLinks context={context} onNavigate={() => setDrawerOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate font-semibold" data-testid="institute-name">
              {context.tenant.name}
            </span>
            {yearName && (
              <span className="text-muted-foreground truncate text-xs" data-testid="academic-year">
                {t('academicYear', {
                  label: label('academic_year', 'Academic Year'),
                  name: yearName,
                })}
              </span>
            )}
          </div>
          <LanguageToggle />
          <UserMenu />
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="flex min-h-svh w-full" aria-busy="true">
      <div className="hidden w-60 shrink-0 border-r p-3 md:block">
        <Skeleton className="mb-2 h-10 w-full" />
        <Skeleton className="mb-2 h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b px-3">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
