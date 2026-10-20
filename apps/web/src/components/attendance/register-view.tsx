'use client';

import {
  dateToDb,
  formatCount,
  formatDate,
  formatIdentifier,
  formatTime,
  type AttendanceStatus,
  type IsoDate,
} from '@jantrik/shared';
import {
  CalendarOffIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  CloudCheckIcon,
  CloudOffIcon,
  LoaderCircleIcon,
  SendIcon,
  SmartphoneIcon,
  TableIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
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
import { conflictDiff, type SyncState } from '@/lib/attendance/register-controller';
import { useRegister } from '@/lib/attendance/use-register';
import { useCountdown, useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName, displayUserName } from '@/lib/names';
import { cn } from '@/lib/utils';
import { registerHref } from './section-picker';

const STATUS_STYLE: Record<AttendanceStatus, { icon: LucideIcon; row: string; pill: string }> = {
  PRESENT: { icon: CheckIcon, row: 'bg-card', pill: 'bg-success-soft text-success' },
  ABSENT: {
    icon: XIcon,
    row: 'bg-destructive-soft',
    pill: 'bg-destructive text-white dark:text-[#2a0c09]',
  },
  LATE: { icon: ClockIcon, row: 'bg-warning-soft/60', pill: 'bg-warning-soft text-warning' },
  LEAVE: { icon: CalendarOffIcon, row: 'bg-muted/60', pill: 'bg-muted text-muted-foreground' },
};
const ORDER: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'];

interface Props {
  sectionId: string;
  periodNo: number;
  date?: IsoDate;
  sectionName: string;
  /** Show the "all sections" link (admins, or teachers with more than one section). */
  showBack: boolean;
}

/** Take or edit one register. Phone-first: big rows, a sticky bar with counts and submit. */
export function RegisterView({ sectionId, periodNo, date, sectionName, showBack }: Props) {
  const t = useTranslations('attendance');
  const tReports = useTranslations('reports');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const { sheet, draft, sync, counts, controller, offline } = useRegister({
    sectionId,
    periodNo,
    date,
    sectionName,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (sync.kind === 'loading') return <RegisterSkeleton />;
  if (sync.kind === 'unavailable' || !draft) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          {sync.kind === 'unavailable' ? describe(sync.error) : t('unavailable')}
          <Button size="sm" variant="outline" onClick={() => void controller.load()}>
            {t('retryNow')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const total = draft.roster.length;
  const nonWorkingDay = sheet?.nonWorkingDay ?? null;
  const needsOverride = !!nonWorkingDay && isAdmin && !draft.allowNonWorkingDay;
  const blocked = sheet ? !sheet.canSubmit : false;
  const editable = !blocked && !needsOverride && sync.kind !== 'sending';
  const title = sheet
    ? `${displayName(sheet.section.classLevel.nameBn, sheet.section.classLevel.nameEn, locale)}, ${sheet.section.name}`
    : draft.sectionName;
  const nothingToSend = sync.kind === 'saved' || sync.kind === 'sending';

  const onSubmit = () => {
    if (counts.ABSENT * 2 > total) setConfirmOpen(true);
    else void controller.submit();
  };

  return (
    // Capped width: on a wide screen the status stays next to the name.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-2">
      {/* Heading: which register, which day (from the server), and whether it is saved. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
          {showBack ? (
            <Link
              href="/attendance"
              className="text-muted-foreground hover:text-foreground flex w-fit min-h-(--control-h) items-center gap-1"
            >
              <ChevronLeftIcon aria-hidden className="size-4" />
              {t('back', { section: label('section', 'Section', { inText: true }) })}
            </Link>
          ) : (
            <span />
          )}
          <Link
            href={`/attendance/register?section=${sectionId}`}
            className="text-primary flex min-h-(--control-h) items-center gap-1 font-medium hover:underline"
            data-testid="open-month-register"
          >
            <TableIcon aria-hidden className="size-4" />
            {tReports('registerTitle')}
          </Link>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate text-2xl font-semibold" data-testid="register-title">
              {title}
            </h2>
            <p className="text-muted-foreground text-sm">
              {formatDate(dateToDb(draft.date), locale, 'full')}
            </p>
          </div>
          <SyncPill sync={sync} onRetry={() => void controller.submit()} />
        </div>
      </div>

      {sheet?.mode === 'PER_SESSION' && (
        <PeriodPicker
          current={periodNo}
          onPick={(n) => router.replace(registerHref(sectionId, n, date))}
        />
      )}

      {offline && (
        <Alert>
          <CloudOffIcon aria-hidden />
          <AlertDescription>{t('offlineCopy')}</AlertDescription>
        </Alert>
      )}
      {nonWorkingDay && (
        <Alert>
          <CalendarOffIcon aria-hidden />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {nonWorkingDay.reason === 'HOLIDAY'
              ? t('holiday', {
                  name: locale === 'bn' ? nonWorkingDay.nameBn : nonWorkingDay.nameEn,
                })
              : t('offDay')}
            {needsOverride && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => controller.setAllowNonWorkingDay(true)}
              >
                {t('takeAnyway')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {sheet && sheet.blockedReason && sheet.blockedReason !== 'NON_WORKING_DAY' && (
        <Alert>
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>{t(`blocked${sheet.blockedReason}`)}</AlertDescription>
        </Alert>
      )}
      {sync.kind === 'roster-changed' && (
        <Alert>
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
        <Alert variant="destructive" data-testid="register-error">
          <AlertDescription>
            {sync.code && `blocked${sync.code}` in BLOCKED_KEYS
              ? t(`blocked${sync.code as 'EDIT_WINDOW_CLOSED'}`)
              : t('errorGeneric', { code: sync.code ?? '?' })}
          </AlertDescription>
        </Alert>
      )}

      {editable && <p className="text-muted-foreground text-sm">{t('tapHint')}</p>}

      <ul
        className="bg-card divide-y overflow-hidden rounded-xl border shadow-xs"
        data-testid="register-list"
      >
        {draft.roster.map((st) => {
          const status = draft.statuses[st.id] ?? 'PRESENT';
          const style = STATUS_STYLE[status];
          const name = displayName(st.nameBn, st.nameEn, locale);
          const roll = st.roll != null ? formatIdentifier(st.roll) : t('noRoll');
          return (
            <li key={st.id}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => controller.cycle(st.id)}
                aria-label={t('rowLabel', { roll, name, status: t(`status${status}`) })}
                data-status={status}
                className={cn(
                  'flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left transition-colors sm:px-4',
                  'focus-visible:ring-ring outline-none focus-visible:ring-3 focus-visible:ring-inset',
                  'active:brightness-95 disabled:cursor-default',
                  style.row,
                )}
              >
                <span className="font-numeric bg-canvas text-foreground flex size-11 shrink-0 items-center justify-center rounded-full border text-base font-semibold">
                  {st.roll != null ? formatIdentifier(st.roll) : '–'}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-base leading-snug font-medium break-words">
                  {name}
                </span>
                <span
                  className={cn(
                    'inline-flex h-9 min-w-24 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm font-semibold whitespace-nowrap',
                    style.pill,
                  )}
                >
                  <style.icon aria-hidden className="size-4" />
                  {t(`status${status}`)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Sticky bar: live counts, "all present", submit. */}
      <div className="bg-card/95 sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:shadow-md">
        <ul
          className="grid grid-cols-4 gap-2"
          aria-label={t('tapHint')}
          data-testid="register-counts"
        >
          {ORDER.map((s) => (
            <li
              key={s}
              className={cn('flex flex-col items-center rounded-lg py-1.5', STATUS_STYLE[s].pill)}
            >
              <span className="font-numeric text-lg leading-tight font-semibold">
                {formatCount(counts[s], locale)}
              </span>
              <span className="text-xs">{t(`status${s}`)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="lg"
            className="min-w-0 flex-[1_1_9rem]"
            disabled={!editable}
            onClick={() => controller.markAllPresent()}
          >
            <CheckCheckIcon aria-hidden />
            {t('markAllPresent')}
          </Button>
          <Button
            size="lg"
            className="min-w-0 flex-[2_1_11rem]"
            disabled={!editable || nothingToSend}
            onClick={onSubmit}
            data-testid="register-submit"
          >
            {sync.kind === 'sending' ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : (
              <SendIcon aria-hidden />
            )}
            {sheet?.session || draft.baseVersion > 0 ? t('submitChanges') : t('submit')}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="absent-confirm">
          <DialogHeader>
            <DialogTitle>
              {t('confirmTitle', { count: formatCount(counts.ABSENT, locale) })}
            </DialogTitle>
            <DialogDescription>
              {t('confirmBody', {
                count: formatCount(counts.ABSENT, locale),
                total: formatCount(total, locale),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('confirmNo')}
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void controller.submit();
              }}
            >
              {t('confirmYes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sync.kind === 'conflict' && (
        <ConflictDialog
          sync={sync}
          draftDiff={conflictDiff(draft, sync.server)}
          onMine={() => void controller.keepMine()}
          onTheirs={() => controller.keepTheirs()}
        />
      )}
    </div>
  );
}

const BLOCKED_KEYS = {
  blockedEDIT_WINDOW_CLOSED: true,
  blockedFUTURE_DATE: true,
  blockedNON_WORKING_DAY: true,
};

/** Saved or not, in words and an icon (never colour alone). */
function SyncPill({ sync, onRetry }: { sync: SyncState; onRetry: () => void }) {
  const t = useTranslations('attendance');
  const locale = useLocale() as Locale;
  const seconds = useCountdown(sync.kind === 'retrying' ? sync.at : null);
  let icon: LucideIcon = SmartphoneIcon;
  let text = t('syncFresh');
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
      // Non-breaking space inside the time ("রাত ১০:৪২"): it wraps as one piece.
      text = t('syncSaved', { time: formatTime(sync.submittedAt, locale).replace(' ', ' ') });
      tone = 'bg-success-soft text-success';
      break;
  }
  const Icon = icon;
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2" aria-live="polite">
      <span
        className={cn(
          // Wraps like a short paragraph when it must (large text on a small phone), so it can't
          // clip or overlap: no fixed height, no fully round ends.
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

function PeriodPicker({ current, onPick }: { current: number; onPick: (n: number) => void }) {
  const t = useTranslations('attendance');
  const locale = useLocale() as Locale;
  return (
    <div
      className="flex items-center gap-2 overflow-x-auto pb-1"
      role="group"
      aria-label={t('period')}
    >
      <span className="text-muted-foreground shrink-0 text-sm">{t('period')}</span>
      {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
        <Button
          key={n}
          size="sm"
          variant={n === current ? 'default' : 'outline'}
          aria-pressed={n === current}
          className="font-numeric min-w-10 rounded-full"
          onClick={() => onPick(n)}
        >
          {formatCount(n, locale)}
        </Button>
      ))}
    </div>
  );
}

/** Simple on purpose: who changed it and when, only the students that differ, two choices. */
function ConflictDialog({
  sync,
  draftDiff,
  onMine,
  onTheirs,
}: {
  sync: Extract<SyncState, { kind: 'conflict' }>;
  draftDiff: ReturnType<typeof conflictDiff>;
  onMine: () => void;
  onTheirs: () => void;
}) {
  const t = useTranslations('attendance');
  const locale = useLocale() as Locale;
  return (
    <Dialog open disablePointerDismissal onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} data-testid="conflict-dialog">
        <DialogHeader>
          <DialogTitle>
            {t('conflictTitle', {
              name: displayUserName(sync.server.updatedBy, locale),
              time: formatTime(sync.server.submittedAt, locale),
            })}
          </DialogTitle>
          <DialogDescription>{t('conflictBody')}</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
          {draftDiff.map(({ student, mine, theirs }) => (
            <li key={student.id} className="flex flex-col gap-1 px-3 py-2">
              <span className="font-medium">
                {student.roll != null && (
                  <span className="font-numeric text-muted-foreground mr-2">
                    {formatIdentifier(student.roll)}
                  </span>
                )}
                {displayName(student.nameBn, student.nameEn, locale)}
              </span>
              <span className="flex flex-wrap gap-2 text-sm">
                <StatusChip who={t('conflictYours')} status={mine} />
                <StatusChip who={t('conflictOthers')} status={theirs} />
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
          <Button variant="outline" size="lg" onClick={onTheirs}>
            {t('conflictTheirs')}
          </Button>
          <Button size="lg" onClick={onMine}>
            {t('conflictMine')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusChip({ who, status }: { who: string; status: AttendanceStatus }) {
  const t = useTranslations('attendance');
  const style = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5', style.pill)}>
      <span className="font-normal opacity-80">{who}:</span>
      <style.icon aria-hidden className="size-3.5" />
      {t(`status${status}`)}
    </span>
  );
}

function RegisterSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-36" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}
