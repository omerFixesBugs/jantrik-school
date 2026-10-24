'use client';

import {
  formatDate,
  formatWallClock,
  type ExamDetail,
  type ExamSetupSubjects,
  type ExamSubjectView,
  type SetupClassLevel,
} from '@jantrik/shared';
import { ListChecksIcon, PencilIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard, TextField } from '@/components/form-kit';
import { FormGrid } from '@/components/form-layout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';
import { ExamDialog, LoadError, useName } from './kit';
import { partsProblems } from '@/lib/exams/parts';
import { PartsEditor, partsLine, type PartsValue } from './parts-editor';

/** The classes an exam covers and, per class, its subjects: routine date and time, parts, pass rule. */
export function ExamSetupPanel({ exam }: { exam: ExamDetail }) {
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="exam-setup">
      <ClassesCard exam={exam} />
      {exam.classes.map((c) => (
        <ClassSubjectsCard key={c.id} exam={exam} examClass={c} />
      ))}
    </div>
  );
}

function ClassesCard({ exam }: { exam: ExamDetail }) {
  const t = useTranslations('exams.setupPanel');
  const name = useName();
  const { client } = useAuth();
  const levels = useExamQuery<SetupClassLevel[]>('/setup/class-levels');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const current = picked ?? new Set(exam.classes.map((c) => c.classLevel.id));
  const save = useExamMutation(
    () =>
      client.api(`/exams/${exam.id}/classes`, {
        method: 'PUT',
        json: { classLevelIds: [...current] },
      }),
    { success: t('saved'), onSuccess: () => setPicked(null) },
  );
  return (
    <SectionCard
      id="exam-classes"
      title={t('classes')}
      hint={t('classesHint')}
      actions={
        <Button
          disabled={!picked || save.isPending || exam.status === 'ARCHIVED'}
          onClick={() => save.mutate(undefined)}
          data-testid="exam-classes-save"
        >
          {t('save')}
        </Button>
      }
    >
      {levels.isLoading ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : levels.error ? (
        <LoadError error={levels.error} onRetry={() => void levels.refetch()} />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {(levels.data ?? [])
            .filter((l) => l.isActive || current.has(l.id))
            .map((l) => (
              <li key={l.id}>
                <label className="has-[:focus-visible]:ring-ring has-[:checked]:border-primary-ink has-[:checked]:bg-primary-soft inline-flex min-h-(--control-h) cursor-pointer items-center gap-2 rounded-full border px-3 has-[:focus-visible]:ring-3">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={current.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      setPicked(next);
                    }}
                    data-testid={`exam-class-${l.code}`}
                  />
                  {name(l)}
                </label>
              </li>
            ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ClassSubjectsCard({
  exam,
  examClass,
}: {
  exam: ExamDetail;
  examClass: ExamDetail['classes'][number];
}) {
  const t = useTranslations('exams.setupPanel');
  const tRule = useTranslations('exams.parts.rule');
  const locale = useLocale() as Locale;
  const name = useName();
  const [editing, setEditing] = useState<ExamSubjectView | null>(null);
  const [choosing, setChoosing] = useState(false);
  return (
    <SectionCard
      id={`exam-class-${examClass.classLevel.code}`}
      title={name(examClass.classLevel)}
      hint={t('subjectsHint')}
      actions={
        <Button
          variant="outline"
          onClick={() => setChoosing(true)}
          disabled={exam.status === 'ARCHIVED'}
        >
          <ListChecksIcon aria-hidden />
          {t('chooseSubjects')}
        </Button>
      }
    >
      <ul className="divide-y">
        {examClass.subjects.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {name(s.subject)}
                {s.isElective && (
                  <span className="text-muted-foreground ms-2 text-sm">({t('elective')})</span>
                )}
              </span>
              <span className="text-muted-foreground block text-sm">
                {partsLine(s.components, locale)} · {tRule(s.passRule)}
                {s.examDate &&
                  ` · ${formatDate(s.examDate, locale)}${s.startTime ? ` ${formatWallClock(s.startTime, locale)}` : ''}`}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(s)}
              disabled={exam.status === 'ARCHIVED'}
              data-testid={`exam-subject-edit-${s.subject.code}`}
            >
              <PencilIcon aria-hidden />
              {t('edit')}
            </Button>
          </li>
        ))}
      </ul>
      {editing && (
        <SubjectDialog
          exam={exam}
          subject={editing}
          classLevelId={examClass.classLevel.id}
          onClose={() => setEditing(null)}
        />
      )}
      {choosing && (
        <ChooseSubjectsDialog
          exam={exam}
          examClass={examClass}
          onClose={() => setChoosing(false)}
        />
      )}
    </SectionCard>
  );
}

function SubjectDialog({
  exam,
  subject,
  classLevelId,
  onClose,
}: {
  exam: ExamDetail;
  subject: ExamSubjectView;
  classLevelId: string;
  onClose: () => void;
}) {
  const t = useTranslations('exams.setupPanel');
  const name = useName();
  const { client } = useAuth();
  const setup = useExamQuery<ExamSetupSubjects>(
    `/exams/setup/subjects?classLevelId=${classLevelId}`,
  );
  const [date, setDate] = useState(subject.examDate ?? '');
  const [time, setTime] = useState(subject.startTime ?? '');
  const [parts, setParts] = useState<PartsValue>({
    passRule: subject.passRule,
    components: subject.components,
    passGroups: subject.passGroups,
  });
  const save = useExamMutation(
    () =>
      client.api(`/exams/${exam.id}/subjects/${subject.id}`, {
        method: 'PUT',
        json: { examDate: date || null, startTime: time || null, ...parts },
      }),
    { success: t('saved'), onSuccess: onClose },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={name(subject.subject)}
      description={t('subjectDialogHint')}
      submitLabel={t('save')}
      pending={save.isPending || partsProblems(parts).length > 0}
      onSubmit={() => save.mutate(undefined)}
      wide
      testId="exam-subject-dialog"
    >
      <FormGrid className="xl:grid-cols-2">
        <TextField id="es-date" label={t('date')} type="date" value={date} onChange={setDate} />
        <TextField id="es-time" label={t('time')} type="time" value={time} onChange={setTime} />
      </FormGrid>
      <PartsEditor
        value={parts}
        onChange={setParts}
        bands={setup.data?.bands ?? []}
        idPrefix="es"
      />
    </ExamDialog>
  );
}

function ChooseSubjectsDialog({
  exam,
  examClass,
  onClose,
}: {
  exam: ExamDetail;
  examClass: ExamDetail['classes'][number];
  onClose: () => void;
}) {
  const t = useTranslations('exams.setupPanel');
  const name = useName();
  const { client } = useAuth();
  const setup = useExamQuery<ExamSetupSubjects>(
    `/exams/setup/subjects?classLevelId=${examClass.classLevel.id}`,
  );
  const [picked, setPicked] = useState(() => new Set(examClass.subjects.map((s) => s.subject.id)));
  const save = useExamMutation(
    () =>
      client.api(`/exams/${exam.id}/classes/${examClass.id}/subjects`, {
        method: 'PUT',
        json: {
          subjectIds: (setup.data?.subjects ?? []).filter((s) => picked.has(s.id)).map((s) => s.id),
        },
      }),
    { success: t('saved'), onSuccess: onClose },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={t('chooseTitle', { name: name(examClass.classLevel) })}
      description={t('chooseHint')}
      submitLabel={t('save')}
      pending={save.isPending || picked.size === 0}
      onSubmit={() => save.mutate(undefined)}
    >
      <ul className="flex flex-col gap-1">
        {(setup.data?.subjects ?? [])
          .filter((s) => s.isActive || picked.has(s.id))
          .map((s) => (
            <li key={s.id}>
              <label className="hover:bg-muted flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-md px-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={picked.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setPicked(next);
                  }}
                />
                {name(s)}
              </label>
            </li>
          ))}
      </ul>
    </ExamDialog>
  );
}
