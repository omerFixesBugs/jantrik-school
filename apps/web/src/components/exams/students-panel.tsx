'use client';

import {
  formatCount,
  type CandidateSyncResult,
  type ExamCandidateView,
  type ExamDetail,
  type ExamRoomView,
  type SeatPlan,
} from '@jantrik/shared';
import { ArmchairIcon, PrinterIcon, RefreshCwIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard } from '@/components/form-kit';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';
import { ExamDialog, LoadError, useName } from './kit';

/** The exam's roster by section (sync with enrolments), seats, admit cards and the seat plan. */
export function StudentsPanel({ exam }: { exam: ExamDetail }) {
  const t = useTranslations('exams.students');
  const locale = useLocale() as Locale;
  const name = useName();
  const candidates = useExamQuery<ExamCandidateView[]>(
    exam.status === 'SETUP' ? null : `/exams/${exam.id}/candidates`,
  );
  const [syncing, setSyncing] = useState(false);
  const [seating, setSeating] = useState(false);
  if (exam.status === 'SETUP') {
    return (
      <SectionCard id="exam-students" title={t('title')}>
        <p className="text-muted-foreground">{t('notOpen')}</p>
      </SectionCard>
    );
  }
  if (candidates.isLoading) return <Skeleton className="h-48 rounded-card" />;
  if (candidates.error)
    return <LoadError error={candidates.error} onRetry={() => void candidates.refetch()} />;
  const list = candidates.data ?? [];
  const sections = new Map<
    string,
    {
      id: string;
      name: string;
      classLevelId: string;
      enrolled: number;
      withdrawn: number;
      seated: number;
    }
  >();
  for (const c of list) {
    const s = sections.get(c.section.id) ?? {
      ...c.section,
      classLevelId: c.classLevelId,
      enrolled: 0,
      withdrawn: 0,
      seated: 0,
    };
    if (c.status === 'ENROLLED') s.enrolled++;
    else s.withdrawn++;
    if (c.seat) s.seated++;
    sections.set(c.section.id, s);
  }
  const className = (id: string) =>
    name(
      exam.classes.find((c) => c.classLevel.id === id)?.classLevel ?? { nameBn: '', nameEn: '' },
    );
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="exam-students">
      <SectionCard
        id="exam-roster"
        title={t('title')}
        hint={t('hint')}
        actions={
          exam.status === 'OPEN' && (
            <Button variant="outline" onClick={() => setSyncing(true)} data-testid="roster-sync">
              <RefreshCwIcon aria-hidden />
              {t('sync')}
            </Button>
          )
        }
      >
        <ul className="divide-y">
          {[...sections.values()].map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {className(s.classLevelId)} {s.name}
                </span>
                <span className="text-muted-foreground block text-sm">
                  {t('counts', {
                    enrolled: formatCount(s.enrolled, locale),
                    seated: formatCount(s.seated, locale),
                    withdrawn: formatCount(s.withdrawn, locale),
                  })}
                </span>
              </span>
              <ButtonLink
                href={`/exams/${exam.id}/admit-cards?section=${s.id}`}
                variant="outline"
                size="sm"
              >
                <PrinterIcon aria-hidden />
                {t('admitCards')}
              </ButtonLink>
            </li>
          ))}
        </ul>
      </SectionCard>
      <SectionCard
        id="exam-seats"
        title={t('seats')}
        hint={t('seatsHint')}
        actions={
          <>
            <ButtonLink href={`/exams/${exam.id}/seats`} variant="outline">
              <PrinterIcon aria-hidden />
              {t('seatPlan')}
            </ButtonLink>
            {exam.status === 'OPEN' && (
              <Button onClick={() => setSeating(true)} data-testid="seats-allocate">
                <ArmchairIcon aria-hidden />
                {t('allocate')}
              </Button>
            )}
          </>
        }
      >
        <p className="text-muted-foreground text-sm">
          {t('seated', {
            seated: formatCount(list.filter((c) => c.seat).length, locale),
            total: formatCount(list.filter((c) => c.status === 'ENROLLED').length, locale),
          })}
        </p>
      </SectionCard>
      {syncing && <SyncDialog exam={exam} onClose={() => setSyncing(false)} />}
      {seating && <SeatsDialog exam={exam} onClose={() => setSeating(false)} />}
    </div>
  );
}

function SyncDialog({ exam, onClose }: { exam: ExamDetail; onClose: () => void }) {
  const t = useTranslations('exams.students');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [result, setResult] = useState<CandidateSyncResult | null>(null);
  const run = useExamMutation(
    (dryRun: boolean) =>
      client.api<CandidateSyncResult>(`/exams/${exam.id}/candidates/sync`, {
        method: 'POST',
        json: { dryRun },
      }),
    {
      success: (r) => (r.dryRun ? '' : t('synced')),
      onSuccess: (r) => (r.dryRun ? setResult(r) : onClose()),
    },
  );
  const changes = result ? result.added.length + result.withdrawn.length + result.moved.length : 0;
  return (
    <ExamDialog
      onClose={onClose}
      title={t('syncTitle')}
      description={t('syncHint')}
      submitLabel={result ? t('syncApply') : t('syncPreview')}
      pending={run.isPending || (result !== null && changes === 0)}
      onSubmit={() => run.mutate(result === null)}
      testId="roster-sync-dialog"
      submitTestId="roster-sync-submit"
    >
      {result && (
        <div className="flex flex-col gap-2 text-sm" data-testid="roster-sync-preview">
          {changes === 0 ? (
            <p>{t('syncNothing')}</p>
          ) : (
            <>
              <p>{t('syncAdded', { count: formatCount(result.added.length, locale) })}</p>
              <p>{t('syncWithdrawn', { count: formatCount(result.withdrawn.length, locale) })}</p>
              <p>{t('syncMoved', { count: formatCount(result.moved.length, locale) })}</p>
              <ul className="text-muted-foreground list-disc ps-5">
                {[
                  ...result.added.map((a) => `+ ${a.name} (${a.sectionName})`),
                  ...result.withdrawn.map((w) => `− ${w.name}`),
                  ...result.moved.map((m) => `${m.name}: ${m.from} → ${m.to}`),
                ].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </ExamDialog>
  );
}

function SeatsDialog({ exam, onClose }: { exam: ExamDetail; onClose: () => void }) {
  const t = useTranslations('exams.students');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const rooms = useExamQuery<ExamRoomView[]>('/exams/rooms');
  const [picked, setPicked] = useState<string[]>([]);
  const allocate = useExamMutation(
    () =>
      client.api<SeatPlan>(`/exams/${exam.id}/seats`, {
        method: 'POST',
        json: { roomIds: picked },
      }),
    { success: t('allocated'), onSuccess: onClose },
  );
  const capacity = (rooms.data ?? [])
    .filter((r) => picked.includes(r.id))
    .reduce((n, r) => n + r.capacity, 0);
  return (
    <ExamDialog
      onClose={onClose}
      title={t('allocateTitle')}
      description={t('allocateHint')}
      submitLabel={t('allocate')}
      pending={allocate.isPending || picked.length === 0}
      onSubmit={() => allocate.mutate(undefined)}
      testId="seats-dialog"
    >
      {rooms.data && rooms.data.filter((r) => r.isActive).length === 0 ? (
        <p className="text-muted-foreground">{t('noRooms')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {(rooms.data ?? [])
            .filter((r) => r.isActive)
            .map((r) => (
              <li key={r.id}>
                <label className="hover:bg-muted flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-md px-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={picked.includes(r.id)}
                    onChange={(e) =>
                      setPicked(
                        e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id),
                      )
                    }
                  />
                  <span className="flex-1">{r.name}</span>
                  <span className="font-numeric text-muted-foreground text-sm">
                    {formatCount(r.capacity, locale)}
                  </span>
                </label>
              </li>
            ))}
        </ul>
      )}
      <p className="text-sm">{t('capacity', { count: formatCount(capacity, locale) })}</p>
    </ExamDialog>
  );
}
