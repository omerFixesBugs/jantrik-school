'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  formatBdPhone,
  formatCount,
  formatIdentifier,
  type StudentFilters,
  type StudentListItem,
  type StudentsPage,
} from '@jantrik/shared';
import {
  EllipsisVerticalIcon,
  EyeIcon,
  FileSpreadsheetIcon,
  PhoneIcon,
  SearchIcon,
  SearchXIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useDebounced, useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { classLevelName, displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

const ALL = 'all';

export default function StudentsPage() {
  return (
    <PageGate page="students">
      <Students />
    </PageGate>
  );
}

function Students() {
  const t = useTranslations('students');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const searchId = useId();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;

  const [search, setSearch] = useState('');
  const [classLevelId, setClassLevelId] = useState<string>(ALL);
  const [sectionId, setSectionId] = useState<string>(ALL);
  const q = useDebounced(search.trim(), 300);
  const filtered = Boolean(search.trim()) || classLevelId !== ALL || sectionId !== ALL;
  const clearFilters = () => {
    setSearch('');
    setClassLevelId(ALL);
    setSectionId(ALL);
  };

  const studentLabel = label('student', 'Student', { inText: true });
  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');

  const filters = useQuery({
    queryKey: ['student-filters', tenantId],
    queryFn: () => client.api<StudentFilters>('/students/filters'),
  });
  const sections = filters.data?.classLevels.find((c) => c.id === classLevelId)?.sections ?? [];

  const students = useInfiniteQuery({
    queryKey: ['students', tenantId, q, classLevelId, sectionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (q) params.set('q', q);
      if (classLevelId !== ALL) params.set('classLevelId', classLevelId);
      if (sectionId !== ALL) params.set('sectionId', sectionId);
      if (pageParam) params.set('cursor', pageParam);
      return client.api<StudentsPage>(`/students?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = students.data?.pages.flatMap((p) => p.items) ?? [];
  const total = students.data?.pages[0]?.total ?? items.length;

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

  const count = formatCount(total, locale);
  const resultText =
    items.length < total
      ? t('showingOf', { count: formatCount(items.length, locale), total: count })
      : filtered
        ? t('found', { count })
        : t('total', { count });

  return (
    <>
      {isAdmin && (
        <div className="flex flex-wrap gap-2" data-testid="students-actions">
          <ButtonLink href="/students/new" data-testid="admit-student" data-page-new>
            <UserPlusIcon aria-hidden />
            {t('admit', { student: studentLabel })}
          </ButtonLink>
          <ButtonLink href="/students/import" variant="outline" data-testid="import-students">
            <FileSpreadsheetIcon aria-hidden />
            {t('import')}
          </ButtonLink>
        </div>
      )}
      <div
        className="bg-card flex flex-col gap-3 rounded-xl border p-3 shadow-xs sm:p-4 md:flex-row md:items-center"
        role="search"
        aria-label={t('filters')}
      >
        <div className="relative flex-1">
          <Label htmlFor={searchId} className="sr-only">
            {t('search')}
          </Label>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2"
          />
          <Input
            data-page-search
            id={searchId}
            type="search"
            placeholder={t('search')}
            className="pl-10"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 md:flex">
          <Select
            items={classItems}
            value={classLevelId}
            onValueChange={(v) => {
              setClassLevelId(v ?? ALL);
              setSectionId(ALL);
            }}
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
            value={sectionId}
            onValueChange={(v) => setSectionId(v ?? ALL)}
            disabled={classLevelId === ALL}
          >
            <SelectTrigger
              className="w-full md:w-44"
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
        </div>
        {filtered && (
          <Button variant="ghost" className="self-start md:self-auto" onClick={clearFilters}>
            <XIcon aria-hidden />
            {t('clearFilters')}
          </Button>
        )}
      </div>

      {students.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={tCommon('loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
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
          className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center"
          data-testid="students-empty"
        >
          <span className="bg-primary-soft text-primary flex size-14 items-center justify-center rounded-2xl">
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
        <div className="flex flex-col gap-3">
          <p
            className="text-muted-foreground text-sm"
            aria-live="polite"
            data-testid="result-count"
          >
            {resultText}
          </p>
          <StudentTable
            items={items}
            locale={locale}
            classLabel={classLabel}
            sectionLabel={sectionLabel}
          />
          <StudentCards items={items} locale={locale} sectionLabel={sectionLabel} />
          {students.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              disabled={students.isFetchingNextPage}
              onClick={() => void students.fetchNextPage()}
            >
              {students.isFetchingNextPage ? tCommon('loading') : t('loadMore')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

const STATUS_VARIANT = {
  ACTIVE: 'success',
  INACTIVE: 'secondary',
  GRADUATED: 'soft',
  TRANSFERRED: 'secondary',
  DROPPED_OUT: 'destructive',
} as const;

function StatusBadge({ status }: { status: StudentListItem['status'] }) {
  const t = useTranslations('studentStatus');
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t(status)}
    </Badge>
  );
}

/** Identifiers (code, roll, phone) always use ASCII digits — see format.ts. */
function Phone({ phone }: { phone: string }) {
  return (
    <a
      href={`tel:${phone}`}
      className="text-primary w-fit tabular-nums underline-offset-2 hover:underline"
      dir="ltr"
    >
      {formatBdPhone(phone)}
    </a>
  );
}

function RowActions({ student, locale }: { student: StudentListItem; locale: Locale }) {
  const t = useTranslations('students');
  const name = displayName(student.nameBn, student.nameEn, locale);
  const g = student.primaryGuardian;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t('rowActions', { name })}>
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem render={<Link href={`/students/${student.id}`} />} nativeButton={false}>
          <EyeIcon aria-hidden />
          {t('view')}
        </DropdownMenuItem>
        {g && (
          <DropdownMenuItem render={<a href={`tel:${g.phone}`} />} nativeButton={false}>
            <PhoneIcon aria-hidden />
            {t('call', { name: displayName(g.nameBn, g.nameEn, locale) })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StudentTable({
  items,
  locale,
  classLabel,
  sectionLabel,
}: {
  items: StudentListItem[];
  locale: Locale;
  classLabel: string;
  sectionLabel: string;
}) {
  const t = useTranslations('students');
  const th =
    'bg-card text-muted-foreground sticky top-(--topbar-h) z-10 h-11 border-b px-4 text-left text-sm font-medium whitespace-nowrap first:pl-5';
  return (
    // overflow-clip (not hidden/auto) keeps the rounded corners without breaking sticky headers.
    <div className="bg-card hidden overflow-clip rounded-xl border shadow-xs md:block">
      <table className="w-full text-sm" data-testid="students-table">
        <thead>
          <tr>
            <th className={th}>{t('name')}</th>
            <th className={th}>{`${classLabel} / ${sectionLabel}`}</th>
            <th className={th}>{t('roll')}</th>
            <th className={th}>{t('guardian')}</th>
            <th className={th}>{t('status')}</th>
            <th className={cn(th, 'w-14 pr-3')}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const name = displayName(s.nameBn, s.nameEn, locale);
            return (
              <tr
                key={s.id}
                className="hover:bg-primary-soft/40 border-b transition-colors last:border-b-0"
              >
                <td className="py-3 pr-4 pl-5">
                  <span className="flex items-center gap-3">
                    <PersonAvatar name={name} photoUrl={s.photoUrl} />
                    <span className="flex min-w-0 flex-col">
                      <Link
                        href={`/students/${s.id}`}
                        className="text-foreground truncate text-[0.95rem] font-medium underline-offset-2 hover:underline"
                      >
                        {name}
                      </Link>
                      <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                        {formatIdentifier(s.studentCode)}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  {s.enrolment ? (
                    <span className="flex flex-col">
                      <span>{classLevelName(s.enrolment, locale)}</span>
                      {s.enrolment.section && (
                        <span className="text-muted-foreground text-xs">
                          {sectionLabel}: {s.enrolment.section.name}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('notEnrolled')}</span>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {s.enrolment?.roll != null ? formatIdentifier(s.enrolment.roll) : '—'}
                </td>
                <td className="px-4 py-3">
                  {s.primaryGuardian ? (
                    <span className="flex flex-col">
                      <span>
                        {displayName(s.primaryGuardian.nameBn, s.primaryGuardian.nameEn, locale)}
                      </span>
                      <Phone phone={s.primaryGuardian.phone} />
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={s.status} />
                </td>
                <td className="py-3 pr-3 pl-1 text-right">
                  <RowActions student={s} locale={locale} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
    <ul className="flex flex-col gap-3 md:hidden" data-testid="students-cards">
      {items.map((s) => {
        const name = displayName(s.nameBn, s.nameEn, locale);
        const g = s.primaryGuardian;
        const guardianName = g ? displayName(g.nameBn, g.nameEn, locale) : '';
        return (
          <li key={s.id} className="bg-card overflow-hidden rounded-xl border shadow-xs">
            <div className="flex items-start gap-3 p-4">
              <PersonAvatar name={name} photoUrl={s.photoUrl} size="lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    {/* The card's way into the record: a full 44 px target on a phone. */}
                    <Link
                      href={`/students/${s.id}`}
                      className="block max-w-full truncate py-2 text-base font-semibold underline-offset-2 hover:underline"
                    >
                      {name}
                    </Link>
                    <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                      {formatIdentifier(s.studentCode)}
                    </span>
                  </span>
                  <StatusBadge status={s.status} />
                </div>
                <div className="flex flex-wrap gap-1.5 text-sm">
                  {s.enrolment ? (
                    <>
                      <span className="bg-muted rounded-md px-2 py-0.5">
                        {classLevelName(s.enrolment, locale)}
                      </span>
                      {s.enrolment.section && (
                        <span className="bg-muted rounded-md px-2 py-0.5">
                          {sectionLabel}: {s.enrolment.section.name}
                        </span>
                      )}
                      {s.enrolment.roll != null && (
                        <span className="bg-muted rounded-md px-2 py-0.5 tabular-nums">
                          {t('roll')} {formatIdentifier(s.enrolment.roll)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t('notEnrolled')}</span>
                  )}
                </div>
              </div>
            </div>
            {g && (
              <div className="bg-canvas flex items-center gap-3 border-t px-4 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <span className="text-muted-foreground text-xs">{t('guardian')}</span>
                  <span className="truncate text-sm font-medium">{guardianName}</span>
                  <span className="text-sm tabular-nums" dir="ltr">
                    {formatBdPhone(g.phone)}
                  </span>
                </span>
                <a
                  href={`tel:${g.phone}`}
                  className={buttonVariants({ size: 'icon-lg', className: 'rounded-full' })}
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
