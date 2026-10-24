'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEVICE_USER_ID_RE,
  formatCount,
  toAsciiDigits,
  type DevicePeopleList,
  type DevicePersonKind,
  type DevicePersonRow,
  type DeviceSyncState,
  type SetDeviceIdResult,
} from '@jantrik/shared';
import {
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  HourglassIcon,
  PencilIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataColumn } from '@/components/data-table';
import { Pill, type PillTone } from '@/components/kit/pill';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { filterPeople, sectionChoices, type PeopleFilter } from '@/lib/devices/people';
import { useLabel } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';
import { Ascii, useDevicesError } from './kit';

/** Rows drawn at first; "show more" adds as many again. */
const PAGE = 100;

const SYNC: Record<DeviceSyncState, { tone: PillTone; icon: LucideIcon }> = {
  DONE: { tone: 'success', icon: CircleCheckIcon },
  PENDING: { tone: 'info', icon: HourglassIcon },
  FAILED: { tone: 'destructive', icon: CircleXIcon },
  NONE: { tone: 'neutral', icon: CircleDashedIcon },
};

/** After an ID changes: the list, the collisions, the stale list and the devices' commands. */
export function useInvalidatePeople() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      'attendance-device-people',
      'attendance-device-collisions',
      'attendance-device-stale',
      'attendance-devices',
    ])
      void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

/** A person's name in the UI language. */
export function rowName(p: DevicePersonRow, locale: Locale): string {
  return p.kind === 'STUDENT'
    ? displayName(p.nameBn, p.nameEn, locale) || '—'
    : (locale === 'bn' ? (p.nameBn ?? p.name) : p.name) || '—';
}

export function SyncPill({ state }: { state: DeviceSyncState }) {
  const t = useTranslations('devices.people.sync');
  const { tone, icon: Icon } = SYNC[state];
  return (
    <Pill tone={tone}>
      <Icon aria-hidden className="size-3.5" />
      {t(state)}
    </Pill>
  );
}

/**
 * Students or staff, with their device ID edited in place. The filters live here; the page may
 * set them (the collisions panel's "set an ID" shows that person and opens their ID).
 */
export function PeopleList({
  data,
  filter,
  onFilterChange,
  editingId,
  onEditingChange,
  showSync,
}: {
  data: DevicePeopleList;
  filter: PeopleFilter;
  onFilterChange: (next: PeopleFilter) => void;
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
  /** Off while there is no active device (every state would be "not sent"). */
  showSync: boolean;
}) {
  const t = useTranslations('devices.people');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const wide = useMediaQuery('(min-width: 1024px)');
  const [shown, setShown] = useState(PAGE);
  const f = (n: number) => formatCount(n, locale);
  const set = (patch: Partial<PeopleFilter>) => {
    setShown(PAGE);
    onFilterChange({ ...filter, ...patch });
  };

  const rows = filterPeople(data.people, filter);
  const visible = rows.slice(0, shown);
  const students = filter.kind === 'STUDENT';
  const unmapped = students ? data.counts.studentsUnmapped : data.counts.staffUnmapped;
  const sections = sectionChoices(data.people, locale);
  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');

  const place = (p: DevicePersonRow) =>
    p.kind === 'STUDENT'
      ? [displayName(p.classLevel.nameBn, p.classLevel.nameEn, locale), p.section?.name]
          .filter(Boolean)
          .join(', ')
      : p.roles.map((r) => tRoles(r)).join(', ');
  const cell = (p: DevicePersonRow, variant: 'table' | 'card') => (
    <DeviceIdCell
      person={p}
      variant={variant}
      editing={editingId === p.id}
      onEditingChange={(on) => onEditingChange(on ? p.id : null)}
    />
  );
  const sync = (p: DevicePersonRow) =>
    p.deviceUserId ? <SyncPill state={p.sync} /> : <span className="text-muted-foreground">—</span>;

  const columns: DataColumn<DevicePersonRow>[] = [
    {
      id: 'name',
      header: t('colName'),
      cell: (p) => <span className="font-medium">{rowName(p, locale)}</span>,
    },
    {
      id: 'place',
      header: students
        ? t('colClass', { classLevel: classLabel, section: sectionLabel })
        : t('colRole'),
      cell: (p) => <span className="text-muted-foreground">{place(p) || '—'}</span>,
    },
    ...(students
      ? [
          {
            id: 'code',
            header: t('colCode'),
            cell: (p: DevicePersonRow) =>
              p.kind === 'STUDENT' ? <Ascii value={p.studentCode} /> : null,
          },
        ]
      : []),
    { id: 'id', header: t('colId'), cell: (p) => cell(p, 'table'), className: 'w-[19rem]' },
    ...(showSync ? [{ id: 'sync', header: t('colSync'), cell: sync }] : []),
  ];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="people-list-title">
      <h3 id="people-list-title" className="sr-only">
        {t('listTitle')}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={t('kindLabel')}
          value={filter.kind}
          onChange={(kind: DevicePersonKind) => set({ kind, sectionId: '' })}
          options={[
            {
              value: 'STUDENT',
              label: t('kindCount', {
                kind: label('student', 'Student'),
                count: f(data.counts.students),
              }),
            },
            {
              value: 'STAFF',
              label: t('kindCount', { kind: t('staff'), count: f(data.counts.staff) }),
            },
          ]}
          testId="people-kind"
        />
        <button
          type="button"
          aria-pressed={filter.unmappedOnly}
          onClick={() => set({ unmappedOnly: !filter.unmappedOnly })}
          className={cn(
            'inline-flex min-h-(--control-h) items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
            'focus-visible:ring-ring outline-none focus-visible:ring-2',
            filter.unmappedOnly
              ? 'border-primary-ink bg-primary-soft text-accent-foreground'
              : 'bg-card hover:border-primary/40',
          )}
          data-testid="people-unmapped"
        >
          {t('unmappedOnly')}
          <Pill tone={unmapped > 0 ? 'warning' : 'neutral'} className="font-numeric">
            {f(unmapped)}
          </Pill>
        </button>
        {students && sections.length > 0 && (
          <select
            aria-label={sectionLabel}
            value={filter.sectionId}
            onChange={(e) => set({ sectionId: e.target.value })}
            className={cn(
              'border-input bg-card h-(--control-h) max-w-full min-w-0 rounded-md border ps-2.5 pe-2 text-(length:--input-fs) outline-none',
              'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
            )}
            data-testid="people-section"
          >
            <option value="">{t('allSections', { section: sectionLabel })}</option>
            {sections.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <div className="relative min-w-0 flex-1 basis-56">
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder={t('search')}
            aria-label={t('search')}
            className="ps-8"
            data-testid="people-search"
          />
        </div>
      </div>

      <p className="text-muted-foreground text-sm" aria-live="polite" data-testid="people-count">
        {t('showing', { count: f(rows.length), n: rows.length })}
      </p>

      {rows.length === 0 ? (
        <div className="bg-card rounded-card flex flex-col items-center gap-3 border px-4 py-8 text-center">
          <p className="text-muted-foreground">
            {filter.unmappedOnly && !filter.query ? t('noneUnmapped') : t('noneFound')}
          </p>
          {filter.query && (
            <Button variant="outline" onClick={() => set({ query: '' })}>
              <XIcon aria-hidden />
              {t('clearSearch')}
            </Button>
          )}
        </div>
      ) : wide ? (
        <DataTable
          testId="people-table"
          caption={t('listTitle')}
          columns={columns}
          rows={visible}
          rowKey={(p) => p.id}
          rowLabel={(p) => rowName(p, locale)}
        />
      ) : (
        <ul
          className="bg-card rounded-card shadow-card flex flex-col divide-y overflow-hidden border"
          data-testid="people-cards"
        >
          {visible.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 px-4 py-3" data-testid="person-card">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 flex-col">
                  <span className="font-semibold break-words">{rowName(p, locale)}</span>
                  <span className="text-muted-foreground text-sm">
                    {place(p)}
                    {p.kind === 'STUDENT' && (
                      <>
                        {' · '}
                        <Ascii value={p.studentCode} />
                      </>
                    )}
                  </span>
                </div>
                {showSync && p.deviceUserId && <SyncPill state={p.sync} />}
              </div>
              {cell(p, 'card')}
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown && (
        <Button variant="outline" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
          {t('showMore', { count: f(rows.length - shown) })}
        </Button>
      )}
    </section>
  );
}

/**
 * A person's device ID: shown (or the suggested default, greyed, when they have none) with an
 * edit button, or the editor in its place.
 */
function DeviceIdCell({
  person,
  variant,
  editing,
  onEditingChange,
}: {
  person: DevicePersonRow;
  variant: 'table' | 'card';
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const t = useTranslations('devices.people.edit');
  const locale = useLocale() as Locale;
  if (editing) {
    return <IdEditor person={person} variant={variant} onDone={() => onEditingChange(false)} />;
  }
  return (
    <div className="flex items-center gap-2">
      {person.deviceUserId ? (
        <Ascii value={person.deviceUserId} className="font-semibold" />
      ) : person.suggested ? (
        <span className="text-muted-foreground text-sm">
          {t.rich('suggested', {
            id: person.suggested,
            v: () => <Ascii value={person.suggested!} />,
          })}
        </span>
      ) : (
        <span className="text-muted-foreground text-sm">{t('none')}</span>
      )}
      <Button
        variant={person.deviceUserId ? 'ghost' : 'outline'}
        size={person.deviceUserId ? 'icon-sm' : 'sm'}
        className={variant === 'card' ? 'ms-auto' : undefined}
        aria-label={
          person.deviceUserId ? t('change', { name: rowName(person, locale) }) : undefined
        }
        onClick={() => onEditingChange(true)}
        data-testid="device-id-edit"
      >
        <PencilIcon aria-hidden />
        {!person.deviceUserId && t('set')}
      </Button>
    </div>
  );
}

/**
 * The ID in place: starts from their ID or the suggestion; Enter saves, Escape cancels, an empty
 * box clears the ID. Problems show under the box.
 */
function IdEditor({
  person,
  variant,
  onDone,
}: {
  person: DevicePersonRow;
  variant: 'table' | 'card';
  onDone: () => void;
}) {
  const t = useTranslations('devices.people.edit');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidatePeople();
  const { client } = useAuth();
  const name = rowName(person, locale);
  const [value, setValue] = useState(() => person.deviceUserId ?? person.suggested ?? '');
  const [error, setError] = useState<string | null>(null);
  // A device still has someone else under the ID: they are removed from the devices first.
  const [stillOnDevice, setStillOnDevice] = useState(false);
  const inputId = `device-id-${variant}-${person.id}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const save = useMutation({
    mutationFn: (deviceUserId: string | null) =>
      client.api<SetDeviceIdResult>('/attendance/device-people', {
        method: 'PUT',
        json: {
          ...(person.kind === 'STUDENT' ? { studentId: person.id } : { staffUserId: person.id }),
          deviceUserId,
        },
      }),
    onSuccess: (r) => {
      onDone();
      invalidate();
      if (r.deviceUserId === null) toast.success(t('cleared', { name }));
      else if (r.reenrol)
        toast.warning(t('reenrol', { name, id: r.deviceUserId, previous: r.previous ?? '' }), {
          duration: 12_000,
        });
      else if (r.queued > 0)
        toast.success(
          t('savedSent', { name, id: r.deviceUserId, count: formatCount(r.queued, locale) }),
        );
      else toast.success(t('saved', { name, id: r.deviceUserId }));
    },
    onError: (e) => {
      setError(message(e));
      setStillOnDevice(e instanceof ApiError && e.code === 'ID_STILL_ON_DEVICE');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = toAsciiDigits(value).trim();
    if (id !== '' && !DEVICE_USER_ID_RE.test(id)) return setError(t('invalid'));
    if (id === (person.deviceUserId ?? '')) return onDone();
    save.mutate(id === '' ? null : id);
  };

  return (
    <form className="flex flex-col gap-1" onSubmit={submit} data-testid="device-id-form">
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setStillOnDevice(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          dir="ltr"
          aria-label={t('label', { name })}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hintId}
          className="w-32 tabular-nums"
          data-testid="device-id-input"
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t('save')}
          disabled={save.isPending}
          data-testid="device-id-save"
        >
          <CheckIcon aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('cancel')} onClick={onDone}>
          <XIcon aria-hidden />
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-destructive text-sm" role="alert">
          {error}
          {stillOnDevice && (
            <>
              {' '}
              <a href="#device-stale-title" className="text-link font-medium underline">
                {t('stillOnDeviceLink')}
              </a>
            </>
          )}
        </p>
      ) : (
        <p id={hintId} className="text-muted-foreground text-xs">
          {t('hint')}
        </p>
      )}
    </form>
  );
}
