'use client';

import {
  formatCount,
  formatTaka,
  type ExamDetail,
  type PublishCheck,
  type ResultSmsPreview,
  type ResultSmsRun,
} from '@jantrik/shared';
import {
  CircleAlertIcon,
  EyeOffIcon,
  FileTextIcon,
  MessageSquareTextIcon,
  MessageSquareIcon,
  SendIcon,
  TableIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { SectionCard, TextField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';
import { ExamDialog, LoadError, useName } from './kit';

/** Per class: what still blocks publishing, publish or republish, unpublish, result SMS, prints. */
export function ResultsPanel({ exam }: { exam: ExamDetail }) {
  if (exam.status === 'SETUP') return null;
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="exam-results">
      {exam.classes.map((c) => (
        <ClassResults key={c.id} exam={exam} examClass={c} />
      ))}
    </div>
  );
}

function ClassResults({
  exam,
  examClass,
}: {
  exam: ExamDetail;
  examClass: ExamDetail['classes'][number];
}) {
  const t = useTranslations('exams.results');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const check = useExamQuery<PublishCheck>(
    `/exams/${exam.id}/classes/${examClass.id}/publish-check`,
  );
  const [dialog, setDialog] = useState<'publish' | 'unpublish' | 'sms' | null>(null);
  const publish = useExamMutation(
    (baseVersion: number) =>
      client.api<PublishCheck>(`/exams/${exam.id}/classes/${examClass.id}/publish`, {
        method: 'POST',
        json: { baseVersion },
      }),
    { success: t('publishedToast'), onSuccess: () => setDialog(null) },
  );
  const sections = useSections(exam.id, examClass.classLevel.id);
  const c = check.data;
  const code = examClass.classLevel.code;
  return (
    <SectionCard
      id={`results-${code}`}
      title={name(examClass.classLevel)}
      actions={
        c && (
          <Pill tone={c.isPublished ? (c.stale ? 'warning' : 'success') : 'neutral'}>
            {c.isPublished
              ? c.stale
                ? t('stale')
                : t('publishedVersion', { version: formatCount(c.publishedVersion, locale) })
              : t('notPublished')}
          </Pill>
        )
      }
    >
      {check.isLoading ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : check.error || !c ? (
        <LoadError error={check.error} onRetry={() => void check.refetch()} />
      ) : (
        <>
          {c.blockers.unlockedSheets.length > 0 && (
            <Alert data-testid={`blockers-${code}`}>
              <CircleAlertIcon aria-hidden />
              <AlertDescription>
                <p>
                  {t('unlocked', {
                    count: formatCount(c.blockers.unlockedSheets.length, locale),
                    n: c.blockers.unlockedSheets.length,
                  })}
                </p>
                <ul className="mt-1 list-disc ps-5 text-sm">
                  {c.blockers.unlockedSheets.slice(0, 8).map((s) => (
                    <li key={`${s.examSubjectId}:${s.section.id}`}>
                      {name(s.subject)} · {s.section.name}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {c.blockers.incompleteStudents > 0 && (
            <p className="text-warning text-sm">
              {t('incomplete', { count: formatCount(c.blockers.incompleteStudents, locale) })}
            </p>
          )}
          {(c.warnings.rosterChanges > 0 || c.warnings.missingChoices > 0) && (
            <Alert>
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>
                {c.warnings.rosterChanges > 0 && (
                  <p>
                    {t('rosterWarning', { count: formatCount(c.warnings.rosterChanges, locale) })}
                  </p>
                )}
                {c.warnings.missingChoices > 0 && (
                  <p>
                    {t('choicesWarning', { count: formatCount(c.warnings.missingChoices, locale) })}
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}
          {c.isPublished && c.stale && (
            <p className="text-warning text-sm" data-testid={`stale-${code}`}>
              {t('staleHint')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={c.blockers.unlockedSheets.length > 0 || c.blockers.incompleteStudents > 0}
              onClick={() => setDialog('publish')}
              data-testid={`publish-${code}`}
            >
              <SendIcon aria-hidden />
              {c.isPublished ? t('republish') : t('publish')}
            </Button>
            {c.isPublished && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setDialog('sms')}
                  data-testid={`sms-${code}`}
                >
                  <MessageSquareIcon aria-hidden />
                  {t('sms')}
                </Button>
                <Button variant="outline" onClick={() => setDialog('unpublish')}>
                  <EyeOffIcon aria-hidden />
                  {t('unpublish')}
                </Button>
              </>
            )}
            <ButtonLink
              href={`/exams/${exam.id}/tabulation?class=${examClass.id}`}
              variant="outline"
              data-testid={`tabulation-${code}`}
            >
              <TableIcon aria-hidden />
              {t('tabulation')}
            </ButtonLink>
          </div>
          {sections.length > 0 && (
            <ul className="flex flex-col gap-2 border-t pt-3">
              {sections.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-24 font-medium">{s.name}</span>
                  {c.isPublished && (
                    <ButtonLink
                      href={`/exams/${exam.id}/report-cards?section=${s.id}`}
                      variant="ghost"
                      size="sm"
                      data-testid={`report-cards-${code}-${s.name}`}
                    >
                      <FileTextIcon aria-hidden />
                      {t('reportCards')}
                    </ButtonLink>
                  )}
                  <ButtonLink
                    href={`/exams/${exam.id}/remarks?section=${s.id}`}
                    variant="ghost"
                    size="sm"
                  >
                    <MessageSquareTextIcon aria-hidden />
                    {t('remarks')}
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {dialog === 'publish' && c && (
        <ExamDialog
          onClose={() => setDialog(null)}
          title={c.isPublished ? t('republishTitle') : t('publishTitle')}
          description={t('publishBody', { count: formatCount(c.students, locale) })}
          submitLabel={c.isPublished ? t('republish') : t('publish')}
          pending={publish.isPending}
          onSubmit={() => publish.mutate(c.publishedVersion)}
          submitTestId="publish-confirm"
        />
      )}
      {dialog === 'unpublish' && (
        <UnpublishDialog exam={exam} examClassId={examClass.id} onClose={() => setDialog(null)} />
      )}
      {dialog === 'sms' && (
        <SmsDialog exam={exam} examClassId={examClass.id} onClose={() => setDialog(null)} />
      )}
    </SectionCard>
  );
}

/** The class's sections that sit the exam (from the roster). */
function useSections(examId: string, classLevelId: string) {
  const { data } = useExamQuery<{ section: { id: string; name: string }; classLevelId: string }[]>(
    `/exams/${examId}/candidates`,
  );
  const seen = new Map<string, { id: string; name: string }>();
  for (const c of data ?? [])
    if (c.classLevelId === classLevelId) seen.set(c.section.id, c.section);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function UnpublishDialog({
  exam,
  examClassId,
  onClose,
}: {
  exam: ExamDetail;
  examClassId: string;
  onClose: () => void;
}) {
  const t = useTranslations('exams.results');
  const { client } = useAuth();
  const [reason, setReason] = useState('');
  const run = useExamMutation(
    () =>
      client.api(`/exams/${exam.id}/classes/${examClassId}/unpublish`, {
        method: 'POST',
        json: { reason },
      }),
    { success: t('unpublishedToast'), onSuccess: onClose },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={t('unpublishTitle')}
      description={t('unpublishBody')}
      submitLabel={t('unpublish')}
      destructive
      pending={run.isPending || reason.trim().length < 3}
      onSubmit={() => run.mutate(undefined)}
    >
      <TextField
        id="unpublish-reason"
        label={t('reason')}
        value={reason}
        onChange={setReason}
        required
      />
    </ExamDialog>
  );
}

function SmsDialog({
  exam,
  examClassId,
  onClose,
}: {
  exam: ExamDetail;
  examClassId: string;
  onClose: () => void;
}) {
  const t = useTranslations('exams.results');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [p, setP] = useState<ResultSmsPreview | null>(null);
  const load = useExamMutation(
    () =>
      client.api<ResultSmsPreview>(`/exams/${exam.id}/classes/${examClassId}/sms/preview`, {
        method: 'POST',
      }),
    { onSuccess: setP },
  );
  const send = useExamMutation(
    () =>
      client.api<ResultSmsRun>(`/exams/${exam.id}/classes/${examClassId}/sms`, {
        method: 'POST',
        json: { expectedRecipients: p?.toSend ?? 0 },
      }),
    {
      success: (r) => t('smsQueued', { count: formatCount(r.queued, locale) }),
      onSuccess: onClose,
    },
  );
  // The preview is a POST (it counts today's cap): run it once when the dialog opens.
  const { mutate: loadPreview } = load;
  useEffect(() => loadPreview(undefined), [loadPreview]);
  return (
    <ExamDialog
      onClose={onClose}
      title={t('smsTitle')}
      description={t('smsHint')}
      submitLabel={t('smsSend', { count: formatCount(p?.toSend ?? 0, locale) })}
      pending={!p || p.toSend === 0 || send.isPending}
      onSubmit={() => send.mutate(undefined)}
      testId="sms-dialog"
      submitTestId="sms-confirm"
    >
      {!p ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : (
        <dl
          className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm"
          data-testid="sms-preview"
        >
          <dt>{t('smsStudents')}</dt>
          <dd className="font-numeric text-end">{formatCount(p.students, locale)}</dd>
          <dt>{t('smsWithoutPhone')}</dt>
          <dd className="font-numeric text-end">{formatCount(p.withoutPhone, locale)}</dd>
          <dt>{t('smsAlreadySent')}</dt>
          <dd className="font-numeric text-end">{formatCount(p.alreadySent, locale)}</dd>
          <dt className="font-medium">{t('smsToSend')}</dt>
          <dd className="font-numeric text-end font-medium">{formatCount(p.toSend, locale)}</dd>
          <dt>{t('smsCost', { segments: formatCount(p.segments, locale) })}</dt>
          <dd className="font-numeric text-end" data-testid="sms-cost">
            {formatTaka(p.costPaisa, locale)}
          </dd>
          <dt>{t('smsCapLeft')}</dt>
          <dd className="font-numeric text-end">{formatCount(p.capLeftToday, locale)}</dd>
          {p.wouldBeSkipped > 0 && (
            <dd className="text-warning col-span-2">
              {t('smsSkipped', { count: formatCount(p.wouldBeSkipped, locale) })}
            </dd>
          )}
          {p.sampleText && (
            <dd className="bg-muted col-span-2 mt-2 rounded-md p-2" lang="bn">
              {p.sampleText}
            </dd>
          )}
        </dl>
      )}
    </ExamDialog>
  );
}
