'use client';

import {
  GPA_ROUNDINGS,
  ROUNDING_MODES,
  formatCount,
  formatIdentifier,
  toAsciiDigits,
  type ExamRoomView,
  type ExamSetupSubjects,
  type ExamStaffMember,
  type GradingSchemeView,
  type LoadTemplateMarksResult,
  type SectionSubjectTeachersView,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupSection,
  type SubjectChoiceKind,
  type SubjectChoicesView,
  type SubjectMarksView,
} from '@jantrik/shared';
import {
  DoorOpenIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UserCheckIcon,
  WandSparklesIcon,
  XIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { EmptyState, NativeSelect, localDigits, parseWhole } from '@/components/fees/setup/kit';
import {
  InactiveBadge,
  SectionCard,
  SelectField,
  TextField,
  ToggleField,
} from '@/components/form-kit';
import { ActionBar, FormGrid } from '@/components/form-layout';
import { Pill } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';
import { ExamDialog, LoadError, useName } from './kit';
import { PartsEditor, partsLine, type PartsValue } from './parts-editor';

// ─────────────────────────── Pickers ───────────────────────────

/** Active classes, the first picked by default. */
function useClassPicker() {
  const levels = useExamQuery<SetupClassLevel[]>('/setup/class-levels');
  const active = (levels.data ?? []).filter((l) => l.isActive);
  const [picked, setPicked] = useState<string | null>(null);
  return {
    levels,
    active,
    classLevelId: picked ?? active[0]?.id ?? '',
    setClassLevelId: setPicked,
  };
}

/** This year's active sections ("Class Six · A"), the first picked by default. */
function useSectionPicker() {
  const name = useName();
  const { data: context } = useMeContext();
  const years = useExamQuery<SetupAcademicYear[]>('/setup/academic-years');
  const yearId = context?.academicYear?.id ?? years.data?.find((y) => y.isCurrent)?.id ?? null;
  const levels = useExamQuery<SetupClassLevel[]>('/setup/class-levels');
  const sections = useExamQuery<SetupSection[]>(
    yearId ? `/setup/sections?academicYearId=${yearId}` : null,
  );
  const levelOrder = new Map((levels.data ?? []).map((l, i) => [l.id, i]));
  const options = (sections.data ?? [])
    .filter((s) => s.isActive)
    .sort(
      (a, b) =>
        (levelOrder.get(a.classLevelId) ?? 0) - (levelOrder.get(b.classLevelId) ?? 0) ||
        a.sortOrder - b.sortOrder,
    )
    .map((s) => {
      const level = levels.data?.find((l) => l.id === s.classLevelId);
      return { value: s.id, label: `${level ? name(level) : ''} · ${s.name}` };
    });
  const [picked, setPicked] = useState<string | null>(null);
  return {
    loading: levels.isLoading || sections.isLoading || years.isLoading,
    error: levels.error ?? sections.error ?? years.error,
    retry: () => void Promise.all([levels.refetch(), sections.refetch(), years.refetch()]),
    options,
    sectionId: picked ?? options[0]?.value ?? '',
    setSectionId: setPicked,
  };
}

function SectionSelect({
  picker,
  id,
}: {
  picker: ReturnType<typeof useSectionPicker>;
  id: string;
}) {
  const t = useTranslations('exams.setup');
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {t('section')}
      </label>
      <NativeSelect
        id={id}
        value={picker.sectionId}
        onChange={picker.setSectionId}
        options={picker.options}
      />
    </div>
  );
}

// ─────────────────────────── Subject marks ───────────────────────────

/** Each class's subjects: their parts (CQ, MCQ, practical, papers), full and pass marks, pass rule. */
export function SubjectMarksTab() {
  const t = useTranslations('exams.setup');
  const name = useName();
  const { client } = useAuth();
  const picker = useClassPicker();
  const setup = useExamQuery<ExamSetupSubjects>(
    picker.classLevelId ? `/exams/setup/subjects?classLevelId=${picker.classLevelId}` : null,
  );
  const [editing, setEditing] = useState<SubjectMarksView | null>(null);
  const load = useExamMutation(
    () =>
      client.api<LoadTemplateMarksResult>('/exams/setup/subjects/load-template', {
        method: 'POST',
      }),
    { success: (r) => t('templateLoaded', { count: r.filled }) },
  );
  if (picker.levels.isLoading) return <Skeleton className="rounded-card h-64" />;
  if (picker.levels.error)
    return <LoadError error={picker.levels.error} onRetry={() => void picker.levels.refetch()} />;
  return (
    <SectionCard
      id="exams-setup-marks"
      title={t('marksTitle')}
      hint={t('marksHint')}
      actions={
        <Button
          variant="outline"
          onClick={() => load.mutate(undefined)}
          disabled={load.isPending}
          data-testid="load-template"
        >
          <WandSparklesIcon aria-hidden />
          {t('loadTemplate')}
        </Button>
      }
    >
      <div className="flex max-w-sm flex-col gap-1.5">
        <label htmlFor="marks-class" className="font-medium">
          {t('class')}
        </label>
        <NativeSelect
          id="marks-class"
          value={picker.classLevelId}
          onChange={picker.setClassLevelId}
          options={picker.active.map((l) => ({ value: l.id, label: name(l) }))}
        />
      </div>
      {setup.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : setup.error || !setup.data ? (
        <LoadError error={setup.error} onRetry={() => void setup.refetch()} />
      ) : (
        <SubjectMarksList data={setup.data} onEdit={setEditing} />
      )}
      {editing && setup.data && (
        <SubjectMarksDialog
          subject={editing}
          bands={setup.data.bands}
          onClose={() => setEditing(null)}
        />
      )}
    </SectionCard>
  );
}

function SubjectMarksList({
  data,
  onEdit,
}: {
  data: ExamSetupSubjects;
  onEdit: (s: SubjectMarksView) => void;
}) {
  const t = useTranslations('exams.setup');
  const tRule = useTranslations('exams.parts.rule');
  const locale = useLocale() as Locale;
  const name = useName();
  if (data.subjects.length === 0) return <p className="text-muted-foreground">{t('noSubjects')}</p>;
  return (
    <ul className="divide-y">
      {data.subjects.map((s) => (
        <li
          key={s.id}
          className="flex flex-wrap items-center gap-3 py-2.5"
          data-testid={`marks-subject-${s.code}`}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {name(s)}
              {s.isOptional && <Pill tone="neutral">{t('pool')}</Pill>}
              {s.studyGroup && (
                <span className="text-muted-foreground text-sm">{name(s.studyGroup)}</span>
              )}
              <InactiveBadge active={s.isActive} />
            </span>
            <span className="text-muted-foreground block text-sm">
              {s.components.length > 0
                ? `${partsLine(s.components, locale)} · ${tRule(s.passRule)}`
                : t('noParts')}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(s)}
            aria-label={t('editParts', { subject: name(s) })}
          >
            <PencilIcon aria-hidden />
            {t('edit')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function SubjectMarksDialog({
  subject,
  bands,
  onClose,
}: {
  subject: SubjectMarksView;
  bands: ExamSetupSubjects['bands'];
  onClose: () => void;
}) {
  const t = useTranslations('exams.setup');
  const name = useName();
  const { client } = useAuth();
  const [parts, setParts] = useState<PartsValue>({
    passRule: subject.passRule,
    components:
      subject.components.length > 0
        ? subject.components
        : [
            {
              key: 'WRITTEN',
              kind: 'WRITTEN',
              nameBn: 'লিখিত',
              nameEn: 'Written',
              fullMarks: 100,
              passMarks: 33,
            },
          ],
    passGroups: subject.passGroups,
  });
  const save = useExamMutation(
    () => client.api(`/exams/setup/subjects/${subject.id}/marks`, { method: 'PUT', json: parts }),
    { success: t('saved'), onSuccess: onClose },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={name(subject)}
      description={t('partsHint')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      wide
      testId="marks-dialog"
    >
      <PartsEditor value={parts} onChange={setParts} bands={bands} idPrefix="sm" />
    </ExamDialog>
  );
}

// ─────────────────────────── Subject teachers ───────────────────────────

/** Who enters each subject's marks in a section (up to five teachers per subject). */
export function SubjectTeachersTab() {
  const t = useTranslations('exams.setup');
  const picker = useSectionPicker();
  const view = useExamQuery<SectionSubjectTeachersView>(
    picker.sectionId ? `/exams/setup/sections/${picker.sectionId}/subject-teachers` : null,
  );
  const staff = useExamQuery<ExamStaffMember[]>('/exams/staff');
  if (picker.loading) return <Skeleton className="rounded-card h-64" />;
  if (picker.error) return <LoadError error={picker.error} onRetry={picker.retry} />;
  return (
    <SectionCard id="exams-setup-teachers" title={t('teachersTitle')} hint={t('teachersHint')}>
      {picker.options.length === 0 ? (
        <p className="text-muted-foreground">{t('noSections')}</p>
      ) : (
        <>
          <SectionSelect picker={picker} id="teachers-section" />
          {view.isLoading || staff.isLoading ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : view.error || staff.error || !view.data ? (
            <LoadError
              error={view.error ?? staff.error}
              onRetry={() => void Promise.all([view.refetch(), staff.refetch()])}
            />
          ) : (
            <TeachersForm
              key={view.data.section.id + view.dataUpdatedAt}
              view={view.data}
              staff={staff.data ?? []}
            />
          )}
        </>
      )}
    </SectionCard>
  );
}

function TeachersForm({
  view,
  staff,
}: {
  view: SectionSubjectTeachersView;
  staff: ExamStaffMember[];
}) {
  const t = useTranslations('exams.setup');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const person = (p: { name: string; nameBn: string | null }) =>
    (locale === 'bn' ? (p.nameBn ?? p.name) : p.name) || '—';
  const initial = Object.fromEntries(
    view.subjects.map((s) => [s.subject.id, s.teachers.map((x) => x.id)]),
  );
  const [ids, setIds] = useState<Record<string, string[]>>(initial);
  const dirty = view.subjects.some(
    (s) => (ids[s.subject.id] ?? []).join() !== (initial[s.subject.id] ?? []).join(),
  );
  const byId = new Map(staff.map((s) => [s.id, s]));
  for (const s of view.subjects)
    for (const p of s.teachers) if (!byId.has(p.id)) byId.set(p.id, { ...p, role: 'TEACHER' });
  const save = useExamMutation(
    () =>
      client.api(`/exams/setup/sections/${view.section.id}/subject-teachers`, {
        method: 'PUT',
        json: {
          assignments: view.subjects.map((s) => ({
            subjectId: s.subject.id,
            userIds: ids[s.subject.id] ?? [],
          })),
        },
      }),
    { success: t('saved') },
  );
  const classTeacher = view.classTeacher;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      {classTeacher && (
        <div>
          <Button
            type="button"
            variant="outline"
            // A long name: the label wraps instead of running off a phone.
            className="h-auto min-h-(--control-h) py-2 text-start whitespace-normal"
            onClick={() =>
              setIds((x) =>
                Object.fromEntries(
                  view.subjects.map((s) => {
                    const now = x[s.subject.id] ?? [];
                    return [
                      s.subject.id,
                      now.includes(classTeacher.id) || now.length >= 5
                        ? now
                        : [...now, classTeacher.id],
                    ];
                  }),
                ),
              )
            }
            data-testid="assign-class-teacher"
          >
            <UserCheckIcon aria-hidden />
            {t('assignClassTeacher', { name: person(classTeacher) })}
          </Button>
        </div>
      )}
      <ul className="divide-y rounded-xl border">
        {view.subjects.map((s) => {
          const mine = ids[s.subject.id] ?? [];
          const free = staff.filter((p) => !mine.includes(p.id));
          return (
            <li
              key={s.subject.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center"
              data-testid={`teachers-${s.subject.code}`}
            >
              <span className="min-w-40 font-medium">{name(s.subject)}</span>
              <ul className="flex flex-1 flex-wrap gap-1.5">
                {mine.map((uid) => {
                  const p = byId.get(uid);
                  return (
                    <li key={uid}>
                      {/* The remove button takes the density's touch size (44 px on a phone). */}
                      <span className="bg-primary-soft inline-flex min-h-(--control-h-xs) items-center rounded-full ps-3 text-sm">
                        {p ? person(p) : '—'}
                        <button
                          type="button"
                          className="hover:bg-muted focus-visible:ring-ring inline-flex size-(--control-h-xs) items-center justify-center rounded-full outline-none focus-visible:ring-3"
                          aria-label={t('removeTeacher', { name: p ? person(p) : '' })}
                          onClick={() =>
                            setIds((x) => ({ ...x, [s.subject.id]: mine.filter((m) => m !== uid) }))
                          }
                        >
                          <XIcon aria-hidden className="size-3.5" />
                        </button>
                      </span>
                    </li>
                  );
                })}
                {mine.length === 0 && (
                  <li className="text-muted-foreground text-sm">{t('noTeacher')}</li>
                )}
              </ul>
              {mine.length < 5 && free.length > 0 && (
                <NativeSelect
                  id={`add-${s.subject.id}`}
                  aria-label={t('addTeacher', { subject: name(s.subject) })}
                  className="sm:w-56"
                  value=""
                  onChange={(uid) =>
                    uid && setIds((x) => ({ ...x, [s.subject.id]: [...mine, uid] }))
                  }
                  options={[
                    { value: '', label: t('addTeacherOption') },
                    ...free.map((p) => ({ value: p.id, label: person(p) })),
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>
      <ActionBar note={dirty ? t('unsaved') : undefined}>
        <Button type="submit" disabled={!dirty || save.isPending} data-testid="teachers-save">
          <SaveIcon aria-hidden />
          {t('save')}
        </Button>
      </ActionBar>
      {view.subjects.length === 0 && <p className="text-muted-foreground">{t('noSubjects')}</p>}
    </form>
  );
}

// ─────────────────────────── Subject choices ───────────────────────────

type Choice = SubjectChoiceKind | '';

/** Per student, which elective-pool subjects they take and which is their 4th subject. */
export function SubjectChoicesTab() {
  const t = useTranslations('exams.setup');
  const picker = useSectionPicker();
  const view = useExamQuery<SubjectChoicesView>(
    picker.sectionId ? `/exams/setup/sections/${picker.sectionId}/subject-choices` : null,
  );
  if (picker.loading) return <Skeleton className="rounded-card h-64" />;
  if (picker.error) return <LoadError error={picker.error} onRetry={picker.retry} />;
  return (
    <SectionCard id="exams-setup-choices" title={t('choicesTitle')} hint={t('choicesHint')}>
      {picker.options.length === 0 ? (
        <p className="text-muted-foreground">{t('noSections')}</p>
      ) : (
        <>
          <SectionSelect picker={picker} id="choices-section" />
          {view.isLoading ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : view.error || !view.data ? (
            <LoadError error={view.error} onRetry={() => void view.refetch()} />
          ) : view.data.pool.length === 0 ? (
            <p className="text-muted-foreground" data-testid="choices-no-pool">
              {t('noPool')}
            </p>
          ) : (
            <ChoicesForm key={view.data.section.id + view.dataUpdatedAt} view={view.data} />
          )}
        </>
      )}
    </SectionCard>
  );
}

function ChoicesForm({ view }: { view: SubjectChoicesView }) {
  const t = useTranslations('exams.setup');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const key = (studentId: string, subjectId: string) => `${studentId}:${subjectId}`;
  const initial: Record<string, Choice> = {};
  for (const s of view.students)
    for (const c of s.choices) initial[key(s.id, c.subjectId)] = c.kind;
  const [choice, setChoice] = useState<Record<string, Choice>>(initial);
  const [bulk, setBulk] = useState({
    subjectId: view.pool[0]?.id ?? '',
    kind: 'COMPULSORY' as Choice,
  });
  // A pool subject of a study group is only for that group's students.
  const fits = (
    student: SubjectChoicesView['students'][number],
    subject: SubjectChoicesView['pool'][number],
  ) => !subject.studyGroupId || subject.studyGroupId === student.studyGroup?.id;
  const set = (studentId: string, subjectId: string, kind: Choice) =>
    setChoice((x) => {
      const next = { ...x, [key(studentId, subjectId)]: kind };
      // One 4th subject each: choosing another moves the old one to "takes it".
      if (kind === 'OPTIONAL')
        for (const p of view.pool)
          if (p.id !== subjectId && next[key(studentId, p.id)] === 'OPTIONAL')
            next[key(studentId, p.id)] = 'COMPULSORY';
      return next;
    });
  const changed = view.students.filter((s) =>
    view.pool.some((p) => (choice[key(s.id, p.id)] ?? '') !== (initial[key(s.id, p.id)] ?? '')),
  );
  const missing = view.students.filter((s) =>
    view.pool.every((p) => !choice[key(s.id, p.id)]),
  ).length;
  const save = useExamMutation(
    () =>
      client.api(`/exams/setup/sections/${view.section.id}/subject-choices`, {
        method: 'PUT',
        json: {
          students: changed.map((s) => ({
            studentId: s.id,
            choices: view.pool
              .filter((p) => choice[key(s.id, p.id)])
              .map((p) => ({
                subjectId: p.id,
                kind: choice[key(s.id, p.id)] as SubjectChoiceKind,
              })),
          })),
        },
      }),
    { success: t('saved') },
  );
  const kindOptions = [
    { value: '', label: t('choice.none') },
    { value: 'COMPULSORY', label: t('choice.COMPULSORY') },
    { value: 'OPTIONAL', label: t('choice.OPTIONAL') },
  ];
  const bulkSubject = view.pool.find((p) => p.id === bulk.subjectId);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length > 0) save.mutate(undefined);
      }}
    >
      <fieldset className="flex flex-col gap-2 rounded-xl border p-3">
        <legend className="px-1 text-sm font-medium">{t('bulkTitle')}</legend>
        <div className="flex flex-wrap items-end gap-2">
          <NativeSelect
            id="bulk-subject"
            aria-label={t('subject')}
            className="w-48"
            value={bulk.subjectId}
            onChange={(subjectId) => setBulk((b) => ({ ...b, subjectId }))}
            options={view.pool.map((p) => ({ value: p.id, label: name(p) }))}
          />
          <NativeSelect
            id="bulk-kind"
            aria-label={t('choiceLabel')}
            className="w-44"
            value={bulk.kind}
            onChange={(kind) => setBulk((b) => ({ ...b, kind: kind as Choice }))}
            options={kindOptions}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!bulkSubject}
            onClick={() => {
              for (const s of view.students)
                if (bulkSubject && fits(s, bulkSubject)) set(s.id, bulkSubject.id, bulk.kind);
            }}
            data-testid="choices-bulk"
          >
            {t('bulkApply')}
          </Button>
        </div>
      </fieldset>
      {missing > 0 && (
        <p className="text-warning text-sm" role="status">
          {t('missingChoices', { count: formatCount(missing, locale) })}
        </p>
      )}
      <ul className="divide-y rounded-xl border">
        {view.students.map((s) => (
          <li
            key={s.id}
            className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center"
            data-testid="choices-student"
          >
            <span className="flex min-w-56 items-baseline gap-2">
              <span className="bg-muted rounded px-1.5 font-mono text-xs">
                {s.roll != null ? formatIdentifier(s.roll) : '—'}
              </span>
              <span className="font-medium">{name(s)}</span>
              {s.studyGroup && (
                <span className="text-muted-foreground text-sm">{name(s.studyGroup)}</span>
              )}
            </span>
            <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {view.pool
                .filter((p) => fits(s, p))
                .map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-24">{name(p)}</span>
                    <NativeSelect
                      id={`choice-${s.id}-${p.id}`}
                      className="flex-1"
                      value={choice[key(s.id, p.id)] ?? ''}
                      onChange={(kind) => set(s.id, p.id, kind as Choice)}
                      options={kindOptions}
                    />
                  </label>
                ))}
            </div>
          </li>
        ))}
      </ul>
      <ActionBar
        note={
          changed.length > 0
            ? t('unsavedStudents', { count: formatCount(changed.length, locale) })
            : undefined
        }
      >
        <Button
          type="submit"
          disabled={changed.length === 0 || save.isPending}
          data-testid="choices-save"
        >
          <SaveIcon aria-hidden />
          {t('save')}
        </Button>
      </ActionBar>
    </form>
  );
}

// ─────────────────────────── Rooms ───────────────────────────

/** Exam rooms (benches in rows × columns) for seat plans. */
export function RoomsTab() {
  const t = useTranslations('exams.setup');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const rooms = useExamQuery<ExamRoomView[]>('/exams/rooms');
  const [editing, setEditing] = useState<ExamRoomView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ExamRoomView | null>(null);
  const remove = useExamMutation(
    (id: string) => client.api(`/exams/rooms/${id}`, { method: 'DELETE' }),
    {
      success: t('deleted'),
      onSuccess: () => setDeleting(null),
    },
  );
  return (
    <SectionCard
      id="exams-setup-rooms"
      title={t('roomsTitle')}
      hint={t('roomsHint')}
      actions={
        <Button onClick={() => setEditing('new')} data-testid="room-add">
          <PlusIcon aria-hidden />
          {t('addRoom')}
        </Button>
      }
    >
      {rooms.isLoading ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : rooms.error ? (
        <LoadError error={rooms.error} onRetry={() => void rooms.refetch()} />
      ) : (rooms.data ?? []).length === 0 ? (
        <EmptyState icon={DoorOpenIcon} title={t('noRooms')} text={t('noRoomsHint')} />
      ) : (
        <ul className="divide-y">
          {rooms.data!.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5" data-testid="room">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium">
                  {r.name}
                  <InactiveBadge active={r.isActive} />
                </span>
                <span className="text-muted-foreground text-sm">
                  {t('roomSize', {
                    rows: formatCount(r.rows, locale),
                    cols: formatCount(r.cols, locale),
                    seats: formatCount(r.capacity, locale),
                  })}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(r)}
                aria-label={t('editRoom', { name: r.name })}
              >
                <PencilIcon aria-hidden />
                {t('edit')}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDeleting(r)}
                aria-label={t('deleteRoomLabel', { name: r.name })}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <RoomDialog room={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {deleting && (
        <ExamDialog
          onClose={() => setDeleting(null)}
          title={t('deleteRoom', { name: deleting.name })}
          description={t('deleteRoomBody')}
          submitLabel={t('delete')}
          pending={remove.isPending}
          onSubmit={() => remove.mutate(deleting.id)}
          destructive
        />
      )}
    </SectionCard>
  );
}

function RoomDialog({ room, onClose }: { room: ExamRoomView | null; onClose: () => void }) {
  const t = useTranslations('exams.setup');
  const locale = useLocale();
  const { client } = useAuth();
  const [form, setForm] = useState({
    name: room?.name ?? '',
    rows: localDigits(String(room?.rows ?? 5), locale),
    cols: localDigits(String(room?.cols ?? 4), locale),
    isActive: room?.isActive ?? true,
  });
  const rows = parseWhole(form.rows);
  const cols = parseWhole(form.cols);
  const tooBig = rows != null && cols != null && rows * cols > 500;
  const save = useExamMutation(
    () =>
      client.api(room ? `/exams/rooms/${room.id}` : '/exams/rooms', {
        method: room ? 'PATCH' : 'POST',
        json: { name: form.name, rows, cols, isActive: form.isActive },
      }),
    { success: t('saved'), onSuccess: onClose },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={room ? t('editRoom', { name: room.name }) : t('addRoom')}
      submitLabel={t('save')}
      pending={save.isPending || !form.name.trim() || !rows || !cols || tooBig}
      onSubmit={() => save.mutate(undefined)}
      testId="room-dialog"
    >
      <TextField
        id="room-name"
        label={t('roomName')}
        value={form.name}
        onChange={(name) => setForm((f) => ({ ...f, name }))}
        required
      />
      <FormGrid className="md:grid-cols-2 xl:grid-cols-2">
        <TextField
          id="room-rows"
          label={t('rows')}
          inputMode="numeric"
          value={form.rows}
          onChange={(v) => setForm((f) => ({ ...f, rows: v }))}
        />
        <TextField
          id="room-cols"
          label={t('cols')}
          inputMode="numeric"
          value={form.cols}
          onChange={(v) => setForm((f) => ({ ...f, cols: v }))}
          error={tooBig ? t('tooManySeats') : null}
        />
      </FormGrid>
      <ToggleField
        id="room-active"
        checked={form.isActive}
        onChange={(isActive) => setForm((f) => ({ ...f, isActive }))}
        label={t('roomActive')}
      />
    </ExamDialog>
  );
}

// ─────────────────────────── Grading rules ───────────────────────────

/** The GPA rules of each grading scheme (the bands are shown, not edited, in this release). */
export function GradingTab() {
  const t = useTranslations('exams.setup');
  const schemes = useExamQuery<GradingSchemeView[]>('/exams/grading');
  if (schemes.isLoading) return <Skeleton className="rounded-card h-64" />;
  if (schemes.error)
    return <LoadError error={schemes.error} onRetry={() => void schemes.refetch()} />;
  return (
    <div className="flex flex-col gap-(--section-gap)">
      {(schemes.data ?? []).map((s) => (
        <GradingCard key={s.id + s.gpaMax + s.gpaRounding + s.roundingMode} scheme={s} />
      ))}
      {(schemes.data ?? []).length === 0 && (
        <p className="text-muted-foreground">{t('noSchemes')}</p>
      )}
    </div>
  );
}

const decimalText = (n: number | null, locale: string) =>
  n == null ? '' : localDigits(n.toFixed(2), locale);
const parseDecimal = (text: string): number | null => {
  const ascii = toAsciiDigits(text).trim();
  return /^\d{1,2}(\.\d{1,2})?$/.test(ascii) ? Number(ascii) : null;
};

function GradingCard({ scheme }: { scheme: GradingSchemeView }) {
  const t = useTranslations('exams.setup');
  const tRound = useTranslations('exams.setup.rounding');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const [form, setForm] = useState({
    roundingMode: scheme.roundingMode as string,
    gpaMax: decimalText(scheme.gpaMax, locale),
    optionalBonusAbove: decimalText(scheme.optionalBonusAbove, locale),
    gpaDecimals: String(scheme.gpaDecimals),
    gpaRounding: scheme.gpaRounding as string,
    compulsoryFailZero: scheme.compulsoryFailZero,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const gpaMax = parseDecimal(form.gpaMax);
  const bonus =
    form.optionalBonusAbove.trim() === '' ? null : parseDecimal(form.optionalBonusAbove);
  const bonusBad = form.optionalBonusAbove.trim() !== '' && bonus === null;
  const save = useExamMutation(
    () =>
      client.api(`/exams/grading/${scheme.id}`, {
        method: 'PUT',
        json: {
          roundingMode: form.roundingMode,
          gpaMax,
          optionalBonusAbove: bonus,
          gpaDecimals: Number(form.gpaDecimals),
          gpaRounding: form.gpaRounding,
          compulsoryFailZero: form.compulsoryFailZero,
        },
      }),
    { success: t('saved') },
  );
  return (
    <SectionCard
      id={`grading-${scheme.id}`}
      title={name(scheme)}
      hint={
        scheme.isDefault
          ? t('defaultScheme')
          : t('schemeFor', { classes: scheme.classLevels.map((c) => name(c)).join(', ') })
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <FormGrid>
          <SelectField
            id={`${scheme.id}-rounding`}
            label={t('roundingMode')}
            hint={t('roundingModeHint')}
            value={form.roundingMode}
            onChange={(roundingMode) => set({ roundingMode })}
            options={ROUNDING_MODES.map((m) => ({ value: m, label: tRound(m) }))}
          />
          <TextField
            id={`${scheme.id}-max`}
            label={t('gpaMax')}
            inputMode="decimal"
            value={form.gpaMax}
            onChange={(gpaMax) => set({ gpaMax })}
            error={gpaMax === null ? t('badNumber') : null}
          />
          <TextField
            id={`${scheme.id}-bonus`}
            label={t('bonusAbove')}
            hint={t('bonusAboveHint')}
            inputMode="decimal"
            value={form.optionalBonusAbove}
            onChange={(optionalBonusAbove) => set({ optionalBonusAbove })}
            error={bonusBad ? t('badNumber') : null}
          />
          <SelectField
            id={`${scheme.id}-decimals`}
            label={t('gpaDecimals')}
            value={form.gpaDecimals}
            onChange={(gpaDecimals) => set({ gpaDecimals })}
            options={['0', '1', '2'].map((d) => ({ value: d, label: localDigits(d, locale) }))}
          />
          <SelectField
            id={`${scheme.id}-gpa-rounding`}
            label={t('gpaRounding')}
            hint={t('gpaRoundingHint')}
            value={form.gpaRounding}
            onChange={(gpaRounding) => set({ gpaRounding })}
            options={GPA_ROUNDINGS.map((m) => ({ value: m, label: tRound(m) }))}
          />
        </FormGrid>
        <ToggleField
          id={`${scheme.id}-fail-zero`}
          checked={form.compulsoryFailZero}
          onChange={(compulsoryFailZero) => set({ compulsoryFailZero })}
          label={t('failZero')}
          hint={t('failZeroHint')}
        />
        <details className="rounded-xl border p-3">
          <summary className="min-h-(--control-h) cursor-pointer content-center font-medium">
            {t('bands')}
          </summary>
          <table className="mt-2 w-full max-w-md text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-1 text-start">
                  {t('marksRange')}
                </th>
                <th scope="col" className="py-1 text-center">
                  {t('letter')}
                </th>
                <th scope="col" className="py-1 text-end">
                  {t('point')}
                </th>
              </tr>
            </thead>
            <tbody>
              {scheme.bands.map((b) => (
                <tr key={b.letter} className="border-b last:border-0">
                  <td className="font-numeric py-1">
                    {formatCount(b.minPercent, locale)}–{formatCount(b.maxPercent, locale)}
                  </td>
                  <td className="py-1 text-center">{b.letter}</td>
                  <td className="font-numeric py-1 text-end">
                    {localDigits(b.gradePoint.toFixed(2), locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <div>
          <Button
            type="submit"
            disabled={save.isPending || gpaMax === null || bonusBad}
            data-testid={`grading-save-${scheme.id}`}
          >
            <SaveIcon aria-hidden />
            {t('save')}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
