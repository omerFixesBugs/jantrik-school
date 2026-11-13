'use client';

import { useMutation } from '@tanstack/react-query';
import {
  dateToDb,
  formatCount,
  formatDate,
  STAFF_DAY_STATUSES,
  STAFF_REASON_MAX,
  STAFF_REASON_MIN,
  type IsoDate,
  type StaffDayPerson,
  type StaffDayRecord,
  type StaffDayStatus,
} from '@jantrik/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SourceTag } from '@/components/attendance/source-tag';
import { TimeField } from '@/components/attendance/time-field';
import { Field } from '@/components/form-kit';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { FormDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { displayUserName } from '@/lib/names';
import {
  entryBody,
  entryForm,
  entryProblems,
  reasonLength,
  type EntryForm,
  type EntryProblem,
} from '@/lib/staff-attendance/entry';
import { cn } from '@/lib/utils';
import {
  DayStatusPill,
  MinutesPills,
  staffName,
  timeText,
  useInvalidateStaffAttendance,
  useStaffAttendanceError,
} from './kit';

type FieldKey = 'inAt' | 'outAt' | 'reason';

/**
 * A day set by hand: the status, the times of a present day, and why (required). Sent with the
 * version it was based on; when someone (or the device) changed the day meanwhile, the dialog
 * shows what is there now and a second save keeps this one.
 */
export function EntryDialog({
  person,
  date,
  onClose,
}: {
  person: StaffDayPerson;
  date: IsoDate;
  onClose: () => void;
}) {
  const t = useTranslations('staffAttendance');
  const locale = useLocale() as Locale;
  const describe = useStaffAttendanceError();
  const invalidate = useInvalidateStaffAttendance();
  const { client } = useAuth();
  const [form, setForm] = useState<EntryForm>(() => entryForm(person.day, locale));
  // The day as the server has it: the one the entry is based on.
  const [current, setCurrent] = useState<StaffDayRecord | null>(person.day);
  const [conflict, setConflict] = useState<StaffDayRecord | null | false>(false);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<EntryForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () =>
      client.api<StaffDayRecord>(`/staff-attendance/${person.userId}/${date}`, {
        method: 'PUT',
        json: entryBody(form, current?.version ?? 0),
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('day.entrySaved'));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        const day = (e.body as { day?: StaffDayRecord | null } | undefined)?.day ?? null;
        setCurrent(day);
        setConflict(day);
        invalidate();
      }
    },
  });

  const problems = tried ? entryProblems(form) : {};
  const server = serverProblem(save.error);
  const problemText = (p: EntryProblem) =>
    t(`day.problems.${p}`, {
      min: formatCount(STAFF_REASON_MIN, locale),
      max: formatCount(STAFF_REASON_MAX, locale),
    });
  const fieldError = (k: FieldKey) => {
    const p = problems[k] ?? (server?.field === k ? server.problem : undefined);
    return p ? problemText(p) : null;
  };
  // Refusals not about one field (a future day, not staff any more, busy) say so above the save.
  const general =
    save.error &&
    !server &&
    !(save.error instanceof ApiError && save.error.code === 'VERSION_CONFLICT')
      ? describe(save.error)
      : null;
  const length = reasonLength(form.reason);
  const name = staffName(person, locale);

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('day.entryTitle', { name, date: formatDate(dateToDb(date), locale, 'long') })}
      description={t('day.entryHint')}
      submitLabel={t('day.entrySave')}
      pending={save.isPending}
      onSubmit={() => {
        setTried(true);
        if (Object.keys(entryProblems(form)).length === 0) save.mutate();
      }}
      testId="staff-entry-dialog"
      noValidate
    >
      <div
        className="bg-canvas flex flex-col gap-1.5 rounded-lg border p-3 text-sm"
        data-testid="staff-entry-current"
      >
        <span className="text-muted-foreground text-xs font-medium">{t('day.entryNow')}</span>
        {current ? (
          <span className="flex flex-wrap items-center gap-2">
            <DayStatusPill status={current.status} state={null} />
            {current.inAt && (
              <span className="font-numeric">
                {current.outAt
                  ? `${timeText(current.inAt, locale)} – ${timeText(current.outAt, locale)}`
                  : timeText(current.inAt, locale)}
              </span>
            )}
            <MinutesPills day={current} />
            <SourceTag source={current.source} />
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {conflict === false && person.state && person.state !== 'NONE' ? (
              <DayStatusPill status={null} state={person.state} />
            ) : (
              <span className="text-muted-foreground">{t('day.entryNone')}</span>
            )}
          </span>
        )}
        {current?.reason && (
          <span className="text-muted-foreground break-words">
            {t('common.reason', { reason: current.reason })}
          </span>
        )}
      </div>

      {conflict !== false && (
        <Alert className="border-warning/40 bg-warning-soft" data-testid="staff-entry-conflict">
          <TriangleAlertIcon aria-hidden className="text-warning" />
          <AlertDescription className="text-foreground">
            {conflict && !conflict.updatedBy.id
              ? t('day.entryConflictDevice')
              : t('day.entryConflict', {
                  name: conflict ? displayUserName(conflict.updatedBy, locale) : '—',
                })}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <span aria-hidden className="text-sm font-medium">
          {t('day.entryStatus')}
        </span>
        <SegmentedControl<StaffDayStatus>
          label={t('day.entryStatus')}
          value={form.status}
          onChange={(status) => set({ status })}
          options={STAFF_DAY_STATUSES.map((s) => ({ value: s, label: t(`common.status.${s}`) }))}
          className="w-fit max-w-full flex-wrap"
          testId="staff-entry-status"
        />
      </div>

      {form.status === 'PRESENT' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TimeField
            id="staff-entry-in"
            label={t('day.entryIn')}
            value={form.inAt}
            onChange={(inAt) => set({ inAt })}
            error={fieldError('inAt')}
            required
          />
          <TimeField
            id="staff-entry-out"
            label={t('day.entryOut')}
            value={form.outAt}
            onChange={(outAt) => set({ outAt })}
            error={fieldError('outAt')}
          />
        </div>
      )}

      <Field
        id="staff-entry-reason"
        label={t('day.entryReason')}
        hint={t('day.entryReasonHint', {
          min: formatCount(STAFF_REASON_MIN, locale),
          max: formatCount(STAFF_REASON_MAX, locale),
        })}
        error={fieldError('reason')}
        required
      >
        <textarea
          id="staff-entry-reason"
          className={cn(
            'border-input bg-card min-h-24 w-full min-w-0 rounded-lg border px-3 py-2 text-(length:--input-fs) shadow-xs outline-none',
            'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3 aria-invalid:border-destructive',
          )}
          value={form.reason}
          // A little room over the limit, so a pasted reason is cut where the person can see it.
          maxLength={STAFF_REASON_MAX + 20}
          required
          aria-invalid={fieldError('reason') ? true : undefined}
          aria-describedby={`staff-entry-reason-count staff-entry-reason-${fieldError('reason') ? 'error' : 'hint'}`}
          onChange={(e) => set({ reason: e.target.value })}
          data-testid="staff-entry-reason"
        />
        <span
          id="staff-entry-reason-count"
          className={cn(
            'font-numeric self-end text-xs',
            length > STAFF_REASON_MAX ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {t('day.entryCounter', {
            count: formatCount(length, locale),
            max: formatCount(STAFF_REASON_MAX, locale),
          })}
        </span>
      </Field>

      {general && (
        <Alert variant="destructive">
          <AlertDescription>{general}</AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}

/** A refusal about one field: the API's codes and the 400's paths. */
function serverProblem(error: unknown): { field: FieldKey; problem: EntryProblem } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'IN_TIME_REQUIRED') return { field: 'inAt', problem: 'IN_REQUIRED' };
  if (error.code === 'OUT_BEFORE_IN') return { field: 'outAt', problem: 'OUT_BEFORE_IN' };
  if (error.status !== 400) return null;
  const paths = ((error.body as { errors?: { path: string }[] } | null)?.errors ?? []).map(
    (e) => e.path,
  );
  if (paths.includes('inAt')) return { field: 'inAt', problem: 'TIME_INVALID' };
  if (paths.includes('outAt')) return { field: 'outAt', problem: 'TIME_INVALID' };
  if (paths.includes('reason')) return { field: 'reason', problem: 'REASON_SHORT' };
  return null;
}
