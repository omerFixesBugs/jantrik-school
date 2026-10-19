'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IMPORT_FIELDS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  formatCount,
  formatDate,
  type ImportField,
  type ImportPreviewPage,
  type ImportRowError,
  type StudentImportSummary,
} from '@jantrik/shared';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/** Fields a row cannot do without (the mapping screen marks them). */
const REQUIRED: ImportField[] = ['nameBn', 'classLevel', 'guardianPhone'];
type Filter = 'all' | 'ok' | 'error' | 'exists';

export default function ImportPage() {
  return (
    <PageGate page="students">
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <Importer />
      </Suspense>
    </PageGate>
  );
}

function useDownload() {
  const { client } = useAuth();
  const describe = useErrorMessage();
  return async (path: string, filename: string) => {
    try {
      const blob = await client.download(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (e) {
      toast.error(describe(e));
    }
  };
}

function useImportError() {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      const known: Record<string, string> = {
        FILE_TYPE: t('errorFileType'),
        FILE_INVALID: t('errorFileInvalid'),
        FILE_EMPTY: t('errorFileEmpty'),
        NO_DATA_ROWS: t('errorFileEmpty'),
        FILE_TOO_LARGE: t('errorFileTooLarge'),
        TOO_MANY_ROWS: t('errorTooManyRows', { max: formatCount(IMPORT_MAX_ROWS, locale) }),
        NO_CURRENT_YEAR: t('errorNoYear'),
        IMPORT_STARTED: t('errorStarted'),
        NOTHING_TO_IMPORT: t('errorNothing'),
      };
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 413) return t('errorFileTooLarge');
    }
    return describe(e);
  };
}

function Importer() {
  const t = useTranslations('import');
  const params = useSearchParams();
  const router = useRouter();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const id = params.get('id');
  if (context && !isAdmin) {
    return (
      <Alert>
        <AlertDescription>{t('adminOnly')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="import-page">
      <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
      {id ? (
        <ImportView key={id} id={id} onRestart={() => router.push('/students/import')} />
      ) : (
        <>
          <Steps current={1} />
          <TemplateCard />
          <UploadCard onUploaded={(s) => router.push(`/students/import?id=${s.id}`)} />
          <RecentImports />
        </>
      )}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const steps = [t('step1'), t('step2'), t('step3')];
  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label={t('stepsLabel')}>
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i + 1 === current ? 'step' : undefined}
          className={cn(
            'rounded-full border px-3 py-1',
            i + 1 === current
              ? 'border-primary bg-primary-soft font-medium'
              : 'text-muted-foreground',
          )}
        >
          {formatCount(i + 1, locale)}. {s}
        </li>
      ))}
    </ol>
  );
}

function TemplateCard() {
  const t = useTranslations('import');
  const download = useDownload();
  return (
    <SectionCard id="import-template" title={t('templateTitle')} hint={t('templateHint')}>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void download('/student-imports/template.xlsx', 'student-import-template.xlsx')
          }
          data-testid="template-xlsx"
        >
          <FileSpreadsheetIcon aria-hidden />
          {t('templateXlsx')}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void download('/student-imports/template.csv', 'student-import-template.csv')
          }
          data-testid="template-csv"
        >
          <DownloadIcon aria-hidden />
          {t('templateCsv')}
        </Button>
      </div>
      <ul className="text-muted-foreground list-disc pl-5 text-sm">
        <li>{t('rule1')}</li>
        <li>{t('rule2')}</li>
        <li>{t('rule3')}</li>
      </ul>
    </SectionCard>
  );
}

function UploadCard({ onUploaded }: { onUploaded: (s: StudentImportSummary) => void }) {
  const t = useTranslations('import');
  const message = useImportError();
  const { client } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const tooBig = file !== null && file.size > IMPORT_MAX_BYTES;
  const upload = useMutation({
    mutationFn: () => {
      const body = new FormData();
      body.append('file', file!);
      return client.api<StudentImportSummary>('/student-imports', { method: 'POST', body });
    },
    onSuccess: onUploaded,
    onError: (e) => toast.error(message(e)),
  });
  return (
    <SectionCard id="import-upload" title={t('uploadTitle')} hint={t('uploadHint')}>
      <label
        className={cn(
          'bg-canvas hover:border-primary/50 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center',
          'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-3',
        )}
      >
        <UploadIcon aria-hidden className="text-muted-foreground size-6" />
        <span className="font-medium break-all">{file ? file.name : t('chooseFile')}</span>
        <span className="text-muted-foreground text-sm">{t('fileLimits')}</span>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          data-testid="import-file"
        />
      </label>
      {tooBig && (
        <p className="text-destructive text-sm" role="alert">
          {t('errorFileTooLarge')}
        </p>
      )}
      <Button
        className="w-fit"
        disabled={!file || tooBig || upload.isPending}
        onClick={() => upload.mutate()}
        data-testid="import-upload-button"
      >
        <UploadIcon aria-hidden />
        {upload.isPending ? t('uploading') : t('upload')}
      </Button>
    </SectionCard>
  );
}

function RecentImports() {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { client, session } = useAuth();
  const list = useQuery({
    queryKey: ['student-imports', session?.tenant?.id],
    queryFn: () => client.api<StudentImportSummary[]>('/student-imports'),
  });
  if (!list.data || list.data.length === 0) return null;
  return (
    <SectionCard id="import-recent" title={t('recentTitle')}>
      <ul className="flex flex-col divide-y rounded-lg border">
        {list.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium break-all">{i.fileName}</span>
              <span className="text-muted-foreground text-sm">
                {formatDate(new Date(i.createdAt), locale, 'medium')} · {t(`status_${i.status}`)}
                {i.status === 'DONE' &&
                  ` · ${t('importedCount', { count: formatCount(i.counts.imported, locale) })}`}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/students/import?id=${i.id}`)}
            >
              {t('open')}
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function ImportView({ id, onRestart }: { id: string; onRestart: () => void }) {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const message = useImportError();
  const download = useDownload();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['student-import', session?.tenant?.id, id];
  const summary = useQuery({
    queryKey: key,
    queryFn: () => client.api<StudentImportSummary>(`/student-imports/${id}`),
    refetchInterval: (q) =>
      q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1000 : false,
  });
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      client.api<StudentImportSummary>(`/student-imports/${id}/run`, { method: 'POST' }),
    onSuccess: (s) => {
      setConfirm(false);
      queryClient.setQueryData(key, s);
    },
    onError: (e) => toast.error(message(e)),
  });
  const s = summary.data;
  useEffect(() => {
    if (s?.status === 'DONE') {
      for (const k of ['students', 'students-total', 'student-filters', 'setup', 'student-imports'])
        void queryClient.invalidateQueries({ queryKey: [k] });
    }
  }, [s?.status, queryClient]);

  if (summary.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (summary.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(summary.error)}</AlertDescription>
      </Alert>
    );
  const busy = s!.status === 'QUEUED' || s!.status === 'RUNNING';
  const finished = s!.status === 'DONE' || s!.status === 'FAILED';
  const percent = s!.rowCount ? Math.round((s!.processed / s!.rowCount) * 100) : 0;

  return (
    <>
      <Steps current={finished || busy ? 3 : 2} />
      <SectionCard
        id="import-summary"
        title={s!.fileName}
        hint={t('rowsInFile', { count: formatCount(s!.rowCount, locale) })}
        actions={
          <Button variant="ghost" onClick={onRestart}>
            <RefreshCwIcon aria-hidden />
            {t('another')}
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2" data-testid="import-counts">
          {finished ? (
            <>
              <Badge variant="success">
                {t('countImported', { count: formatCount(s!.counts.imported, locale) })}
              </Badge>
              <Badge variant="secondary">
                {t('countSkipped', { count: formatCount(s!.counts.skipped, locale) })}
              </Badge>
              <Badge variant="destructive">
                {t('countError', { count: formatCount(s!.counts.error, locale) })}
              </Badge>
            </>
          ) : (
            <>
              <Badge variant="success">
                {t('countOk', { count: formatCount(s!.counts.ok, locale) })}
              </Badge>
              <Badge variant="secondary">
                {t('countExists', { count: formatCount(s!.counts.exists, locale) })}
              </Badge>
              <Badge variant="destructive">
                {t('countError', { count: formatCount(s!.counts.error, locale) })}
              </Badge>
            </>
          )}
        </div>
        {busy && (
          <div className="flex flex-col gap-1.5" data-testid="import-progress">
            <div
              className="bg-muted h-3 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={t('progress')}
            >
              <div className="bg-primary h-full transition-all" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-muted-foreground text-sm">
              {t('progressText', {
                done: formatCount(s!.processed, locale),
                total: formatCount(s!.rowCount, locale),
              })}
            </span>
          </div>
        )}
        {s!.status === 'DONE' && (
          <Alert>
            <CheckCircle2Icon aria-hidden />
            <AlertDescription data-testid="import-done">{t('doneText')}</AlertDescription>
          </Alert>
        )}
        {s!.status === 'FAILED' && (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden />
            <AlertDescription>
              {s!.failure === 'EXPIRED' ? t('failedExpired') : t('failedText')}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {s!.status === 'VALIDATED' && (
            <Button
              onClick={() => setConfirm(true)}
              disabled={s!.counts.ok === 0}
              data-testid="import-run"
            >
              <UploadIcon aria-hidden />
              {t('run', { count: formatCount(s!.counts.ok, locale) })}
            </Button>
          )}
          {finished && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  void download(
                    `/student-imports/${id}/report.csv?locale=bn`,
                    `import-report-bn.csv`,
                  )
                }
                data-testid="report-bn"
              >
                <DownloadIcon aria-hidden />
                {t('reportBn')}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void download(
                    `/student-imports/${id}/report.csv?locale=en`,
                    `import-report-en.csv`,
                  )
                }
              >
                <DownloadIcon aria-hidden />
                {t('reportEn')}
              </Button>
            </>
          )}
        </div>
      </SectionCard>

      {s!.status === 'VALIDATED' && (
        <MappingCard summary={s!} onSaved={(n) => queryClient.setQueryData(key, n)} />
      )}
      {s!.status !== 'UPLOADED' && <RowsCard id={id} summary={s!} />}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('runTitle', { count: formatCount(s!.counts.ok, locale) })}
        body={t('runBody', {
          exists: formatCount(s!.counts.exists, locale),
          errors: formatCount(s!.counts.error, locale),
        })}
        confirmLabel={t('runConfirm')}
        destructive={false}
        pending={run.isPending}
        onConfirm={() => run.mutate()}
      />
    </>
  );
}

function useFieldLabel() {
  const t = useTranslations('import');
  const label = useLabel();
  return (f: ImportField) => {
    const labelled: Partial<Record<ImportField, string>> = {
      classLevel: label('class_level', 'Class'),
      section: label('section', 'Section'),
      roll: label('roll', 'Roll'),
      studyGroup: label('study_group', 'Group'),
    };
    return labelled[f] ?? t(`field_${f}`);
  };
}

function MappingCard({
  summary,
  onSaved,
}: {
  summary: StudentImportSummary;
  onSaved: (s: StudentImportSummary) => void;
}) {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const fieldLabel = useFieldLabel();
  const message = useImportError();
  const { client } = useAuth();
  const [mapping, setMapping] = useState(summary.mapping);
  const [open, setOpen] = useState(false);
  const changed = IMPORT_FIELDS.some((f) => mapping[f] !== summary.mapping[f]);
  const save = useMutation({
    mutationFn: () =>
      client.api<StudentImportSummary>(`/student-imports/${summary.id}/mapping`, {
        method: 'PUT',
        json: { mapping },
      }),
    onSuccess: (s) => {
      onSaved(s);
      toast.success(t('rechecked'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const used = new Map(Object.entries(mapping).flatMap(([f, c]) => (c === null ? [] : [[c, f]])));
  const missingRequired = REQUIRED.some(
    (f) => mapping[f] === null && !(f === 'nameBn' && mapping.nameEn !== null),
  );
  const matched = IMPORT_FIELDS.filter((f) => mapping[f] !== null).length;
  const showList = open || missingRequired;
  return (
    <SectionCard id="import-mapping" title={t('mappingTitle')} hint={t('mappingHint')}>
      {/* Collapsed while every required column is matched: on a phone the list is long. */}
      <Button
        variant="link"
        className="h-auto w-fit p-0"
        aria-expanded={showList}
        aria-controls="import-mapping-list"
        onClick={() => setOpen((o) => !o)}
        data-testid="mapping-toggle"
      >
        {t('mappingSummary', { count: formatCount(matched, locale) })}
      </Button>
      {showList && (
        <ul
          id="import-mapping-list"
          className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="import-mapping-list"
        >
          {IMPORT_FIELDS.map((f) => {
            const id = `map-${f}`;
            const missing =
              REQUIRED.includes(f) &&
              mapping[f] === null &&
              !(f === 'nameBn' && mapping.nameEn !== null);
            return (
              <li key={f} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={id} className="text-sm font-medium">
                  {fieldLabel(f)}
                  {REQUIRED.includes(f) && <span className="text-destructive"> *</span>}
                </label>
                <select
                  id={id}
                  value={mapping[f] ?? ''}
                  aria-invalid={missing || undefined}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [f]: e.target.value === '' ? null : Number(e.target.value),
                    }))
                  }
                  className="border-input bg-card aria-invalid:border-destructive h-10 w-full min-w-0 rounded-lg border px-3 text-base shadow-xs dark:bg-input/30"
                >
                  <option value="">{t('notInFile')}</option>
                  {summary.headers.map((h, i) => (
                    <option key={i} value={i} disabled={used.has(i) && used.get(i) !== f}>
                      {h || t('columnN', { n: i + 1 })}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        className="w-fit"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => save.mutate()}
        data-testid="import-recheck"
      >
        <RefreshCwIcon aria-hidden />
        {t('recheck')}
      </Button>
    </SectionCard>
  );
}

function RowsCard({ id, summary }: { id: string; summary: StudentImportSummary }) {
  const t = useTranslations('import');
  const locale = useLocale() as Locale;
  const fieldLabel = useFieldLabel();
  const { client, session } = useAuth();
  const [filter, setFilter] = useState<Filter>(summary.counts.error > 0 ? 'error' : 'all');
  const [page, setPage] = useState(0);
  const rows = useQuery({
    queryKey: [
      'student-import-rows',
      session?.tenant?.id,
      id,
      filter,
      page,
      summary.status,
      summary.processed,
      summary.counts,
    ],
    queryFn: () =>
      client.api<ImportPreviewPage>(`/student-imports/${id}/rows?filter=${filter}&page=${page}`),
  });
  const errorText = (e: ImportRowError) =>
    `${fieldLabel(e.field)}: ${t(`err_${e.code}`)}${e.value ? ` (${e.value})` : ''}`;
  const filters: Filter[] = ['all', 'ok', 'error', 'exists'];
  const pages = Math.ceil((rows.data?.total ?? 0) / 50);
  return (
    <SectionCard id="import-rows" title={t('rowsTitle')}>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('rowsTitle')}>
        {filters.map((f) => (
          <Button
            key={f}
            size="sm"
            role="tab"
            aria-selected={filter === f}
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => {
              setFilter(f);
              setPage(0);
            }}
          >
            {t(`filter_${f}`)}
          </Button>
        ))}
      </div>
      {rows.isPending ? (
        <Skeleton className="h-40" />
      ) : rows.data!.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noRows')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid="import-rows-list">
          {rows.data!.rows.map((r) => (
            <li key={r.row} className="flex flex-col gap-1 px-3 py-2.5" data-testid="import-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-sm tabular-nums">
                  {t('rowN', { n: formatCount(r.row, locale) })}
                </span>
                <span className="min-w-0 font-medium break-words">
                  {r.values.nameBn ?? r.values.nameEn ?? r.name ?? '—'}
                </span>
                <Badge
                  variant={
                    r.status === 'ERROR'
                      ? 'destructive'
                      : r.status === 'OK' || r.status === 'IMPORTED'
                        ? 'success'
                        : 'secondary'
                  }
                >
                  {t(`row_${r.status}`)}
                </Badge>
                {r.studentCode && (
                  <span
                    className="text-muted-foreground inline-flex items-center gap-1 text-sm tabular-nums"
                    dir="ltr"
                  >
                    <CopyIcon aria-hidden className="size-3" />
                    {r.studentCode}
                  </span>
                )}
              </div>
              {r.errors.length > 0 && (
                <ul className="text-destructive list-disc pl-5 text-sm">
                  {r.errors.map((e, i) => (
                    <li key={i} className="break-words">
                      {errorText(e)}
                    </li>
                  ))}
                </ul>
              )}
              {r.notes && r.notes.length > 0 && (
                <ul
                  className="text-muted-foreground list-disc pl-5 text-sm"
                  data-testid="import-row-notes"
                >
                  {r.notes.map((n, i) => (
                    <li
                      key={i}
                      className={cn(
                        'break-words',
                        n.code === 'GUARDIAN_LINKED_BY_PHONE_ONLY' && 'text-foreground font-medium',
                      )}
                    >
                      {t('noteGuardian', { n: formatCount(n.guardian, locale) })}:{' '}
                      {t(`note_${n.code}`)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t('prev')}
          </Button>
          <span className="text-sm">
            {t('pageOf', {
              page: formatCount(page + 1, locale),
              pages: formatCount(pages, locale),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('next')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
