'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADMISSION_FIELD_SETTINGS,
  ADMISSION_FIELDS,
  ADMISSION_TIE_BREAKS,
  DEFAULT_ADMISSION_FIELDS,
  type AdmissionCycleView,
  type AdmissionFieldSetting,
  type AdmissionTieBreak,
} from '@jantrik/shared';
import { ClipboardListIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CYCLE_TONE,
  errorCode,
  fromDhakaInput,
  toDhakaInput,
  useAdmissionOptions,
} from '@/components/admission/admission-kit';
import { SectionCard, SelectField, TextField, ToggleField } from '@/components/form-kit';
import { ActionBar, FormGrid } from '@/components/form-layout';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** One admission cycle: its window and form, its classes, and opening or closing it. */
export default function CyclePage() {
  return (
    <PageGate page="admission">
      <Cycle />
    </PageGate>
  );
}

interface Basics {
  academicYearId: string;
  nameBn: string;
  nameEn: string;
  opensAt: string;
  closesAt: string;
  publicNoteBn: string;
  publicNoteEn: string;
  requiresTest: boolean;
  collectPhoto: boolean;
  fields: Partial<Record<string, AdmissionFieldSetting>>;
  meritTieBreak: AdmissionTieBreak;
}

interface ClassRow {
  key: string;
  classLevelId: string;
  studyGroupId: string;
  seats: string;
  isOpen: boolean;
}

function basicsFrom(c: AdmissionCycleView): Basics {
  return {
    academicYearId: c.academicYear.id,
    nameBn: c.nameBn,
    nameEn: c.nameEn ?? '',
    opensAt: toDhakaInput(c.opensAt),
    closesAt: toDhakaInput(c.closesAt),
    publicNoteBn: c.publicNoteBn ?? '',
    publicNoteEn: c.publicNoteEn ?? '',
    requiresTest: c.requiresTest,
    collectPhoto: c.collectPhoto,
    fields: { ...c.fields },
    meritTieBreak: c.meritTieBreak,
  };
}

function Cycle() {
  const t = useTranslations('admissions.staff');
  const tc = useTranslations('admissions.staff.cycle');
  const tt = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const params = useParams<{ id: string }>();
  const isNew = params.id === 'new';
  const router = useRouter();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const options = useAdmissionOptions();
  const cycle = useQuery({
    queryKey: ['admission-cycle', session?.tenant?.id, params.id],
    queryFn: () => client.api<AdmissionCycleView>(`/admission/cycles/${params.id}`),
    enabled: !isNew,
  });

  const [basics, setBasics] = useState<Basics | null>(null);
  const [classes, setClasses] = useState<ClassRow[] | null>(null);
  // The form starts from what the server has (React's "state from props" pattern, set during
  // render): a new cycle from the options, an existing one each time it is loaded or saved.
  const [source, setSource] = useState<AdmissionCycleView | null>(null);
  if (isNew && options.data && !basics) {
    const next =
      options.data.years.find((y) => !y.isCurrent && y.startDate > new Date().toISOString()) ??
      options.data.years.find((y) => y.isCurrent) ??
      options.data.years[0];
    setBasics({
      academicYearId: next?.id ?? '',
      nameBn: '',
      nameEn: '',
      opensAt: '',
      closesAt: '',
      publicNoteBn: '',
      publicNoteEn: '',
      requiresTest: false,
      collectPhoto: false,
      fields: {},
      meritTieBreak: 'OLDER_FIRST',
    });
  }
  if (cycle.data && cycle.data !== source) {
    setSource(cycle.data);
    setBasics(basicsFrom(cycle.data));
    setClasses(
      cycle.data.classes.map((c) => ({
        key: c.id,
        classLevelId: c.classLevel.id,
        studyGroupId: c.studyGroup?.id ?? '',
        seats: c.seats ? String(c.seats) : '',
        isOpen: c.isOpen,
      })),
    );
  }

  const refresh = (c: AdmissionCycleView) => {
    queryClient.setQueryData(['admission-cycle', session?.tenant?.id, c.id], c);
    void queryClient.invalidateQueries({ queryKey: ['admission-cycles'] });
  };
  const failed = (e: unknown) => {
    const code = errorCode(e);
    if (code === 'WINDOW') toast.error(tc('errorWindow'));
    else if (code === 'CYCLE_HAS_APPLICATIONS') toast.error(tc('errorHasApplications'));
    else if (code === 'CYCLE_HAS_NO_CLASSES') toast.error(tc('errorNoClasses'));
    else if (code === 'CLASS_HAS_APPLICATIONS') toast.error(tc('errorClassHasApplications'));
    else if (code === 'RESULTS_PUBLISHED') toast.error(tt('resultsPublished'));
    else toast.error(describe(e));
  };

  const save = useMutation({
    mutationFn: () => {
      const b = basics!;
      const json = {
        academicYearId: b.academicYearId,
        nameBn: b.nameBn,
        nameEn: b.nameEn.trim() || null,
        opensAt: fromDhakaInput(b.opensAt),
        closesAt: fromDhakaInput(b.closesAt),
        publicNoteBn: b.publicNoteBn.trim() || null,
        publicNoteEn: b.publicNoteEn.trim() || null,
        requiresTest: b.requiresTest,
        collectPhoto: b.collectPhoto,
        fields: b.fields,
      };
      return isNew
        ? client.api<AdmissionCycleView>('/admission/cycles', { method: 'POST', json })
        : client.api<AdmissionCycleView>(`/admission/cycles/${params.id}`, {
            method: 'PATCH',
            json: { ...json, ...(b.requiresTest ? { meritTieBreak: b.meritTieBreak } : {}) },
          });
    },
    onSuccess: (c) => {
      refresh(c);
      toast.success(tc('saved'));
      if (isNew) router.replace(`/admission/cycles/${c.id}`);
    },
    onError: failed,
  });
  const saveClasses = useMutation({
    mutationFn: () =>
      client.api<AdmissionCycleView>(`/admission/cycles/${params.id}/classes`, {
        method: 'PUT',
        json: {
          classes: (classes ?? []).map((c) => ({
            classLevelId: c.classLevelId,
            studyGroupId: c.studyGroupId || null,
            seats: c.seats.trim() || null,
            isOpen: c.isOpen,
          })),
        },
      }),
    onSuccess: (c) => {
      refresh(c);
      toast.success(tc('saved'));
    },
    onError: failed,
  });
  const setStatus = useMutation({
    mutationFn: (status: 'OPEN' | 'CLOSED' | 'DRAFT') =>
      client.api<AdmissionCycleView>(`/admission/cycles/${params.id}/status`, {
        method: 'POST',
        json: { status },
      }),
    onSuccess: refresh,
    onError: failed,
  });

  if (options.isPending || !basics || (!isNew && cycle.isPending)) {
    return <Skeleton className="h-96 rounded-xl" />;
  }
  const o = options.data!;
  const set =
    <K extends keyof Basics>(k: K) =>
    (v: Basics[K]) =>
      setBasics({ ...basics, [k]: v });
  const c = cycle.data;
  const publicUrl =
    context && typeof window !== 'undefined'
      ? `${window.location.origin}/apply/${context.tenant.slug}`
      : null;
  const dupes = new Set<string>();
  const twice = (classes ?? []).some((r) => {
    const k = `${r.classLevelId}:${r.studyGroupId}`;
    if (dupes.has(k)) return true;
    dupes.add(k);
    return false;
  });

  return (
    <div className="flex flex-col gap-5">
      {c && (
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{displayName(c.nameBn, c.nameEn, locale)}</h2>
          <Pill tone={CYCLE_TONE[c.status]}>{t(`status.${c.status}`)}</Pill>
          <span className="text-muted-foreground text-sm">
            {c.takingApplications ? t('takingNow') : t('notTakingNow')}
          </span>
          <div className="ms-auto flex flex-wrap gap-2">
            {c.status !== 'OPEN' && (
              <Button
                onClick={() => setStatus.mutate('OPEN')}
                disabled={setStatus.isPending}
                data-testid="open-cycle"
              >
                {tc('openCycle')}
              </Button>
            )}
            {c.status === 'OPEN' && (
              <Button variant="outline" onClick={() => setStatus.mutate('CLOSED')}>
                {tc('closeCycle')}
              </Button>
            )}
            {c.status === 'CLOSED' && (
              <Button variant="ghost" onClick={() => setStatus.mutate('DRAFT')}>
                {tc('backToDraft')}
              </Button>
            )}
          </div>
        </div>
      )}
      {c && publicUrl && (
        <p className="text-muted-foreground text-sm">
          {tc('publicLink')}: <span className="font-mono select-all">{publicUrl}</span> —{' '}
          {tc('publicLinkHint')}
        </p>
      )}

      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <SectionCard id="cycle-basics" title={tc('basics')} hint={tc('basicsHint')}>
          <FormGrid>
            <SelectField
              id="academicYearId"
              label={tc('year')}
              value={basics.academicYearId}
              onChange={set('academicYearId')}
              options={o.years.map((y) => ({ value: y.id, label: y.name }))}
              required
            />
            <TextField
              id="cycleNameBn"
              label={tc('nameBn')}
              value={basics.nameBn}
              onChange={set('nameBn')}
              maxLength={80}
              required
            />
            <TextField
              id="cycleNameEn"
              label={tc('nameEn')}
              value={basics.nameEn}
              onChange={set('nameEn')}
              maxLength={80}
            />
            <TextField
              id="opensAt"
              type="datetime-local"
              label={tc('opensAt')}
              value={basics.opensAt}
              onChange={set('opensAt')}
              required
            />
            <TextField
              id="closesAt"
              type="datetime-local"
              label={tc('closesAt')}
              value={basics.closesAt}
              onChange={set('closesAt')}
              required
            />
            <TextField
              id="publicNoteBn"
              label={tc('noteBn')}
              value={basics.publicNoteBn}
              onChange={set('publicNoteBn')}
              maxLength={1000}
              className="md:col-span-2"
            />
            <TextField
              id="publicNoteEn"
              label={tc('noteEn')}
              value={basics.publicNoteEn}
              onChange={set('publicNoteEn')}
              maxLength={1000}
              className="md:col-span-2"
            />
          </FormGrid>
          <ToggleField
            id="requiresTest"
            checked={basics.requiresTest}
            onChange={set('requiresTest')}
            label={tc('requiresTest')}
            hint={tc('requiresTestHint')}
          />
          <ToggleField
            id="collectPhoto"
            checked={basics.collectPhoto}
            onChange={set('collectPhoto')}
            label={tc('collectPhoto')}
          />
          {!isNew && basics.requiresTest && (
            <FormGrid>
              <SelectField
                id="meritTieBreak"
                label={tt('tieBreak')}
                hint={tt('tieBreakHint')}
                value={basics.meritTieBreak}
                onChange={(v) => setBasics({ ...basics, meritTieBreak: v as AdmissionTieBreak })}
                options={ADMISSION_TIE_BREAKS.map((x) => ({
                  value: x,
                  label: tt(`tieBreaks.${x}`),
                }))}
              />
            </FormGrid>
          )}
        </SectionCard>

        <SectionCard id="cycle-fields" title={tc('fields')} hint={tc('fieldsHint')}>
          <FormGrid>
            {ADMISSION_FIELDS.filter((f) => f !== 'photo' || basics.collectPhoto).map((f) => (
              <SelectField
                key={f}
                id={`field-${f}`}
                label={tc(`field.${f}`)}
                value={
                  f === 'photo'
                    ? basics.fields.photo === 'REQUIRED'
                      ? 'REQUIRED'
                      : 'OPTIONAL'
                    : (basics.fields[f] ?? DEFAULT_ADMISSION_FIELDS[f])
                }
                onChange={(v) =>
                  setBasics({
                    ...basics,
                    fields: { ...basics.fields, [f]: v as AdmissionFieldSetting },
                  })
                }
                options={ADMISSION_FIELD_SETTINGS.filter(
                  (s) => f !== 'photo' || s !== 'HIDDEN',
                ).map((s) => ({ value: s, label: tc(`setting.${s}`) }))}
              />
            ))}
          </FormGrid>
        </SectionCard>

        <ActionBar>
          <Button type="submit" disabled={save.isPending} data-testid="save-cycle">
            {tc('save')}
          </Button>
        </ActionBar>
      </form>

      {!isNew && classes && (
        <SectionCard
          id="cycle-classes"
          title={tc('classes')}
          hint={tc('classesHint')}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setClasses([
                  ...classes,
                  {
                    key: crypto.randomUUID(),
                    classLevelId: o.classLevels.find((x) => x.isActive)?.id ?? '',
                    studyGroupId: '',
                    seats: '',
                    isOpen: true,
                  },
                ])
              }
              data-testid="add-class"
            >
              <PlusIcon aria-hidden />
              {tc('addClass')}
            </Button>
          }
        >
          <ul className="flex flex-col gap-3">
            {classes.map((row, i) => {
              const update = (patch: Partial<ClassRow>) =>
                setClasses(classes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              return (
                <li
                  key={row.key}
                  className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[2fr_2fr_1fr_auto_auto]"
                  data-testid="class-row"
                >
                  <SelectField
                    id={`class-${row.key}`}
                    label={tc('classLevel')}
                    value={row.classLevelId}
                    onChange={(v) => update({ classLevelId: v })}
                    options={o.classLevels
                      .filter((x) => x.isActive || x.id === row.classLevelId)
                      .map((x) => ({
                        value: x.id,
                        label: displayName(x.nameBn, x.nameEn, locale),
                      }))}
                  />
                  <SelectField
                    id={`group-${row.key}`}
                    label={tc('studyGroup')}
                    value={row.studyGroupId}
                    onChange={(v) => update({ studyGroupId: v })}
                    placeholder={tc('noGroup')}
                    options={o.studyGroups
                      .filter((x) => x.isActive || x.id === row.studyGroupId)
                      .map((x) => ({
                        value: x.id,
                        label: displayName(x.nameBn, x.nameEn, locale),
                      }))}
                  />
                  <TextField
                    id={`seats-${row.key}`}
                    label={tc('seats')}
                    value={row.seats}
                    onChange={(v) => update({ seats: v })}
                    inputMode="numeric"
                    placeholder={tc('seatsHint')}
                  />
                  <ToggleField
                    id={`open-${row.key}`}
                    checked={row.isOpen}
                    onChange={(v) => update({ isOpen: v })}
                    label={tc('open')}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tc('remove')}
                    onClick={() => setClasses(classes.filter((_, j) => j !== i))}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
          {twice && <p className="text-destructive text-sm">{tc('errorClassTwice')}</p>}
          <div className="flex justify-end">
            <Button
              onClick={() => saveClasses.mutate()}
              disabled={saveClasses.isPending || twice}
              data-testid="save-classes"
            >
              {tc('saveClasses')}
            </Button>
          </div>
        </SectionCard>
      )}

      {c?.requiresTest && c.classes.length > 0 && (
        <SectionCard id="cycle-tests" title={tt('byClass')}>
          <ul className="flex flex-col gap-2">
            {c.classes.map((cc) => (
              <li key={cc.id} className="flex flex-wrap items-center gap-3">
                <span className="flex-1">
                  {displayName(cc.classLevel.nameBn, cc.classLevel.nameEn, locale)}
                  {cc.studyGroup &&
                    ` · ${displayName(cc.studyGroup.nameBn, cc.studyGroup.nameEn, locale)}`}
                </span>
                <Link
                  href={`/admission/cycle-classes/${cc.id}/test`}
                  className="text-primary inline-flex min-h-(--control-h) items-center gap-1 text-sm underline-offset-4 hover:underline"
                  data-testid="open-test"
                >
                  <ClipboardListIcon aria-hidden className="size-4" />
                  {tt('openTest')}
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
