'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADMISSION_APPLICATION_STATUSES,
  formatBdPhone,
  formatCount,
  formatDate,
  formatIdentifier,
  type AdmissionApplicationsPage,
  type AdmissionBulkApproveStatus,
  type AdmissionSectionOption,
} from '@jantrik/shared';
import { DownloadIcon, PencilLineIcon, UsersRoundIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { APPLICATION_TONE, errorCode, useCycles } from '@/components/admission/admission-kit';
import { SelectField, TextField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { FormDialog } from '@/components/setup/setup-kit';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** Applications (OWNER/ADMIN): filter, search, download, open one, approve a class in bulk. */
export default function ApplicationsPage() {
  return (
    <PageGate page="admission">
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <Applications />
      </Suspense>
    </PageGate>
  );
}

function Applications() {
  const t = useTranslations('admissions.staff');
  const tl = useTranslations('admissions.staff.list');
  const locale = useLocale() as Locale;
  const search = useSearchParams();
  const { client, session } = useAuth();
  const cycles = useCycles();
  const [cycleId, setCycleId] = useState(search.get('cycleId') ?? '');
  const [cycleClassId, setCycleClassId] = useState(search.get('cycleClassId') ?? '');
  const [status, setStatus] = useState(search.get('status') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvError, setCsvError] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (cycleId) params.set('cycleId', cycleId);
  if (cycleClassId) params.set('cycleClassId', cycleClassId);
  if (status) params.set('status', status);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({
    queryKey: ['admission-applications', session?.tenant?.id, params.toString()],
    queryFn: () => client.api<AdmissionApplicationsPage>(`/admission/applications?${params}`),
    placeholderData: (prev) => prev,
  });
  const cycle = cycles.data?.find((c) => c.id === cycleId);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  async function downloadCsv() {
    setCsvError(false);
    try {
      const p = new URLSearchParams(params);
      p.delete('page');
      p.delete('pageSize');
      p.set('locale', locale);
      const blob = await client.download(`/admission/applications.csv?${p}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'admission-applications.csv';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setCsvError(true);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          id="filter-cycle"
          label={t('title')}
          value={cycleId}
          onChange={(v) => {
            setCycleId(v);
            setCycleClassId('');
            setPage(1);
          }}
          placeholder={tl('allCycles')}
          options={(cycles.data ?? []).map((c) => ({
            value: c.id,
            label: displayName(c.nameBn, c.nameEn, locale),
          }))}
          className="min-w-48"
        />
        {cycle && (
          <SelectField
            id="filter-class"
            label={t('cycle.classLevel')}
            value={cycleClassId}
            onChange={(v) => {
              setCycleClassId(v);
              setPage(1);
            }}
            placeholder="—"
            options={cycle.classes.map((c) => ({
              value: c.id,
              label: `${displayName(c.classLevel.nameBn, c.classLevel.nameEn, locale)}${
                c.studyGroup
                  ? ` · ${displayName(c.studyGroup.nameBn, c.studyGroup.nameEn, locale)}`
                  : ''
              }`,
            }))}
          />
        )}
        <SelectField
          id="filter-status"
          label={tl('allStatuses')}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          placeholder={tl('allStatuses')}
          options={ADMISSION_APPLICATION_STATUSES.map((s) => ({
            value: s,
            label: t(`appStatus.${s}`),
          }))}
        />
        <TextField
          id="filter-q"
          label={tl('search')}
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          type="search"
          className="min-w-56 flex-1"
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void downloadCsv()}>
            <DownloadIcon aria-hidden />
            {tl('csv')}
          </Button>
          <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="bulk-open">
            <UsersRoundIcon aria-hidden />
            {tl('bulk')}
          </Button>
          <ButtonLink href="/admission/applications/new">
            <PencilLineIcon aria-hidden />
            {t('enterApplication')}
          </ButtonLink>
        </div>
      </div>
      {csvError && <p className="text-destructive text-sm">{tl('csvFailed')}</p>}

      {list.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (list.data?.items ?? []).length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border p-6 text-center">
          {tl('empty')}
        </p>
      ) : (
        <ul className="bg-card divide-y rounded-xl border" data-testid="application-list">
          {list.data!.items.map((a) => (
            <li key={a.id}>
              <a
                href={`/admission/applications/${a.id}`}
                className="hover:bg-accent/40 grid gap-1 px-4 py-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-center sm:gap-3"
              >
                <span className="font-mono text-sm">{formatIdentifier(a.applicationNo)}</span>
                <span className="min-w-0">
                  <span className="block font-medium break-words">
                    {displayName(a.nameBn, a.nameEn, locale)}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {displayName(
                      a.cycleClass.classLevel.nameBn,
                      a.cycleClass.classLevel.nameEn,
                      locale,
                    )}
                    {a.cycleClass.studyGroup &&
                      ` · ${displayName(a.cycleClass.studyGroup.nameBn, a.cycleClass.studyGroup.nameEn, locale)}`}
                  </span>
                </span>
                <span className="text-muted-foreground min-w-0 text-sm">
                  {displayName(a.guardianNameBn, a.guardianNameEn, locale)} ·{' '}
                  <span className="font-mono">{formatBdPhone(a.phone)}</span>
                  <span className="block">
                    {t(`source.${a.source}`)} · {formatDate(a.submittedAt, locale)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {a.approvalProblem && <Pill tone="warning">{tl('problem')}</Pill>}
                  <Pill tone={APPLICATION_TONE[a.status]}>{t(`appStatus.${a.status}`)}</Pill>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {list.data && pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {tl('prev')}
          </Button>
          <span className="text-muted-foreground text-sm">
            {tl('page', { page: formatCount(page, locale), pages: formatCount(pages, locale) })}
          </span>
          <Button variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {tl('next')}
          </Button>
        </div>
      )}

      {bulkOpen && (
        <BulkApprove
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          initialCycleId={cycleId}
          initialClassId={cycleClassId}
        />
      )}
    </div>
  );
}

function BulkApprove({
  open,
  onOpenChange,
  initialCycleId,
  initialClassId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCycleId: string;
  initialClassId: string;
}) {
  const t = useTranslations('admissions.staff');
  const tl = useTranslations('admissions.staff.list');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const cycles = useCycles();
  const [cycleId, setCycleId] = useState(initialCycleId || cycles.data?.[0]?.id || '');
  const [classId, setClassId] = useState(initialClassId);
  const [sectionId, setSectionId] = useState('');
  const [started, setStarted] = useState(false);
  const cycle = cycles.data?.find((c) => c.id === cycleId);
  const sections = useQuery({
    queryKey: ['admission-sections', session?.tenant?.id, classId],
    queryFn: () =>
      client.api<AdmissionSectionOption[]>(`/admission/cycle-classes/${classId}/sections`),
    enabled: Boolean(classId),
  });
  const status = useQuery({
    queryKey: ['admission-bulk', session?.tenant?.id, classId],
    queryFn: () =>
      client.api<AdmissionBulkApproveStatus>(`/admission/cycle-classes/${classId}/bulk-approve`),
    enabled: started && Boolean(classId),
    refetchInterval: (query) => (query.state.data?.running === false ? false : 1_000),
  });
  const start = useMutation({
    mutationFn: () =>
      client.api<AdmissionBulkApproveStatus>(`/admission/cycle-classes/${classId}/bulk-approve`, {
        method: 'POST',
        json: { sectionId },
      }),
    onSuccess: () => {
      setStarted(true);
      void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
    },
    onError: (e) => toast.error(errorCode(e) === 'BULK_RUNNING' ? tl('bulkBusy') : describe(e)),
  });
  const st = status.data;
  const finished = st !== undefined && !st.running;
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
  }, [finished, queryClient]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tl('bulkTitle')}
      description={tl('bulkHint')}
      submitLabel={tl('bulkStart')}
      pending={start.isPending || Boolean(st?.running)}
      onSubmit={() => {
        if (classId && sectionId) start.mutate();
      }}
      testId="bulk-dialog"
    >
      <SelectField
        id="bulk-cycle"
        label={t('title')}
        value={cycleId}
        onChange={(v) => {
          setCycleId(v);
          setClassId('');
          setSectionId('');
        }}
        options={(cycles.data ?? []).map((c) => ({
          value: c.id,
          label: displayName(c.nameBn, c.nameEn, locale),
        }))}
      />
      <SelectField
        id="bulk-class"
        label={tl('bulkClass')}
        value={classId}
        onChange={(v) => {
          setClassId(v);
          setSectionId('');
        }}
        placeholder="—"
        options={(cycle?.classes ?? []).map((c) => ({
          value: c.id,
          label: `${displayName(c.classLevel.nameBn, c.classLevel.nameEn, locale)}${
            c.studyGroup
              ? ` · ${displayName(c.studyGroup.nameBn, c.studyGroup.nameEn, locale)}`
              : ''
          }`,
        }))}
        required
      />
      <SelectField
        id="bulk-section"
        label={tl('bulkSection')}
        value={sectionId}
        onChange={setSectionId}
        placeholder="—"
        options={(sections.data ?? []).map((s) => ({
          value: s.id,
          label:
            s.capacity !== null
              ? `${s.name} (${formatCount(s.enrolled, locale)}/${formatCount(s.capacity, locale)})`
              : s.name,
        }))}
        required
      />
      {st && (
        <div className="flex flex-col gap-2 text-sm" role="status" data-testid="bulk-status">
          <p>
            {st.running
              ? tl('bulkRunning', { admitted: formatCount(st.admitted, locale) })
              : tl('bulkDone', {
                  admitted: formatCount(st.admitted, locale),
                  problems: st.problems.length,
                })}
          </p>
          {!st.running && st.problems.length > 0 && (
            <ul className="flex flex-col gap-1">
              {st.problems.map((p) => (
                <li key={p.applicationId}>
                  <a className="underline" href={`/admission/applications/${p.applicationId}`}>
                    {formatIdentifier(p.applicationNo)}
                  </a>{' '}
                  — {t(`problem.${p.code}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FormDialog>
  );
}
