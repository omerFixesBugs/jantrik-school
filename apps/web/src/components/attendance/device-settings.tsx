'use client';

import { useQuery } from '@tanstack/react-query';
import {
  entrySmsText,
  exitSmsText,
  formatCount,
  smsLength,
  STAFF_RANGE_SIZE,
  type AttendanceMode,
  type StaffRangeCheck,
} from '@jantrik/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { TimeField } from '@/components/attendance/time-field';
import { Field, ToggleField } from '@/components/form-kit';
import { FormGrid } from '@/components/form-layout';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  DEVICE_NUMBER_FIELDS,
  type DeviceFieldProblem,
  type DeviceNumberField,
  type DeviceTimeField,
  type DeviceValues,
} from '@/lib/attendance/device-settings';
import { wholeNumber } from '@/lib/attendance/time-input';
import { useDebounced, useLabel, useMeContext } from '@/lib/hooks';
import { bnGenitive } from '@/lib/names';

/*
 * The attendance settings' cards for devices and staff (docs/devices.md): device attendance,
 * checks on punches, entry and exit SMS, staff office hours and the staff ID range. They edit
 * part of the settings form; the page's save sends everything with the one PUT.
 */

/** A titled card on the settings page. */
export function SettingsCard({
  title,
  hint,
  children,
  id,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-5"
      aria-labelledby={id}
      data-testid={id}
    >
      <div className="flex flex-col gap-1">
        <h3 id={id} className="text-lg font-semibold">
          {title}
        </h3>
        {hint && <p className="text-muted-foreground max-w-prose text-sm">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

type Errors = Partial<Record<DeviceNumberField | DeviceTimeField, DeviceFieldProblem>>;

interface CardProps {
  values: DeviceValues;
  onChange: (patch: Partial<DeviceValues>) => void;
  errors: Errors;
}

/** The four cards, in the order of the settings page. */
export function DeviceSettingsCards({ mode, ...props }: CardProps & { mode: AttendanceMode }) {
  return (
    <>
      <DeviceAttendanceCard {...props} mode={mode} />
      <DeviceChecksCard {...props} />
      <MovementSmsCard {...props} />
      <StaffOfficeCard {...props} />
    </>
  );
}

function DeviceAttendanceCard({
  values,
  onChange,
  errors,
  mode,
}: CardProps & { mode: AttendanceMode }) {
  const t = useTranslations('attendanceSettings');
  const label = useLabel();
  return (
    <SettingsCard id="settings-device" title={t('deviceTitle')} hint={t('deviceHint')}>
      <ToggleField
        id="device-auto-mark"
        checked={values.deviceAutoMark}
        onChange={(v) => onChange({ deviceAutoMark: v })}
        label={t('autoMark')}
        hint={t('autoMarkHint')}
      />
      {mode === 'PER_SESSION' && values.deviceAutoMark && (
        <p className="text-warning flex items-start gap-2 text-sm font-medium">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('autoMarkPerSession')}
        </p>
      )}
      <FormGrid>
        <NumberField
          id="device-grace"
          field="deviceGraceMinutes"
          label={t('grace')}
          hint={t('graceHint')}
          {...{ values, onChange, errors }}
        />
        <NumberField
          id="device-cutoff"
          field="deviceCutoffMinutes"
          label={t('cutoff')}
          hint={t('cutoffHint')}
          {...{ values, onChange, errors }}
        />
        <TimeSetting
          id="device-default-start"
          field="deviceDefaultStart"
          label={t('defaultStart')}
          hint={t('defaultStartHint', {
            section: label('section', 'Section', { inText: true }),
            sectionOf: bnGenitive(label('section', 'শাখা')),
          })}
          {...{ values, onChange, errors }}
        />
      </FormGrid>
    </SettingsCard>
  );
}

function DeviceChecksCard({ values, onChange, errors }: CardProps) {
  const t = useTranslations('attendanceSettings');
  return (
    <SettingsCard id="settings-device-checks" title={t('checksTitle')} hint={t('checksHint')}>
      <FormGrid>
        <TimeSetting
          id="device-hours-start"
          field="deviceHoursStart"
          label={t('hoursStart')}
          {...{ values, onChange, errors }}
        />
        <TimeSetting
          id="device-hours-end"
          field="deviceHoursEnd"
          label={t('hoursEnd')}
          {...{ values, onChange, errors }}
        />
        <p className="text-muted-foreground text-sm md:col-span-2 xl:col-span-1 xl:self-end">
          {t('hoursHint')}
        </p>
        <NumberField
          id="device-per-minute"
          field="deviceMaxPunchesPerMinute"
          label={t('perMinute')}
          hint={t('perMinuteHint')}
          {...{ values, onChange, errors }}
        />
        <NumberField
          id="device-retention"
          field="punchRetentionDays"
          label={t('retention')}
          hint={t('retentionHint')}
          {...{ values, onChange, errors }}
        />
      </FormGrid>
    </SettingsCard>
  );
}

/** A sample guardian's view: the real text builders, a sample student and the institute. */
const SAMPLE_STUDENT = 'আরিফ হোসেন';

function MovementSmsCard({ values, onChange }: CardProps) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const { data: context } = useMeContext();
  // The server's today (never the device's date), at a morning and an afternoon time.
  const day = context?.today ?? '2026-01-01';
  const institute = context?.tenant.name ?? '';
  const previews = [
    {
      key: 'entry',
      label: t('entryPreview'),
      on: values.entrySmsEnabled,
      text: entrySmsText({
        student: SAMPLE_STUDENT,
        at: new Date(`${day}T07:45:00+06:00`),
        institute,
      }),
    },
    {
      key: 'exit',
      label: t('exitPreview'),
      on: values.exitSmsEnabled,
      text: exitSmsText({
        student: SAMPLE_STUDENT,
        at: new Date(`${day}T13:30:00+06:00`),
        institute,
      }),
    },
  ];
  return (
    <SettingsCard id="settings-movement-sms" title={t('moveTitle')} hint={t('moveHint')}>
      <div className="flex flex-col gap-3">
        <ToggleField
          id="entry-sms"
          checked={values.entrySmsEnabled}
          onChange={(v) => onChange({ entrySmsEnabled: v })}
          label={t('entrySms')}
        />
        <ToggleField
          id="exit-sms"
          checked={values.exitSmsEnabled}
          onChange={(v) => onChange({ exitSmsEnabled: v })}
          label={t('exitSms')}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {previews.map((p) => {
          const len = smsLength(p.text);
          return (
            <div
              key={p.key}
              className="bg-canvas flex flex-col gap-2 rounded-lg border p-3"
              data-off={!p.on}
              data-testid={`${p.key}-sms-preview`}
            >
              <span className="text-muted-foreground text-xs font-medium">{p.label}</span>
              <p className="break-words whitespace-pre-wrap" lang="bn">
                {p.text}
              </p>
              <p className="text-muted-foreground text-sm">
                {t('length', {
                  chars: formatCount(len.length, locale),
                  segments: formatCount(len.segments, locale),
                })}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">{t('moveCost')}</p>
    </SettingsCard>
  );
}

function StaffOfficeCard({ values, onChange, errors }: CardProps) {
  const t = useTranslations('attendanceSettings');
  return (
    <SettingsCard id="settings-staff" title={t('staffTitle')} hint={t('staffHint')}>
      <FormGrid>
        <TimeSetting
          id="staff-office-start"
          field="staffOfficeStart"
          label={t('officeStart')}
          {...{ values, onChange, errors }}
        />
        <TimeSetting
          id="staff-office-end"
          field="staffOfficeEnd"
          label={t('officeEnd')}
          {...{ values, onChange, errors }}
        />
        <span aria-hidden className="hidden xl:block" />
        <NumberField
          id="staff-late-grace"
          field="staffLateGraceMinutes"
          label={t('lateGrace')}
          {...{ values, onChange, errors }}
        />
        <NumberField
          id="staff-early-grace"
          field="staffEarlyGraceMinutes"
          label={t('earlyGrace')}
          {...{ values, onChange, errors }}
        />
      </FormGrid>
      <div className="flex flex-col gap-2 border-t pt-4">
        <NumberField
          id="staff-id-start"
          field="staffDeviceIdStart"
          label={t('staffIdStart')}
          hint={t('staffIdStartHint')}
          ascii
          className="md:max-w-xs"
          {...{ values, onChange, errors }}
        />
        <StaffRangeWarning start={values.staffDeviceIdStart} />
      </div>
    </SettingsCard>
  );
}

/** How many current students' codes fall in the staff range, checked as the start is typed. */
function StaffRangeWarning({ start }: { start: string }) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const n = useDebounced(wholeNumber(start), 400);
  const [min, max] = DEVICE_NUMBER_FIELDS.staffDeviceIdStart;
  const valid = n !== null && n >= min && n <= max;
  const check = useQuery({
    queryKey: ['staff-range-check', session?.tenant?.id, n],
    queryFn: () =>
      client.api<StaffRangeCheck>(`/attendance/device-people/staff-range-check?start=${n}`),
    enabled: valid,
    staleTime: 60_000,
  });
  if (!valid) return null;
  const range = { from: String(n), to: String(n + STAFF_RANGE_SIZE - 1) };
  return (
    <p aria-live="polite" className="text-sm" data-testid="staff-range-check">
      {check.isPending ? (
        <span className="text-muted-foreground">{t('staffIdChecking')}</span>
      ) : check.data && check.data.studentDefaultsInRange > 0 ? (
        <span className="text-warning flex items-start gap-2 font-medium">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('staffIdOverlap', {
            count: formatCount(check.data.studentDefaultsInRange, locale),
            ...range,
          })}
        </span>
      ) : check.data ? (
        <span className="text-muted-foreground">{t('staffIdClear', range)}</span>
      ) : null}
    </p>
  );
}

interface FieldProps<F> extends CardProps {
  id: string;
  field: F;
  label: string;
  hint?: string;
  className?: string;
}

/** A whole number, typed with either digits; its allowed range is the hint. */
function NumberField({
  id,
  field,
  label,
  hint,
  values,
  onChange,
  errors,
  ascii = false,
  className,
}: FieldProps<DeviceNumberField> & { ascii?: boolean }) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const [min, max] = DEVICE_NUMBER_FIELDS[field];
  // An ID's bounds in ASCII, minutes and days in the UI's digits.
  const n = (v: number) => (ascii ? String(v) : formatCount(v, locale));
  const range = t('rangeHint', { min: n(min), max: n(max) });
  const error = errors[field] ? t('errorRange', { min: n(min), max: n(max) }) : null;
  return (
    <Field
      id={id}
      label={label}
      hint={hint ? `${hint} (${range})` : range}
      error={error}
      className={className}
    >
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        className="w-full sm:max-w-40"
        value={values[field]}
        onChange={(e) => onChange({ [field]: e.target.value } as Partial<DeviceValues>)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        dir={ascii ? 'ltr' : undefined}
      />
    </Field>
  );
}

/** A time setting: the shared time field, its API problem in words. */
function TimeSetting({
  id,
  field,
  label,
  hint,
  values,
  onChange,
  errors,
}: FieldProps<DeviceTimeField>) {
  const t = useTranslations('attendanceSettings');
  const problem = errors[field];
  return (
    <TimeField
      id={id}
      label={label}
      hint={hint}
      value={values[field]}
      onChange={(v) => onChange({ [field]: v } as Partial<DeviceValues>)}
      error={problem === 'END' ? t('errorEndAfterStart') : problem ? t('errorTime') : null}
    />
  );
}
