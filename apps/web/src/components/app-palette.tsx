'use client';

import { type MeContext, type Role, type StudentsPage } from '@jantrik/shared';
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
  MoonIcon,
  Rows3Icon,
  SunIcon,
  UserPlusIcon,
  UserRoundIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CommandPalette,
  matches,
  normalizeQuery,
  type PaletteCommand,
  type PaletteGroup,
} from '@/components/command-palette';
import { isApple, Kbd } from '@/components/kbd';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useDensity } from '@/lib/density';
import { useTheme } from '@/lib/theme';
import { useLabel, useSetLocale } from '@/lib/hooks';
import { classLevelName, displayName } from '@/lib/names';
import { canSee, NAV_ITEMS, navItem } from '@/lib/navigation';
import { clearRecents, pushRecent, readRecents } from '@/lib/recents';
import { useNavLabel } from '@/lib/nav-label';

/** Roles the API lets admit, import and add staff (the same as their pages' buttons). */
const OFFICE: Role[] = ['OWNER', 'ADMIN'];

/**
 * The palette itself and the shortcuts list: loaded the first time either opens (app-commands.tsx
 * keeps the keyboard layer in the first bundle), so pages don't ship the palette's code.
 */
export function PaletteDialogs({
  context,
  open,
  onOpenChange,
  help,
  onHelpChange,
}: {
  context: MeContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  help: boolean;
  onHelpChange: (open: boolean) => void;
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
  const { mode, setScheme } = useTheme();
  const setLocale = useSetLocale();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const userId = session?.user.id ?? 'none';
  const tenantId = context.tenant.id;
  const roles = context.roles;
  const office = roles.some((r) => OFFICE.includes(r));
  const seesStudents = canSee(navItem('students'), context);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(normalizeQuery(query)), 200);
    return () => clearTimeout(id);
  }, [query]);
  // A closed palette starts empty next time (however it closed: Esc, a pick, the shortcut).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setQuery('');
  }

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
        id: 'act:scheme',
        label: mode === 'dark' ? tShell('schemeToLight') : tShell('schemeToDark'),
        keywords: t('schemeKeywords'),
        icon: mode === 'dark' ? SunIcon : MoonIcon,
        run: () => setScheme(mode === 'dark' ? 'LIGHT' : 'DARK'),
      },
      {
        id: 'act:shortcuts',
        label: t('shortcuts'),
        hint: '?',
        icon: KeyboardIcon,
        run: () => onHelpChange(true),
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
    mode,
    setScheme,
    t,
    tShell,
    tCommon,
    toggle,
    setLocale,
    go,
    client,
    onHelpChange,
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

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={onOpenChange}
        groups={groups}
        query={query}
        onQueryChange={setQuery}
        loading={seesStudents && (students.isFetching || (q.length >= 2 && debounced !== q))}
      />
      <ShortcutsDialog open={help} onOpenChange={onHelpChange} />
    </>
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
    [['g', 'e'], t('keyExams')],
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
