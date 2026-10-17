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
import { SearchIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useDebounced, useErrorMessage, useLabel } from '@/lib/hooks';

const ALL = 'all';

export default function StudentsPage() {
  return (
    <PageGate page="students">
      <Students />
    </PageGate>
  );
}

/** Name in the UI language, falling back to the other one. */
const displayName = (bn: string | null, en: string | null, locale: Locale) =>
  (locale === 'bn' ? (bn ?? en) : (en ?? bn)) ?? '';

function Students() {
  const t = useTranslations('students');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const searchId = useId();

  const [search, setSearch] = useState('');
  const [classLevelId, setClassLevelId] = useState<string>(ALL);
  const [sectionId, setSectionId] = useState<string>(ALL);
  const q = useDebounced(search.trim(), 300);

  const studentLabel = label('student', 'Student');
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

  const classItems = [
    { value: ALL, label: t('allClassLevels', { classLevel: classLabel }) },
    ...(filters.data?.classLevels.map((c) => ({
      value: c.id,
      label: displayName(c.nameBn, c.nameEn, locale),
    })) ?? []),
  ];
  const sectionItems = [
    { value: ALL, label: t('allSections', { section: sectionLabel }) },
    ...sections.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title', { student: studentLabel })}</h1>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]" role="search">
        <div className="relative">
          <Label htmlFor={searchId} className="sr-only">
            {t('search')}
          </Label>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            id={searchId}
            type="search"
            placeholder={t('search')}
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          items={classItems}
          value={classLevelId}
          onValueChange={(v) => {
            setClassLevelId(v ?? ALL);
            setSectionId(ALL);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-44"
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
            className="w-full sm:w-44"
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

      {students.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={tCommon('loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
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
        <Card>
          <CardContent
            className="flex flex-col items-center gap-1 py-10 text-center"
            data-testid="students-empty"
          >
            <p className="font-medium">{t('empty', { student: studentLabel })}</p>
            <p className="text-muted-foreground text-sm">{t('emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t('showing', { count: formatCount(items.length, locale) })}
          </p>
          <StudentTable
            items={items}
            locale={locale}
            classLabel={classLabel}
            sectionLabel={sectionLabel}
          />
          <StudentCards items={items} locale={locale} />
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
        </>
      )}
    </>
  );
}

function classText(s: StudentListItem, locale: Locale, notEnrolled: string): string {
  if (!s.enrolment) return notEnrolled;
  const cls = displayName(s.enrolment.classLevel.nameBn, s.enrolment.classLevel.nameEn, locale);
  return s.enrolment.section ? `${cls} · ${s.enrolment.section.name}` : cls;
}

/** Identifiers (code, roll, phone) always use ASCII digits — see format.ts. */
function Phone({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone}`} className="tabular-nums underline-offset-2 hover:underline" dir="ltr">
      {formatBdPhone(phone)}
    </a>
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
  return (
    <div className="hidden rounded-md border md:block">
      <Table data-testid="students-table">
        <TableHeader>
          <TableRow>
            <TableHead>{t('code')}</TableHead>
            <TableHead>{t('name')}</TableHead>
            <TableHead>{`${classLabel} / ${sectionLabel}`}</TableHead>
            <TableHead>{t('roll')}</TableHead>
            <TableHead>{t('guardian')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-mono text-xs">{formatIdentifier(s.studentCode)}</TableCell>
              <TableCell className="font-medium">
                {displayName(s.nameBn, s.nameEn, locale)}
              </TableCell>
              <TableCell>{classText(s, locale, t('notEnrolled'))}</TableCell>
              <TableCell className="tabular-nums">
                {s.enrolment?.roll != null ? formatIdentifier(s.enrolment.roll) : '—'}
              </TableCell>
              <TableCell>
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StudentCards({ items, locale }: { items: StudentListItem[]; locale: Locale }) {
  const t = useTranslations('students');
  return (
    <ul className="flex flex-col gap-2 md:hidden" data-testid="students-cards">
      {items.map((s) => (
        <li key={s.id}>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{displayName(s.nameBn, s.nameEn, locale)}</span>
                <span className="text-muted-foreground font-mono text-xs">
                  {formatIdentifier(s.studentCode)}
                </span>
              </div>
              <span className="text-muted-foreground text-sm">
                {classText(s, locale, t('notEnrolled'))}
                {s.enrolment?.roll != null &&
                  ` · ${t('roll')} ${formatIdentifier(s.enrolment.roll)}`}
              </span>
              {s.primaryGuardian && (
                <span className="text-sm">
                  {displayName(s.primaryGuardian.nameBn, s.primaryGuardian.nameEn, locale)} ·{' '}
                  <Phone phone={s.primaryGuardian.phone} />
                </span>
              )}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
