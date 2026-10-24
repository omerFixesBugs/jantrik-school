'use client';

import {
  formatDate,
  formatIdentifier,
  formatTime,
  formatMarks,
  parseMarks,
  type MarkCell,
  type MarkSheetHistoryEntry,
  type MarkSheetView,
} from '@jantrik/shared';
import { HistoryIcon, LockIcon, LockOpenIcon, PencilIcon, Undo2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SelectField, TextField } from '@/components/form-kit';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';
import { ExamDialog, useName } from './kit';

type Dialog = 'return' | 'lock' | 'unlock' | 'correct' | 'history' | null;

/** The office's actions on one sheet: return with a note, lock, unlock, correct, history. */
export function SheetAdminActions({
  examSubjectId,
  sectionId,
  onChanged,
}: {
  examSubjectId: string;
  sectionId: string;
  onChanged: () => void;
}) {
  const t = useTranslations('exams.sheetAdmin');
  const { client } = useAuth();
  const { data } = useExamQuery<MarkSheetView>(
    `/exams/sheets?examSubjectId=${examSubjectId}&sectionId=${sectionId}`,
  );
  const [open, setOpen] = useState<Dialog>(null);
  const [text, setText] = useState('');
  const sheet = data?.sheet;
  const run = useExamMutation(
    (what: 'return' | 'lock' | 'unlock') =>
      client.api(`/exams/sheets/${sheet!.id}/${what}`, {
        method: 'POST',
        json: what === 'return' ? { note: text } : what === 'unlock' ? { reason: text } : {},
      }),
    {
      success: t('done'),
      onSuccess: () => {
        setOpen(null);
        setText('');
        onChanged();
      },
    },
  );
  if (!data || !sheet?.id || data.exam.status !== 'OPEN') return null;
  return (
    <div className="flex flex-wrap gap-2 print:hidden" data-testid="sheet-admin">
      {sheet.status === 'SUBMITTED' && (
        <>
          <Button onClick={() => setOpen('lock')} data-testid="sheet-lock">
            <LockIcon aria-hidden />
            {t('lock')}
          </Button>
          <Button variant="outline" onClick={() => setOpen('return')}>
            <Undo2Icon aria-hidden />
            {t('return')}
          </Button>
        </>
      )}
      {sheet.status === 'LOCKED' && (
        <>
          <Button variant="outline" onClick={() => setOpen('correct')} data-testid="sheet-correct">
            <PencilIcon aria-hidden />
            {t('correct')}
          </Button>
          <Button variant="outline" onClick={() => setOpen('unlock')}>
            <LockOpenIcon aria-hidden />
            {t('unlock')}
          </Button>
        </>
      )}
      <Button variant="ghost" onClick={() => setOpen('history')}>
        <HistoryIcon aria-hidden />
        {t('history')}
      </Button>

      {(open === 'return' || open === 'unlock') && (
        <ExamDialog
          onClose={() => setOpen(null)}
          title={t(`${open}Title`)}
          description={t(`${open}Body`)}
          submitLabel={t(open)}
          pending={run.isPending || text.trim().length < 3}
          onSubmit={() => run.mutate(open)}
        >
          <TextField
            id="sheet-note"
            label={open === 'return' ? t('note') : t('reason')}
            value={text}
            onChange={setText}
            required
          />
        </ExamDialog>
      )}
      {open === 'lock' && (
        <ExamDialog
          onClose={() => setOpen(null)}
          title={t('lockTitle')}
          description={t('lockBody')}
          submitLabel={t('lock')}
          pending={run.isPending}
          onSubmit={() => run.mutate('lock')}
          submitTestId="sheet-lock-confirm"
        />
      )}
      {open === 'correct' && (
        <CorrectDialog
          view={data}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
        />
      )}
      {open === 'history' && <HistoryDialog view={data} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CorrectDialog({
  view,
  onClose,
  onDone,
}: {
  view: MarkSheetView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('exams.sheetAdmin');
  const name = useName();
  const { client } = useAuth();
  const [studentId, setStudentId] = useState(view.students[0]?.studentId ?? '');
  const [key, setKey] = useState(view.examSubject.components[0]?.key ?? '');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const full = view.examSubject.components.find((c) => c.key === key)?.fullMarks ?? 0;
  const parsed = parseMarks(value, full);
  const save = useExamMutation(
    () =>
      client.api(`/exams/sheets/${view.sheet.id}/corrections`, {
        method: 'PUT',
        json: { baseVersion: view.sheet.version, reason, entries: [{ studentId, key, value }] },
      }),
    { success: t('corrected'), onSuccess: onDone },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={t('correctTitle')}
      description={t('correctBody')}
      submitLabel={t('correct')}
      pending={
        save.isPending ||
        reason.trim().length < 3 ||
        (parsed.kind !== 'marks' && parsed.kind !== 'absent')
      }
      onSubmit={() => save.mutate(undefined)}
      testId="sheet-correct-dialog"
    >
      <SelectField
        id="correct-student"
        label={t('student')}
        value={studentId}
        onChange={setStudentId}
        options={view.students.map((s) => ({
          value: s.studentId,
          label: `${s.roll != null ? formatIdentifier(s.roll) : '–'} · ${name(s)}`,
        }))}
      />
      <SelectField
        id="correct-part"
        label={t('part')}
        value={key}
        onChange={setKey}
        options={view.examSubject.components.map((c) => ({ value: c.key, label: name(c) }))}
      />
      <TextField
        id="correct-value"
        label={t('newMarks', { full })}
        value={value}
        onChange={setValue}
        inputMode="decimal"
        error={parsed.kind === 'invalid' ? t('invalid') : null}
      />
      <TextField
        id="correct-reason"
        label={t('reason')}
        value={reason}
        onChange={setReason}
        required
      />
    </ExamDialog>
  );
}

function HistoryDialog({ view, onClose }: { view: MarkSheetView; onClose: () => void }) {
  const t = useTranslations('exams.sheetAdmin');
  const locale = useLocale() as Locale;
  const name = useName();
  const { data } = useExamQuery<MarkSheetHistoryEntry[]>(`/exams/sheets/${view.sheet.id}/history`);
  const who = new Map(view.students.map((s) => [s.studentId, s]));
  const cell = (c: MarkCell | null) =>
    !c ? '—' : c.absent ? t('absent') : c.scoreH === null ? '—' : formatMarks(c.scoreH, locale);
  return (
    <ExamDialog
      onClose={onClose}
      title={t('historyTitle')}
      submitLabel={t('close')}
      onSubmit={onClose}
      wide
    >
      <ol className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        {(data ?? [])
          .slice()
          .reverse()
          .map((h, i) => (
            <li key={i} className="rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {t(`action.${h.action}`)} · {h.by ? (h.by.nameBn ?? h.by.name) : '—'} ·{' '}
                {formatDate(h.at, locale)} {formatTime(h.at, locale)}
              </p>
              {h.reason && (
                <p className="text-muted-foreground">{t('because', { reason: h.reason })}</p>
              )}
              {h.changes.length > 0 && (
                <ul className="text-muted-foreground mt-1">
                  {h.changes.slice(0, 20).map((c, j) => {
                    const st = who.get(c.studentId);
                    return (
                      <li key={j}>
                        {st
                          ? `${st.roll != null ? formatIdentifier(st.roll) : ''} ${name(st)}`
                          : '—'}{' '}
                        · {c.key}: {cell(c.from)} → {cell(c.to)}
                      </li>
                    );
                  })}
                  {h.changes.length > 20 && <li>…</li>}
                </ul>
              )}
            </li>
          ))}
      </ol>
    </ExamDialog>
  );
}
