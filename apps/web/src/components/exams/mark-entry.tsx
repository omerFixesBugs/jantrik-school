'use client';

import {
  formatCount,
  formatIdentifier,
  formatMarks,
  formatTime,
  subjectResult,
  type MarkEntry,
  type MarkSheetView,
  type ParsedMarks,
} from '@jantrik/shared';
import {
  CloudCheckIcon,
  CloudOffIcon,
  LoaderCircleIcon,
  LockIcon,
  SendIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pill } from '@/components/kit/pill';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useExamError } from '@/lib/exams/api';
import { cellKey, type SheetSync } from '@/lib/exams/sheet-controller';
import { useMarkSheet } from '@/lib/exams/use-sheet';
import { useCountdown } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/** Wide screens show every part side by side; phones one part at a time (fast, one column). */
function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return wide;
}

/**
 * Entering one subject's marks for one section (docs/exams.md): a row per student with a large
 * numeric field per part (Bangla or ASCII digits, `অ`/`a` for absent), Enter moves to the next
 * student. Every keystroke is kept on the phone; a pause saves the draft to the server; Submit
 * needs every cell. The status line always says where the marks are.
 */
export function MarkEntry({
  examSubjectId,
  sectionId,
}: {
  examSubjectId: string;
  sectionId: string;
}) {
  const t = useTranslations('exams.marks');
  const locale = useLocale() as Locale;
  const describe = useExamError();
  const { view, draft, sync, controller } = useMarkSheet(examSubjectId, sectionId);
  const wide = useWide();
  const [part, setPart] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const components = view?.examSubject.components ?? [];
  const current = part ?? components[0]?.key ?? null;
  const shown = wide ? components : components.filter((c) => c.key === current);
  const editable = !!view && (view.mode === 'TEACHER' || view.mode === 'ADMIN');

  const entered = useMemo(() => {
    if (!draft || !view) return 0;
    return draft.roster.filter((st) =>
      view.examSubject.components.every((c) => controller.parsed(st.id, c.key).kind !== 'blank'),
    ).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, view]);

  if (sync.kind === 'loading' || (!view && !draft)) {
    if (sync.kind === 'unavailable') {
      return (
        <Alert variant="destructive" data-testid="sheet-unavailable">
          <AlertDescription>{describe(sync.error)}</AlertDescription>
        </Alert>
      );
    }
    return <Skeleton className="h-96 rounded-xl" />;
  }
  if (!view || !draft) {
    return (
      <Alert data-testid="sheet-offline">
        <CloudOffIcon aria-hidden />
        <AlertDescription>{t('offlineDraft')}</AlertDescription>
      </Alert>
    );
  }

  const focusNext = (from: string) => {
    // Down the column first (same part, next student), then the next part from the top.
    const [studentId, key] = from.split(':') as [string, string];
    const rows = draft.roster.map((s) => s.id);
    const i = rows.indexOf(studentId);
    const keys = shown.map((c) => c.key);
    const k = keys.indexOf(key);
    const next =
      i + 1 < rows.length
        ? cellKey(rows[i + 1]!, key)
        : k + 1 < keys.length
          ? cellKey(rows[0]!, keys[k + 1]!)
          : null;
    if (next) inputs.current.get(next)?.focus();
    else (document.querySelector('[data-testid="sheet-submit"]') as HTMLElement | null)?.focus();
  };

  const blank = controller.blankCount();
  const invalid = controller.invalidCount();
  const status = view.sheet.status;

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="mark-entry">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            {displayName(view.examSubject.subject.nameBn, view.examSubject.subject.nameEn, locale)}
          </h2>
          <Pill
            tone={status === 'LOCKED' ? 'neutral' : status === 'SUBMITTED' ? 'success' : 'warning'}
          >
            {status === 'LOCKED' && <LockIcon aria-hidden className="size-3.5" />}
            {t(`status${status}`)}
          </Pill>
        </div>
        <p className="text-muted-foreground text-sm">
          {t('subtitle', {
            exam: displayName(view.exam.nameBn, view.exam.nameEn, locale),
            section: `${displayName(view.section.classLevel.nameBn, view.section.classLevel.nameEn, locale)} ${view.section.name}`,
            full: formatCount(view.examSubject.fullMarks, locale),
          })}
        </p>
        <SyncPill sync={sync} onRetry={() => controller.flush()} />
      </header>

      {view.sheet.returnNote && status === 'DRAFT' && (
        <Alert data-testid="sheet-return-note">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>{t('returned', { note: view.sheet.returnNote })}</AlertDescription>
        </Alert>
      )}
      {view.mode === 'READ_ONLY' && (
        <Alert data-testid="sheet-read-only">
          <LockIcon aria-hidden />
          <AlertDescription>
            {view.exam.status === 'ARCHIVED' ? t('archived') : t('lockedForTeacher')}
          </AlertDescription>
        </Alert>
      )}
      {view.mode === 'CORRECTION' && (
        <Alert data-testid="sheet-correction-mode">
          <LockIcon aria-hidden />
          <AlertDescription>{t('lockedForAdmin')}</AlertDescription>
        </Alert>
      )}
      {sync.kind === 'roster-changed' && (
        <Alert data-testid="sheet-roster-changed">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            {t('rosterChanged', {
              added: formatCount(sync.added, locale),
              removed: formatCount(sync.removed, locale),
            })}
          </AlertDescription>
        </Alert>
      )}
      {sync.kind === 'error' && (
        <Alert variant="destructive" data-testid="sheet-error">
          <AlertDescription>
            {sync.code === 'INCOMPLETE' && sync.missing
              ? t('incomplete', { count: formatCount(sync.missing, locale), n: sync.missing })
              : describe(new ApiError(409, sync.code, ''))}
          </AlertDescription>
        </Alert>
      )}

      {!wide && components.length > 1 && (
        <SegmentedControl
          label={t('part')}
          value={current ?? ''}
          onChange={setPart}
          options={components.map((c) => ({
            value: c.key,
            label: `${displayName(c.nameBn, c.nameEn, locale)} (${formatCount(c.fullMarks, locale)})`,
          }))}
          testId="sheet-parts"
        />
      )}
      {editable && <p className="text-muted-foreground text-sm">{t('typeHint')}</p>}

      <ul
        className="bg-card divide-y overflow-hidden rounded-xl border shadow-xs"
        data-testid="sheet-list"
      >
        {draft.roster.map((st) => {
          const name = displayName(st.nameBn, st.nameEn, locale);
          const roll = st.roll != null ? formatIdentifier(st.roll) : '–';
          const allAbsent = components.every(
            (c) => controller.parsed(st.id, c.key).kind === 'absent',
          );
          const preview = previewFor(view, (key) => controller.parsed(st.id, key));
          return (
            <li
              key={st.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:px-4"
              data-testid="sheet-row"
            >
              <span className="font-numeric bg-canvas flex size-11 shrink-0 items-center justify-center rounded-full border text-base font-semibold">
                {roll}
              </span>
              <span className="line-clamp-2 min-w-0 flex-[1_1_8rem] text-base leading-snug font-medium break-words">
                {name}
                {preview && (
                  <span
                    className="text-muted-foreground block text-sm font-normal"
                    data-testid="sheet-preview"
                  >
                    {t('preview', {
                      total: formatMarks(preview.obtainedH, locale),
                      full: formatCount(preview.fullMarks, locale),
                      grade: preview.letter ?? (preview.passed ? t('pass') : t('fail')),
                    })}
                  </span>
                )}
              </span>
              <div className="flex flex-wrap items-start gap-2">
                {shown.map((c) => {
                  const k = cellKey(st.id, c.key);
                  const parsed = controller.parsed(st.id, c.key);
                  const error =
                    parsed.kind === 'invalid'
                      ? t(`invalid${parsed.reason}`, { full: formatCount(c.fullMarks, locale) })
                      : null;
                  const label = t('cellLabel', {
                    roll,
                    name,
                    part: displayName(c.nameBn, c.nameEn, locale),
                    full: formatCount(c.fullMarks, locale),
                  });
                  return (
                    <div key={c.key} className="flex w-24 flex-col gap-1">
                      {wide && (
                        <span className="text-muted-foreground text-xs" aria-hidden>
                          {displayName(c.nameBn, c.nameEn, locale)} /
                          {formatCount(c.fullMarks, locale)}
                        </span>
                      )}
                      <input
                        ref={(el) => {
                          if (el) inputs.current.set(k, el);
                          else inputs.current.delete(k);
                        }}
                        id={`mark-${k}`}
                        type="text"
                        inputMode="decimal"
                        enterKeyHint="next"
                        autoComplete="off"
                        aria-label={label}
                        aria-invalid={!!error}
                        aria-describedby={error ? `mark-${k}-error` : undefined}
                        disabled={!editable}
                        value={draft.values[k] ?? ''}
                        onChange={(e) => controller.setValue(st.id, c.key, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            focusNext(k);
                          }
                        }}
                        onBlur={() => controller.flush()}
                        data-testid={`mark-input-${c.key}`}
                        className={cn(
                          'border-input bg-card font-numeric h-12 w-full rounded-md border px-3 text-end text-lg outline-none',
                          'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3 disabled:opacity-70',
                          parsed.kind === 'absent' && 'bg-muted text-muted-foreground',
                          error && 'border-destructive',
                        )}
                      />
                      {error && (
                        <span
                          id={`mark-${k}-error`}
                          className="text-destructive text-xs"
                          role="alert"
                        >
                          {error}
                        </span>
                      )}
                    </div>
                  );
                })}
                {editable && (
                  <Button
                    type="button"
                    variant={allAbsent ? 'default' : 'outline'}
                    size="lg"
                    className="min-w-14"
                    aria-pressed={allAbsent}
                    aria-label={t('absentLabel', { roll, name })}
                    onClick={() => controller.toggleAbsent(st.id)}
                    data-testid="mark-absent"
                  >
                    {t('absentShort')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Sticky bar: progress and submit. */}
      <div className="bg-card/95 sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:shadow-md">
        <p className="text-sm font-medium" data-testid="sheet-progress">
          {t('progress', {
            done: formatCount(entered, locale),
            total: formatCount(draft.roster.length, locale),
          })}
        </p>
        <Button
          size="lg"
          className="ms-auto min-w-0 flex-[0_1_14rem]"
          disabled={!editable || invalid > 0 || sync.kind === 'sending'}
          onClick={() => setConfirmOpen(true)}
          data-testid="sheet-submit"
        >
          {sync.kind === 'sending' ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : (
            <SendIcon aria-hidden />
          )}
          {status === 'SUBMITTED' ? t('resubmit') : t('submit')}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="sheet-submit-dialog">
          <DialogHeader>
            <DialogTitle>{blank > 0 ? t('blanksTitle') : t('submitTitle')}</DialogTitle>
            <DialogDescription>
              {blank > 0
                ? t('blanksBody', { count: formatCount(blank, locale), n: blank })
                : t('submitBody', { count: formatCount(draft.roster.length, locale) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {blank > 0 ? t('backToSheet') : t('cancel')}
            </Button>
            {blank === 0 && (
              <Button
                onClick={() => {
                  setConfirmOpen(false);
                  void controller.submit();
                }}
                data-testid="sheet-submit-confirm"
              >
                {t('submitConfirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sync.kind === 'conflict' && (
        <Dialog open>
          <DialogContent data-testid="sheet-conflict">
            <DialogHeader>
              <DialogTitle>{t('conflictTitle')}</DialogTitle>
              <DialogDescription>
                {t('conflictBody', {
                  name: sync.server.sheet.updatedBy?.name ?? '',
                  time: sync.server.sheet.updatedAt
                    ? formatTime(sync.server.sheet.updatedAt, locale)
                    : '',
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => controller.keepTheirs()}>
                {t('keepTheirs')}
              </Button>
              <Button onClick={() => void controller.keepMine()}>{t('keepMine')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** The subject's total and grade as typed so far (only once every part is entered). */
function previewFor(view: MarkSheetView, parsed: (key: string) => ParsedMarks) {
  const marks: Record<string, MarkEntry> = {};
  for (const c of view.examSubject.components) {
    const p = parsed(c.key);
    if (p.kind === 'blank' || p.kind === 'invalid') return null;
    marks[c.key] =
      p.kind === 'absent'
        ? { scoreH: null, absent: true }
        : { scoreH: p.hundredths, absent: false };
  }
  return subjectResult({
    passRule: view.examSubject.passRule,
    components: view.examSubject.components,
    passGroups: view.examSubject.passGroups,
    marks,
    bands: view.grading?.bands ?? null,
    roundingMode: view.grading?.roundingMode ?? 'NONE',
  });
}

/** Saved or not, in words and an icon (never colour alone). */
function SyncPill({ sync, onRetry }: { sync: SheetSync; onRetry: () => void }) {
  const t = useTranslations('exams.marks');
  const locale = useLocale() as Locale;
  const seconds = useCountdown(sync.kind === 'retrying' ? sync.at : null);
  let icon: LucideIcon = CloudCheckIcon;
  let text = t('syncSavedNever');
  let tone = 'bg-muted text-muted-foreground';
  switch (sync.kind) {
    case 'local':
    case 'roster-changed':
    case 'conflict':
    case 'error':
      icon = SmartphoneIcon;
      text = t('syncLocal');
      tone = 'bg-warning-soft text-warning';
      break;
    case 'sending':
      icon = LoaderCircleIcon;
      text = t('syncSending');
      tone = 'bg-primary-soft text-accent-foreground';
      break;
    case 'retrying':
      icon = CloudOffIcon;
      text =
        seconds > 0
          ? t('syncRetrying', { seconds: formatCount(seconds, locale) })
          : t('syncRetryingSoon');
      tone = 'bg-warning-soft text-warning';
      break;
    case 'saved':
      icon = CloudCheckIcon;
      text = sync.at
        ? t('syncSaved', { time: formatTime(sync.at, locale).replace(' ', ' ') })
        : t('syncSavedNever');
      tone = sync.at ? 'bg-success-soft text-success' : tone;
      break;
  }
  const Icon = icon;
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2" aria-live="polite">
      <span
        className={cn(
          'inline-flex max-w-full min-h-8 min-w-0 items-center gap-1.5 rounded-2xl px-3 py-1 text-sm leading-snug font-medium',
          tone,
        )}
        data-testid="sync-state"
        data-sync={sync.kind}
      >
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', sync.kind === 'sending' && 'animate-spin')}
        />
        {text}
      </span>
      {sync.kind === 'retrying' && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('retryNow')}
        </Button>
      )}
    </div>
  );
}
