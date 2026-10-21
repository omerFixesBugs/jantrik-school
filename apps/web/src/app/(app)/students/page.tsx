'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  formatBdPhone,
  formatCount,
  formatIdentifier,
  STUDENT_SORTS,
  STUDENT_STATUSES,
  STUDENTS_PAGE_SIZE,
  type StudentFilters,
  type StudentListItem,
  type StudentSort,
  type StudentStatus,
  type StudentsPage,
} from '@jantrik/shared';
import {
  ArrowRightLeftIcon,
  CalendarCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleXIcon,
  FileSpreadsheetIcon,
  GraduationCapIcon,
  PhoneIcon,
  SearchIcon,
  SearchXIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useEffect, useId, useRef, useState } from 'react';
import { ColumnChooser, DataTable, type DataColumn, type SortState } from '@/components/data-table';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { SavedViews } from '@/components/saved-views';
import { SidePeek } from '@/components/side-peek';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { classLevelName, displayName } from '@/lib/names';
import { canSee, navItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { useHiddenColumns, useSavedViews, useUrlParams } from '@/lib/view-state';

const ALL = 'all';
/** The URL keys a saved view is made of (paging is not part of a view). */
const VIEW_KEYS = ['q', 'class', 'section', 'status', 'sort', 'dir'] as const;
/** The office's order: class, section, roll (docs/design.md → Principles 6). */
const DEFAULT_SORT: StudentSort = 'class';

export default function StudentsPage() {
  return (
    <PageGate page="students">
      {/* The list's state lives in the URL (useSearchParams). */}
      <Suspense>
        <Students />
      </Suspense>
    </PageGate>
  );
}

const oneOf = <T extends string>(all: readonly T[], v: string | null): T | null =>
  v !== null && (all as readonly string[]).includes(v) ? (v as T) : null;

function Students() {
  const t = useTranslations('students');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('studentStatus');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const scope = `${session?.user.id ?? ''}.${tenantId ?? ''}`;
  const searchId = useId();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const wide = useMediaQuery('(min-width: 1280px)');

  // ── The view, from the URL (Back returns to it; a link shares it).
  const { params, set, replace } = useUrlParams();
  const q = params.get('q') ?? '';
  const classLevelId = params.get('class');
  const sectionId = classLevelId ? params.get('section') : null;
  const status = oneOf(STUDENT_STATUSES, params.get('status'));
  const sort = oneOf(STUDENT_SORTS, params.get('sort')) ?? DEFAULT_SORT;
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  const filtered = Boolean(q || classLevelId || status);

  const [peekId, setPeekId] = useState<string | null>(null);
  /** A new view (filters, sort or page): the student in the peek may not be on it. */
  const change = (patch: Record<string, string | null>) => {
    setPeekId(null);
    set(patch);
  };

  // The search box types ahead of the URL: it is written after a pause, or at once when the
  // person moves on. When the URL changes by itself (a link, the sidebar, a saved view), the box
  // follows it.
  const [search, setSearch] = useState(q);
  const [pending, setPending] = useState(false);
  const [shownQ, setShownQ] = useState(q);
  if (q !== shownQ) {
    setShownQ(q);
    if (!pending && q !== search.trim()) setSearch(q);
  }
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const writeSearch = (value: string) => {
    clearTimeout(typing.current);
    setPending(false);
    change({ q: value.trim() || null, page: null });
  };
  const onSearch = (value: string) => {
    setSearch(value);
    setPending(true);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => writeSearch(value), 300);
  };
  // Moving on (the box loses focus, a name, a card, a row) with a search still waiting: write it
  // first, so Back returns to what was on screen, and never while a navigation is under way.
  const flushSearch = () => {
    if (pending) writeSearch(search);
  };
  const showView = (query: string) => {
    clearTimeout(typing.current);
    setPending(false);
    setPeekId(null);
    setSearch(new URLSearchParams(query).get('q') ?? '');
    replace(query);
  };
  // Clearing the filters keeps the order the person chose.
  const clearFilters = () => {
    const keep = new URLSearchParams();
    for (const k of ['sort', 'dir']) {
      const v = params.get(k);
      if (v) keep.set(k, v);
    }
    showView(keep.toString());
  };

  const resultCount = useRef<HTMLParagraphElement>(null);
  const [hidden, setHidden] = useHiddenColumns(scope, 'students');
  const views = useSavedViews(scope, 'students');

  const studentLabel = label('student', 'Student', { inText: true });
  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');

  const filters = useQuery({
    queryKey: ['student-filters', tenantId],
    queryFn: () => client.api<StudentFilters>('/students/filters'),
  });
  const sections = filters.data?.classLevels.find((c) => c.id === classLevelId)?.sections ?? [];

  const apiQuery = new URLSearchParams({
    sort,
    dir,
    locale,
    page: String(page),
    pageSize: String(STUDENTS_PAGE_SIZE),
  });
  if (q) apiQuery.set('q', q);
  if (classLevelId) apiQuery.set('classLevelId', classLevelId);
  if (sectionId) apiQuery.set('sectionId', sectionId);
  if (status) apiQuery.set('status', status);
  const students = useQuery({
    queryKey: ['students', tenantId, apiQuery.toString()],
    queryFn: () => client.api<StudentsPage>(`/students?${apiQuery}`),
    // Paging and sorting keep the rows on screen until the next ones arrive.
    placeholderData: keepPreviousData,
  });
  const items = students.data?.items ?? [];
  const total = students.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / STUDENTS_PAGE_SIZE));
  const peek = items.find((s) => s.id === peekId) ?? null;
  // Past the last page (an old link, or Back after the list got shorter): the last one instead.
  const beyond = !students.isPlaceholderData && total > 0 && items.length === 0 && page > 1;
  useEffect(() => {
    if (beyond) set({ page: pages > 1 ? String(pages) : null });
  }, [beyond, pages, set]);

  const classItems = [
    {
      value: ALL,
      label: t('allClassLevels', { classLevel: label('class_level', 'Class', { inText: true }) }),
    },
    ...(filters.data?.classLevels.map((c) => ({
      value: c.id,
      label: displayName(c.nameBn, c.nameEn, locale),
    })) ?? []),
  ];
  const sectionItems = [
    {
      value: ALL,
      label: t('allSections', { section: label('section', 'Section', { inText: true }) }),
    },
    ...sections.map((s) => ({ value: s.id, label: s.name })),
  ];
  const statusItems = [
    { value: ALL, label: t('allStatuses') },
    ...STUDENT_STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
  ];

  const f = (n: number) => formatCount(n, locale);
  const from = (page - 1) * STUDENTS_PAGE_SIZE + 1;
  const resultText =
    total > items.length
      ? t('range', { from: f(from), to: f(from + items.length - 1), total: f(total) })
      : filtered
        ? t('found', { count: f(total) })
        : t('total', { count: f(total) });

  const columns: DataColumn<StudentListItem>[] = [
    {
      id: 'name',
      header: t('name'),
      sortKey: 'name',
      cell: (s) => {
        const name = displayName(s.nameBn, s.nameEn, locale);
        return (
          <span className="flex items-center gap-2.5">
            <PersonAvatar name={name} photoUrl={s.photoUrl} size="sm" />
            <Link
              href={`/students/${s.id}`}
              className="text-foreground min-w-0 truncate font-medium underline-offset-2 hover:underline"
            >
              {name}
            </Link>
          </span>
        );
      },
    },
    {
      id: 'code',
      header: t('code'),
      sortKey: 'code',
      hideable: true,
      cell: (s) => (
        <span className="tabular-nums" dir="ltr">
          {formatIdentifier(s.studentCode)}
        </span>
      ),
    },
    {
      id: 'class',
      header: `${classLabel} · ${sectionLabel}`,
      sortKey: 'class',
      hideable: true,
      cell: (s) =>
        s.enrolment ? (
          <span>
            {classLevelName(s.enrolment, locale)}
            {s.enrolment.section && (
              <span className="text-muted-foreground"> · {s.enrolment.section.name}</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('notEnrolled')}</span>
        ),
    },
    {
      id: 'roll',
      header: t('roll'),
      sortKey: 'roll',
      align: 'end',
      hideable: true,
      cell: (s) => (s.enrolment?.roll != null ? formatIdentifier(s.enrolment.roll) : '—'),
    },
    {
      id: 'guardian',
      header: t('guardian'),
      hideable: true,
      cell: (s) =>
        s.primaryGuardian ? (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{displayName(s.primaryGuardian.nameBn, s.primaryGuardian.nameEn, locale)}</span>
            <span className="text-muted-foreground tabular-nums" dir="ltr">
              {formatBdPhone(s.primaryGuardian.phone)}
            </span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'status',
      header: t('status'),
      hideable: true,
      cell: (s) => <StatusMark status={s.status} />,
    },
  ];

  const onSort = (next: SortState) => {
    const isDefault = next.key === DEFAULT_SORT && next.dir === 'asc';
    change({
      sort: isDefault ? null : next.key,
      dir: isDefault || next.dir === 'asc' ? null : next.dir,
      page: null,
    });
  };
  const toPage = (n: number) => change({ page: n <= 1 ? null : String(n) });

  return (
    // With the side peek open, the whole list makes room for it (toolbar and filters too).
    <div
      className={cn(
        'flex flex-col gap-(--section-gap) transition-[padding]',
        peek && wide && 'pe-[min(26rem,40vw)]',
      )}
      onClickCapture={flushSearch}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SavedViews
          views={views.views}
          query={params.toString()}
          keys={VIEW_KEYS}
          onSelect={showView}
          onSave={views.save}
          onRemove={views.remove}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden md:inline-flex">
            <ColumnChooser columns={columns} hidden={hidden} onChange={setHidden} />
          </span>
          {isAdmin && (
            <span className="flex flex-wrap gap-2" data-testid="students-actions">
              <ButtonLink
                href="/students/import"
                variant="outline"
                size="sm"
                data-testid="import-students"
              >
                <FileSpreadsheetIcon aria-hidden />
                {t('import')}
              </ButtonLink>
              <ButtonLink href="/students/new" size="sm" data-testid="admit-student" data-page-new>
                <UserPlusIcon aria-hidden />
                {t('admit', { student: studentLabel })}
              </ButtonLink>
            </span>
          )}
        </div>
      </div>

      <div
        className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center"
        role="search"
        aria-label={t('filters')}
      >
        <div className="relative min-w-60 flex-1">
          <Label htmlFor={searchId} className="sr-only">
            {t('search')}
          </Label>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
          />
          <Input
            data-page-search
            id={searchId}
            type="search"
            placeholder={t('search')}
            className="ps-9"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onBlur={flushSearch}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 md:flex">
          <Select
            items={classItems}
            value={classLevelId ?? ALL}
            onValueChange={(v) =>
              change({ class: v && v !== ALL ? v : null, section: null, page: null })
            }
          >
            <SelectTrigger
              className="w-full md:w-44"
              aria-label={classLabel}
              data-testid="class-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {classItems.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={sectionItems}
            value={sectionId ?? ALL}
            onValueChange={(v) => change({ section: v && v !== ALL ? v : null, page: null })}
            disabled={!classLevelId}
          >
            <SelectTrigger
              className="w-full md:w-40"
              aria-label={sectionLabel}
              data-testid="section-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sectionItems.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={statusItems}
            value={status ?? ALL}
            onValueChange={(v) => change({ status: v && v !== ALL ? v : null, page: null })}
          >
            <SelectTrigger
              className="col-span-2 w-full md:w-40"
              aria-label={t('status')}
              data-testid="status-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusItems.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" className="self-start md:self-auto" onClick={clearFilters}>
            <XIcon aria-hidden />
            {t('clearFilters')}
          </Button>
        )}
      </div>

      {students.isPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true" aria-label={tCommon('loading')}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-(--row-h) w-full rounded-md" />
          ))}
        </div>
      ) : students.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {describe(students.error)}
            <Button size="sm" variant="outline" onClick={() => void students.refetch()}>
              {tCommon('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <div
          className="bg-card flex flex-col items-center gap-3 rounded-lg border px-6 py-14 text-center"
          data-testid="students-empty"
        >
          <span className="bg-primary-soft text-primary flex size-14 items-center justify-center rounded-lg">
            {filtered ? (
              <SearchXIcon aria-hidden className="size-7" />
            ) : (
              <UsersIcon aria-hidden className="size-7" />
            )}
          </span>
          <p className="text-lg font-medium">
            {filtered
              ? t('empty', { student: studentLabel })
              : t('emptyAll', { student: studentLabel })}
          </p>
          <p className="text-muted-foreground max-w-md text-sm">
            {filtered ? t('emptyHint') : t('emptyAllHint', { student: studentLabel })}
          </p>
          {filtered && (
            <Button variant="outline" className="mt-1" onClick={clearFilters}>
              <XIcon aria-hidden />
              {t('clearFilters')}
            </Button>
          )}
        </div>
      ) : (
        <div className={cn('flex flex-col gap-2', students.isPlaceholderData && 'opacity-70')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              ref={resultCount}
              tabIndex={-1}
              className="text-muted-foreground text-sm outline-none"
              aria-live="polite"
              data-testid="result-count"
            >
              {resultText}
            </p>
            <Pager page={page} pages={pages} onPage={toPage} />
          </div>
          <DataTable
            className="hidden md:block"
            testId="students-table"
            caption={t('title', { student: label('student', 'Student') })}
            columns={columns}
            rows={items}
            rowKey={(s) => s.id}
            rowLabel={(s) => displayName(s.nameBn, s.nameEn, locale)}
            hidden={hidden}
            sort={{ key: sort, dir }}
            onSortChange={onSort}
            // Beside a side peek the table may no longer fit: it scrolls instead of clipping.
            scrollX={Boolean(peek && wide)}
            activeKey={wide ? (peek?.id ?? null) : null}
            onRowOpen={(s) => {
              if (wide) return setPeekId(s.id);
              flushSearch();
              router.push(`/students/${s.id}`);
            }}
            actions={(s) =>
              s.primaryGuardian && (
                <a
                  href={`tel:${s.primaryGuardian.phone}`}
                  className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                  aria-label={t('call', {
                    name: displayName(s.primaryGuardian.nameBn, s.primaryGuardian.nameEn, locale),
                  })}
                >
                  <PhoneIcon aria-hidden />
                </a>
              )
            }
          />
          <StudentCards items={items} locale={locale} sectionLabel={sectionLabel} />
          {pages > 1 && (
            <Pager
              page={page}
              pages={pages}
              // The second pager is not a second landmark; it takes the reader to the new top.
              landmark={false}
              onPage={(n) => {
                toPage(n);
                window.scrollTo({ top: 0 });
                resultCount.current?.focus({ preventScroll: true });
              }}
              className="self-end"
            />
          )}
        </div>
      )}

      {peek && wide && (
        <StudentPeek
          student={peek}
          onClose={() => setPeekId(null)}
          showAttendance={context ? canSee(navItem('attendance'), context) : false}
        />
      )}
    </div>
  );
}

function Pager({
  page,
  pages,
  onPage,
  landmark = true,
  className,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  landmark?: boolean;
  className?: string;
}) {
  const t = useTranslations('students');
  const locale = useLocale() as Locale;
  if (pages <= 1) return null;
  const Box = landmark ? 'nav' : 'div';
  return (
    <Box
      aria-label={t('pages')}
      role={landmark ? undefined : 'group'}
      className={cn('flex items-center gap-1', className)}
    >
      <Button
        variant="outline"
        size="icon-sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        aria-label={t('previousPage')}
      >
        <ChevronLeftIcon aria-hidden className="rtl:rotate-180" />
      </Button>
      <span className="text-muted-foreground min-w-20 text-center text-sm tabular-nums">
        {t('pageOf', { page: formatCount(page, locale), pages: formatCount(pages, locale) })}
      </span>
      <Button
        variant="outline"
        size="icon-sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        aria-label={t('nextPage')}
      >
        <ChevronRightIcon aria-hidden className="rtl:rotate-180" />
      </Button>
    </Box>
  );
}

/**
 * Status by shape and word (docs/design.md → Colour): active is the normal case and stays quiet;
 * every other status keeps its row, marked.
 */
const STATUS_MARK: Record<
  Exclude<StudentStatus, 'ACTIVE'>,
  { icon: LucideIcon; className: string }
> = {
  INACTIVE: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  GRADUATED: { icon: GraduationCapIcon, className: 'text-info' },
  TRANSFERRED: { icon: ArrowRightLeftIcon, className: 'text-muted-foreground' },
  DROPPED_OUT: { icon: CircleXIcon, className: 'text-destructive' },
};

function StatusMark({ status }: { status: StudentStatus }) {
  const t = useTranslations('studentStatus');
  if (status === 'ACTIVE') return <span className="text-muted-foreground">{t(status)}</span>;
  const { icon: Icon, className } = STATUS_MARK[status];
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {t(status)}
    </span>
  );
}

function StudentPeek({
  student: s,
  onClose,
  showAttendance,
}: {
  student: StudentListItem;
  onClose: () => void;
  showAttendance: boolean;
}) {
  const t = useTranslations('students');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = displayName(s.nameBn, s.nameEn, locale);
  const g = s.primaryGuardian;
  const guardianName = g ? displayName(g.nameBn, g.nameEn, locale) : '';
  const facts: { term: string; value: string; id?: boolean }[] = [
    { term: t('code'), value: formatIdentifier(s.studentCode), id: true },
    {
      term: label('class_level', 'Class'),
      value: s.enrolment ? classLevelName(s.enrolment, locale) : t('notEnrolled'),
    },
    { term: label('section', 'Section'), value: s.enrolment?.section?.name ?? '—' },
    {
      term: t('roll'),
      value: s.enrolment?.roll != null ? formatIdentifier(s.enrolment.roll) : '—',
      id: true,
    },
  ];
  return (
    <SidePeek title={name} href={`/students/${s.id}`} onClose={onClose} testId="student-peek">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <PersonAvatar name={name} photoUrl={s.photoUrl} size="xl" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-lg font-semibold">{name}</span>
            <StatusMark status={s.status} />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {facts.map((fact) => (
            <div key={fact.term} className="contents">
              <dt className="text-muted-foreground">{fact.term}</dt>
              <dd
                className={cn('min-w-0 font-medium', fact.id && 'tabular-nums')}
                dir={fact.id ? 'ltr' : undefined}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
        {g && (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-muted-foreground text-xs">{t('guardian')}</span>
              <span className="truncate font-medium">{guardianName}</span>
              <span className="text-sm tabular-nums" dir="ltr">
                {formatBdPhone(g.phone)}
              </span>
            </span>
            <a
              href={`tel:${g.phone}`}
              className={buttonVariants({ variant: 'outline', size: 'icon' })}
              aria-label={t('call', { name: guardianName })}
            >
              <PhoneIcon aria-hidden />
            </a>
          </div>
        )}
        {showAttendance && (
          <ButtonLink
            href={`/attendance/students/${s.id}`}
            variant="outline"
            className="self-start"
          >
            <CalendarCheckIcon aria-hidden />
            {t('attendanceReport')}
          </ButtonLink>
        )}
      </div>
    </SidePeek>
  );
}

function StudentCards({
  items,
  locale,
  sectionLabel,
}: {
  items: StudentListItem[];
  locale: Locale;
  sectionLabel: string;
}) {
  const t = useTranslations('students');
  return (
    <ul className="flex flex-col gap-2 md:hidden" data-testid="students-cards">
      {items.map((s) => {
        const name = displayName(s.nameBn, s.nameEn, locale);
        const g = s.primaryGuardian;
        const guardianName = g ? displayName(g.nameBn, g.nameEn, locale) : '';
        return (
          <li key={s.id} className="bg-card overflow-hidden rounded-lg border">
            <div className="flex items-start gap-3 p-3">
              <PersonAvatar name={name} photoUrl={s.photoUrl} size="lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    {/* The card's way into the record: a full 44 px target on a phone. */}
                    <Link
                      href={`/students/${s.id}`}
                      className="block max-w-full truncate py-2 text-base font-semibold underline-offset-2 hover:underline"
                    >
                      {name}
                    </Link>
                    <span className="text-muted-foreground text-sm tabular-nums" dir="ltr">
                      {formatIdentifier(s.studentCode)}
                    </span>
                  </span>
                  {s.status !== 'ACTIVE' && <StatusMark status={s.status} />}
                </div>
                <p className="text-sm">
                  {s.enrolment ? (
                    <>
                      {classLevelName(s.enrolment, locale)}
                      {s.enrolment.section && (
                        <>
                          {' · '}
                          {sectionLabel} {s.enrolment.section.name}
                        </>
                      )}
                      {s.enrolment.roll != null && (
                        <>
                          {' · '}
                          {t('roll')}{' '}
                          <span className="tabular-nums">{formatIdentifier(s.enrolment.roll)}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t('notEnrolled')}</span>
                  )}
                </p>
              </div>
            </div>
            {g && (
              <div className="bg-canvas flex items-center gap-3 border-t px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <span className="text-muted-foreground text-xs">{t('guardian')}</span>
                  <span className="truncate text-sm font-medium">{guardianName}</span>
                  <span className="text-sm tabular-nums" dir="ltr">
                    {formatBdPhone(g.phone)}
                  </span>
                </span>
                <a
                  href={`tel:${g.phone}`}
                  className={buttonVariants({ variant: 'outline', size: 'icon-lg' })}
                  aria-label={t('call', { name: guardianName })}
                >
                  <PhoneIcon aria-hidden className="size-5" />
                </a>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
