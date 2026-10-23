'use client';

import type { ExamDetail } from '@jantrik/shared';
import { ArchiveIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamRoles } from '@/lib/exams/api';
import { ExamDialog, ExamStatusPill, useExamLine, useName } from './kit';

/** The exam's name, kind, dates and state; admins open, archive, reopen or delete it here. */
export function ExamHeader({ exam }: { exam: ExamDetail }) {
  const t = useTranslations('exams.detail');
  const tMode = useTranslations('exams.common.mode');
  const name = useName();
  const line = useExamLine();
  const { client } = useAuth();
  const router = useRouter();
  const { isAdmin } = useExamRoles();
  const [confirm, setConfirm] = useState<'open' | 'archive' | 'reopen' | 'delete' | null>(null);
  const act = useExamMutation(
    (what: 'open' | 'archive' | 'reopen' | 'delete') =>
      what === 'delete'
        ? client.api(`/exams/${exam.id}`, { method: 'DELETE' })
        : client.api(`/exams/${exam.id}/${what}`, { method: 'POST' }),
    {
      success: (_out) => t('done'),
      onSuccess: (_out, what) => {
        setConfirm(null);
        if (what === 'delete') router.push('/exams');
      },
    },
  );
  return (
    <header className="flex flex-wrap items-start gap-3" data-testid="exam-header">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{name(exam)}</h2>
          <ExamStatusPill status={exam.status} />
        </div>
        <p className="text-muted-foreground text-sm">
          {line(exam)} · {tMode(exam.resultMode)}
        </p>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap gap-2 print:hidden">
          {exam.status === 'SETUP' && (
            <>
              <Button onClick={() => setConfirm('open')} data-testid="exam-open">
                <PlayIcon aria-hidden />
                {t('open')}
              </Button>
              <Button variant="outline" onClick={() => setConfirm('delete')}>
                <Trash2Icon aria-hidden />
                {t('delete')}
              </Button>
            </>
          )}
          {exam.status === 'OPEN' && (
            <Button variant="outline" onClick={() => setConfirm('archive')}>
              <ArchiveIcon aria-hidden />
              {t('archive')}
            </Button>
          )}
          {exam.status === 'ARCHIVED' && (
            <Button variant="outline" onClick={() => setConfirm('reopen')}>
              <RotateCcwIcon aria-hidden />
              {t('reopen')}
            </Button>
          )}
        </div>
      )}
      {confirm && (
        <ExamDialog
          onClose={() => setConfirm(null)}
          title={t(`confirm.${confirm}Title`)}
          description={t(`confirm.${confirm}Body`)}
          submitLabel={t(`confirm.${confirm}Yes`)}
          pending={act.isPending}
          destructive={confirm === 'delete'}
          onSubmit={() => act.mutate(confirm)}
          submitTestId="exam-confirm"
        />
      )}
    </header>
  );
}
