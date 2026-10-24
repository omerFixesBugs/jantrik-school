'use client';

import {
  formatCount,
  type ExamDetail,
  type ExamSheetsGrid,
  type LockAllResult,
  type MySheet,
} from '@jantrik/shared';
import { ChevronRightIcon, LockIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { SectionCard } from '@/components/form-kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery, useExamRoles } from '@/lib/exams/api';
import { LoadError, SheetStatusPill, useName } from './kit';

const sheetHref = (examId: string, examSubjectId: string, sectionId: string) =>
  `/exams/${examId}/sheet?subject=${examSubjectId}&section=${sectionId}`;

/** Every sheet of the exam, class by class (admins), or the teacher's own sheets in it. */
export function SheetsGrid({ exam }: { exam: ExamDetail }) {
  const { isAdmin } = useExamRoles();
  if (exam.status === 'SETUP') return <SetupNotice />;
  return isAdmin ? <AdminGrid exam={exam} /> : <TeacherSheets exam={exam} />;
}

function SetupNotice() {
  const t = useTranslations('exams.detail');
  return (
    <SectionCard id="exam-setup-notice" title={t('setupNoticeTitle')}>
      <p className="text-muted-foreground">{t('setupNoticeText')}</p>
    </SectionCard>
  );
}

function TeacherSheets({ exam }: { exam: ExamDetail }) {
  const t = useTranslations('exams.detail');
  const locale = useLocale() as Locale;
  const name = useName();
  const { data, isLoading, error, refetch } = useExamQuery<MySheet[]>('/exams/my-sheets');
  const mine = (data ?? []).filter((s) => s.exam.id === exam.id);
  if (isLoading) return <Skeleton className="h-40 rounded-card" />;
  if (error) return <LoadError error={error} onRetry={() => void refetch()} />;
  return (
    <SectionCard id="exam-my-sheets" title={t('mySheets')}>
      {mine.length === 0 ? (
        <p className="text-muted-foreground">{t('noSheets')}</p>
      ) : (
        <ul className="divide-y">
          {mine.map((s) => (
            <li key={`${s.examSubjectId}:${s.section.id}`}>
              <Link
                href={sheetHref(exam.id, s.examSubjectId, s.section.id)}
                className="hover:bg-muted flex min-h-14 items-center gap-3 rounded-lg px-2"
              >
                <span className="min-w-0 flex-1 font-medium">
                  {name(s.subject)} · {name(s.section.classLevel)} {s.section.name}
                  <span className="text-muted-foreground block text-sm font-normal">
                    {t('entered', {
                      done: formatCount(s.entered, locale),
                      total: formatCount(s.total, locale),
                    })}
                  </span>
                </span>
                <SheetStatusPill status={s.status} />
                <ChevronRightIcon aria-hidden className="size-4 rtl:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AdminGrid({ exam }: { exam: ExamDetail }) {
  const t = useTranslations('exams.detail');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const { data, isLoading, error, refetch } = useExamQuery<ExamSheetsGrid>(
    `/exams/${exam.id}/sheets`,
  );
  const lockAll = useExamMutation(
    (examClassId: string) =>
      client.api<LockAllResult>(`/exams/${exam.id}/classes/${examClassId}/lock-all`, {
        method: 'POST',
      }),
    {
      success: (r) =>
        t('lockedAll', {
          count: formatCount(r.locked, locale),
          left: formatCount(r.notSubmitted, locale),
        }),
    },
  );
  if (isLoading) return <Skeleton className="h-64 rounded-card" />;
  if (error || !data) return <LoadError error={error} onRetry={() => void refetch()} />;
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="sheets-grid">
      {data.classes.map((c) => {
        const cells = c.cells.filter((x) => x.total > 0);
        const locked = cells.filter((x) => x.status === 'LOCKED').length;
        const submitted = cells.filter((x) => x.status === 'SUBMITTED').length;
        return (
          <SectionCard
            key={c.examClassId}
            id={`grid-${c.classLevel.code}`}
            title={name(c.classLevel)}
            hint={t('gridHint', {
              locked: formatCount(locked, locale),
              submitted: formatCount(submitted, locale),
              total: formatCount(cells.length, locale),
            })}
            actions={
              exam.status === 'OPEN' && (
                <Button
                  variant="outline"
                  disabled={submitted === 0 || lockAll.isPending}
                  onClick={() => lockAll.mutate(c.examClassId)}
                  data-testid={`lock-all-${c.classLevel.code}`}
                >
                  <LockIcon aria-hidden />
                  {t('lockAll', { count: formatCount(submitted, locale) })}
                </Button>
              )
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-start">
                    <th scope="col" className="py-2 pe-3 text-start font-medium">
                      {t('subject')}
                    </th>
                    {c.sections.map((s) => (
                      <th key={s.id} scope="col" className="px-2 py-2 text-start font-medium">
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.subjects.map((sub) => (
                    <tr key={sub.examSubjectId} className="border-b last:border-b-0">
                      <th scope="row" className="py-2 pe-3 text-start font-medium">
                        {name(sub.subject)}
                      </th>
                      {c.sections.map((s) => {
                        const cell = c.cells.find(
                          (x) => x.examSubjectId === sub.examSubjectId && x.sectionId === s.id,
                        );
                        if (!cell || cell.total === 0) {
                          return (
                            <td key={s.id} className="text-muted-foreground px-2 py-2">
                              —
                            </td>
                          );
                        }
                        return (
                          <td key={s.id} className="px-2 py-1.5">
                            <Link
                              href={sheetHref(exam.id, sub.examSubjectId, s.id)}
                              className="hover:bg-muted focus-visible:ring-ring inline-flex min-h-10 flex-col items-start gap-0.5 rounded-md px-2 py-1 outline-none focus-visible:ring-3"
                              data-testid="grid-cell"
                              aria-label={t('cellLabel', {
                                subject: name(sub.subject),
                                section: s.name,
                                done: formatCount(cell.entered, locale),
                                total: formatCount(cell.total, locale),
                              })}
                            >
                              <SheetStatusPill status={cell.status} />
                              <span className="font-numeric text-muted-foreground text-xs">
                                {formatCount(cell.entered, locale)}/
                                {formatCount(cell.total, locale)}
                                {cell.teachers.length > 0 &&
                                  ` · ${cell.teachers.map((x) => x.nameBn ?? x.name).join(', ')}`}
                              </span>
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}
