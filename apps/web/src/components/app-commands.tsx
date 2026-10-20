'use client';

import {
  createGoSequence,
  isHelpShortcut,
  isNewShortcut,
  isPaletteShortcut,
  isSearchShortcut,
  type MeContext,
  type Role,
  type StudentsPage,
} from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Building2Icon,
  CalendarCheckIcon,
  ClipboardListIcon,
  FileSpreadsheetIcon,
  HistoryIcon,
  KeyboardIcon,
  LanguagesIcon,
  LogOutIcon,
  Rows3Icon,
  SearchIcon,
  UserPlusIcon,
  UserRoundIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CommandPalette,
  isApple,
  Kbd,
  matches,
  normalizeQuery,
  type PaletteCommand,
  type PaletteGroup,
} from '@/components/command-palette';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useDensity } from '@/lib/density';
import { useSetLocale } from '@/lib/hooks';
import { classLevelName, displayName } from '@/lib/names';
import { useLabel } from '@/lib/hooks';
import { canSee, NAV_ITEMS, navItem } from '@/lib/navigation';
import { clearRecents, pushRecent, readRecents } from '@/lib/recents';
import { useNavLabel } from '@/lib/nav-label';

/** Roles the API lets admit, import and add staff (the same as their pages' buttons). */
const OFFICE: Role[] = ['OWNER', 'ADMIN'];

/** Never fire a shortcut while someone types (an input, a select, an editor, the palette). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="combobox"]') !== null
  );
}

/** A dialog, menu or list is open: page shortcuts would act behind it (and lose its input). */
const overlayOpen = () =>
  document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  ) !== null;

/**
 * The institute app's palette and keyboard layer: Ctrl/⌘ K, `?`, `/` (the page's search), `n`
 * (the page's "add" button) and `g` + letter. Rendered once by the shell.
 */
export function AppCommands({
  context,
  open,
  onOpenChange,
}: {
  context: MeContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('palette');
  const tShell = useTranslations('shell');
  const tCommon = useTranslations('common');
  const label = useLabel();
  const student = label('student', 'Student', { inText: true });
  const locale = useLocale() as Locale;
  const router = useRouter();
  const navLabel = useNavLabel();
  const { client, session } = useAuth();
  const { density, toggle } = useDensity();
  const setLocale = useSetLocale();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [help, setHelp] = useState(false);
  const userId = session?.user.id ?? 'none';
  const tenantId = context.tenant.id;
  const roles = context.roles;
  const office = roles.some((r) => OFFICE.includes(r));
  const seesStudents = canSee(navItem('students'), context);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(normalizeQuery(query)), 200);
    return () => clearTimeout(id);
  }, [query]);
  // A closed palette starts empty next time.
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setQuery('');
      onOpenChange(next);
    },
    [onOpenChange, setQuery],
  );

  const go = useCallback(
    (href: string, recent?: { id: string; label: string }) => {
      if (recent) pushRecent(userId, tenantId, { ...recent, href });
      router.push(href);
    },
    [router, userId, tenantId],
  );

  // Pages: the same rules as the sidebar, plus the pages under them.
  const pages: PaletteCommand[] = useMemo(() => {
    const out: PaletteCommand[] = NAV_ITEMS.filter((i) => canSee(i, context) && !i.soon).map(
      (i) => ({
        id: `page:${i.key}`,
        label: navLabel(i.key),
        icon: i.icon,
        run: () => go(i.href),
      }),
    );
    if (canSee(navItem('attendance'), context)) {
      out.push(
        {
          id: 'page:today',
          label: t('pageToday'),
          icon: ClipboardListIcon,
          run: () => go('/attendance/today'),
        },
        {
          id: 'page:register',
          label: t('pageRegister'),
          icon: ClipboardListIcon,
          run: () => go('/attendance/register'),
        },
      );
    }
    return out;
  }, [context, navLabel, t, go]);

  const actions: PaletteCommand[] = useMemo(() => {
    const out: PaletteCommand[] = [];
    if (canSee(navItem('attendance'), context))
      out.push({
        id: 'act:take',
        label: t('takeAttendance'),
        icon: CalendarCheckIcon,
        run: () => go('/attendance'),
      });
    if (office && seesStudents) {
      out.push(
        {
          id: 'act:admit',
          label: t('admit', { student }),
          icon: UserPlusIcon,
          run: () => go('/students/new'),
        },
        {
          id: 'act:import',
          label: t('import', { student }),
          icon: FileSpreadsheetIcon,
          run: () => go('/students/import'),
        },
      );
    }
    out.push(
      {
        id: 'act:language',
        label: t('language', {
          language: locale === 'bn' ? tCommon('switchToEnglish') : tCommon('switchToBangla'),
        }),
        keywords: t('languageKeywords'),
        icon: LanguagesIcon,
        run: () => setLocale(locale === 'bn' ? 'en' : 'bn'),
      },
      {
        id: 'act:density',
        label: density === 'compact' ? tShell('densityComfortable') : tShell('densityCompact'),
        keywords: t('densityKeywords'),
        icon: Rows3Icon,
        run: toggle,
      },
      {
        id: 'act:shortcuts',
        label: t('shortcuts'),
        hint: '?',
        icon: KeyboardIcon,
        run: () => setHelp(true),
      },
      {
        id: 'act:institute',
        label: tShell('switchInstitute'),
        icon: Building2Icon,
        run: () => go('/select-institute'),
      },
      {
        id: 'act:logout',
        label: tShell('logout'),
        icon: LogOutIcon,
        run: () => {
          clearRecents();
          void client.logout();
        },
      },
    );
    return out;
  }, [
    context,
    office,
    seesStudents,
    student,
    locale,
    density,
    t,
    tShell,
    tCommon,
    toggle,
    setLocale,
    go,
    client,
  ]);

  const students = useQuery({
    queryKey: ['palette-students', tenantId, debounced],
    enabled: open && seesStudents && debounced.length >= 2,
    queryFn: () =>
      client.api<StudentsPage>(`/students?${new URLSearchParams({ q: debounced, pageSize: '8' })}`),
    staleTime: 10_000,
  });

  const q = normalizeQuery(query);
  const groups: PaletteGroup[] = [];
  if (!q) {
    const recents = readRecents(userId, tenantId);
    groups.push({
      id: 'recent',
      label: t('recent'),
      items: recents.map((r) => ({
        id: `recent:${r.id}`,
        label: r.label,
        icon: HistoryIcon,
        run: () => go(r.href, r),
      })),
    });
  }
  // Pages and actions first: they are there at once, so Enter never jumps when records arrive.
  groups.push({ id: 'pages', label: t('pages'), items: pages.filter((c) => matches(c, q)) });
  groups.push({ id: 'actions', label: t('actions'), items: actions.filter((c) => matches(c, q)) });
  groups.push({
    id: 'students',
    label: label('student', 'Student'),
    items:
      q.length >= 2 && debounced === q
        ? (students.data?.items ?? []).map((s) => {
            const name = displayName(s.nameBn, s.nameEn, locale) || s.studentCode;
            const where = s.enrolment
              ? [classLevelName(s.enrolment, locale), s.enrolment.section?.name]
                  .filter(Boolean)
                  .join(' · ')
              : '';
            return {
              id: `student:${s.id}`,
              label: name,
              hint: [where, s.studentCode].filter(Boolean).join(' · '),
              icon: UserRoundIcon,
              run: () => go(`/students/${s.id}`, { id: s.id, label: name }),
            };
          })
        : [],
  });

  // The keyboard layer. `g` goes only where the sidebar would.
  const attendance = canSee(navItem('attendance'), context);
  const goTargets = useMemo(() => {
    const targets: Record<string, string> = { KeyD: '/dashboard' };
    if (seesStudents) targets['KeyS'] = '/students';
    if (attendance) {
      targets['KeyA'] = '/attendance';
      targets['KeyT'] = '/attendance/today';
      targets['KeyR'] = '/attendance/register';
    }
    return targets;
  }, [seesStudents, attendance]);
  useEffect(() => {
    const goTo = createGoSequence<string>(goTargets);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (isPaletteShortcut(e)) {
        // Toggles the palette; never opens it over another dialog.
        if (open || !overlayOpen()) {
          e.preventDefault();
          setOpen(!open);
        }
        return;
      }
      if (open || isTypingTarget(e.target) || overlayOpen()) return;
      if (isHelpShortcut(e)) {
        e.preventDefault();
        setHelp(true);
      } else if (isSearchShortcut(e)) {
        const field = document.querySelector<HTMLElement>('[data-page-search]');
        if (field) {
          e.preventDefault();
          field.focus();
        }
      } else if (isNewShortcut(e)) {
        document.querySelector<HTMLElement>('[data-page-new]')?.click();
      } else {
        const href = goTo(e, performance.now());
        if (href) router.push(href);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen, router, goTargets]);

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        groups={groups}
        query={query}
        onQueryChange={setQuery}
        loading={seesStudents && (students.isFetching || (q.length >= 2 && debounced !== q))}
      />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </>
  );
}

/** The top bar's way into the palette: looks like a search field, is a button. */
export function PaletteButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('palette');
  const mac = isApple();
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="palette-button"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring bg-muted/60 hover:bg-muted flex h-(--control-h) min-w-(--control-h) shrink-0 items-center justify-center gap-2 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2 lg:w-72 lg:justify-start"
    >
      <SearchIcon aria-hidden className="size-4 shrink-0" />
      <span className="hidden lg:inline">{t('button')}</span>
      <span className="sr-only lg:hidden">{t('title')}</span>
      <span aria-hidden className="ms-auto hidden gap-1 lg:flex">
        <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useTranslations('palette');
  const label = useLabel();
  const rows: [string[], string][] = [
    [[isApple() ? '⌘' : 'Ctrl', 'K'], t('keyPalette')],
    [['/'], t('keySearch')],
    [['n'], t('keyNew')],
    [['g', 'd'], t('keyDashboard')],
    [['g', 's'], t('keyStudents', { student: label('student', 'Student') })],
    [['g', 'a'], t('keyAttendance')],
    [['g', 't'], t('keyToday')],
    [['g', 'r'], t('keyRegister')],
    [['?'], t('keyHelp')],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t('shortcuts')}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y text-sm">
          {rows.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-2">
              <dt>{label}</dt>
              <dd className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
