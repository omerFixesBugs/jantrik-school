'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ABSENT_SMS_TEMPLATE,
  dateToDb,
  formatCount,
  formatDate,
  renderSmsTemplate,
  smsLength,
  SMS_TEMPLATE_VARIABLES,
  validateSmsTemplate,
  type AttendanceMode,
  type AttendanceSettings,
  type AttendanceSettingsInput,
  type AttendanceStaffMember,
  type Holiday,
  type MySectionsResponse,
  type SectionTeacherEntry,
  type SmsTemplateVariable,
} from '@jantrik/shared';
import { LockIcon, PlusIcon, StarIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AttendanceTabs, isAdminRole } from '@/components/attendance/attendance-tabs';
import { ChoiceChip } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName, displayUserName } from '@/lib/names';
import { cn } from '@/lib/utils';

export default function AttendanceSettingsPage() {
  const t = useTranslations('attendanceSettings');
  const { data: context } = useMeContext();
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="settings" />
        <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
        {isAdminRole(context?.roles) ? (
          <div className="flex flex-col gap-6">
            <RulesAndSms />
            <Holidays />
            <SectionTeachers />
          </div>
        ) : (
          <Alert>
            <LockIcon aria-hidden />
            <AlertDescription>{t('adminOnly')}</AlertDescription>
          </Alert>
        )}
      </div>
    </PageGate>
  );
}

function Card({
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
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const textareaClass =
  'min-h-28 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

/** Saturday first, as on a Bangladeshi calendar. ISO numbers (1 = Monday). */
const WEEK = [6, 7, 1, 2, 3, 4, 5] as const;

type Form = Omit<AttendanceSettingsInput, 'absentSmsTemplate'> & { absentSmsTemplate: string };

// ───────────────────────────── Rules + SMS ─────────────────────────────

function RulesAndSms() {
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['attendance-settings', session?.tenant?.id];
  const settings = useQuery({
    queryKey: key,
    queryFn: () => client.api<AttendanceSettings>('/attendance/settings'),
  });
  if (settings.isPending)
    return <Skeleton className="h-96 rounded-xl" aria-label={tCommon('loading')} />;
  if (settings.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(settings.error)}</AlertDescription>
      </Alert>
    );
  return (
    <SettingsForm
      initial={settings.data}
      onSaved={(next) => {
        queryClient.setQueryData(key, next);
        void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
      }}
    />
  );
}

function SettingsForm({
  initial,
  onSaved,
}: {
  initial: AttendanceSettings;
  onSaved: (s: AttendanceSettings) => void;
}) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client } = useAuth();
  const [form, setForm] = useState<Form>(() => ({
    mode: initial.mode,
    weeklyOffDays: initial.weeklyOffDays,
    editWindowDays: initial.editWindowDays,
    leaveCountsAsAbsent: initial.leaveCountsAsAbsent,
    absentSmsEnabled: initial.absentSmsEnabled,
    absentSmsTemplate: initial.effectiveAbsentSmsTemplate,
    absentSmsDelayMinutes: initial.absentSmsDelayMinutes,
    dailySmsCap: initial.dailySmsCap,
  }));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const autoCap = initial.automaticSmsCap;

  const save = useMutation({
    mutationFn: () =>
      client.api<AttendanceSettings>('/attendance/settings', {
        method: 'PUT',
        json: {
          ...form,
          // The standard text is stored as "no template of our own".
          absentSmsTemplate:
            form.absentSmsTemplate.trim() === DEFAULT_ABSENT_SMS_TEMPLATE
              ? null
              : form.absentSmsTemplate,
        },
      }),
    onSuccess: (next) => {
      onSaved(next);
      toast.success(t('saved'));
    },
    onError: (e) =>
      toast.error(e instanceof ApiError && e.status === 400 ? t('saveFailed') : describe(e)),
  });

  const templateProblems = form.absentSmsEnabled ? validateSmsTemplate(form.absentSmsTemplate) : [];

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (templateProblems.length === 0) save.mutate();
      }}
      data-testid="settings-form"
    >
      <Card id="settings-rules" title={t('general')}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('mode')}</legend>
          <div className="flex flex-wrap gap-2">
            {(['DAILY', 'PER_SESSION'] as AttendanceMode[]).map((m) => (
              <ChoiceChip
                key={m}
                type="radio"
                name="mode"
                checked={form.mode === m}
                onChange={() => set('mode', m)}
              >
                {t(`mode${m}`)}
              </ChoiceChip>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('offDays')}</legend>
          <div className="flex flex-wrap gap-2">
            {WEEK.map((d) => (
              <ChoiceChip
                key={d}
                type="checkbox"
                name="offDay"
                checked={form.weeklyOffDays.includes(d)}
                onChange={(on) =>
                  set(
                    'weeklyOffDays',
                    on ? [...form.weeklyOffDays, d] : form.weeklyOffDays.filter((x) => x !== d),
                  )
                }
              >
                {t(`weekday${d}`)}
              </ChoiceChip>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-window">{t('editWindow')}</Label>
          <Input
            id="edit-window"
            type="number"
            inputMode="numeric"
            min={0}
            max={30}
            className="w-28"
            value={form.editWindowDays}
            onChange={(e) => set('editWindowDays', clampInt(e.target.value, 0, 30))}
          />
          <p className="text-muted-foreground text-sm">{t('editWindowHint')}</p>
        </div>

        <Toggle
          id="leave-rule"
          checked={form.leaveCountsAsAbsent}
          onChange={(v) => set('leaveCountsAsAbsent', v)}
          label={t('leaveRule')}
          hint={t('leaveRuleHint')}
        />
      </Card>

      <Card id="settings-sms" title={t('smsTitle')}>
        <Toggle
          id="sms-enabled"
          checked={form.absentSmsEnabled}
          onChange={(v) => set('absentSmsEnabled', v)}
          label={t('smsEnabled')}
          hint={t('smsHint')}
        />
        <fieldset
          disabled={!form.absentSmsEnabled}
          className="flex flex-col gap-5 disabled:opacity-60"
        >
          <TemplateEditor
            value={form.absentSmsTemplate}
            onChange={(v) => set('absentSmsTemplate', v)}
            problems={templateProblems}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sms-delay">{t('delay')}</Label>
            <Input
              id="sms-delay"
              type="number"
              inputMode="numeric"
              min={0}
              max={240}
              className="w-28"
              value={form.absentSmsDelayMinutes}
              onChange={(e) => set('absentSmsDelayMinutes', clampInt(e.target.value, 0, 240))}
            />
            <p className="text-muted-foreground text-sm">{t('delayHint')}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('cap')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <ChoiceChip
                type="radio"
                name="cap"
                checked={form.dailySmsCap === null}
                onChange={() => set('dailySmsCap', null)}
              >
                {t('capAuto', { n: formatCount(autoCap, locale) })}
              </ChoiceChip>
              <ChoiceChip
                type="radio"
                name="cap"
                checked={form.dailySmsCap !== null}
                onChange={() =>
                  set('dailySmsCap', initial.dailySmsCap ?? initial.effectiveDailySmsCap)
                }
              >
                {t('capCustom')}
              </ChoiceChip>
              {form.dailySmsCap !== null && (
                <Input
                  aria-label={t('cap')}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className="w-32"
                  value={form.dailySmsCap}
                  onChange={(e) => set('dailySmsCap', clampInt(e.target.value, 0, 1_000_000))}
                />
              )}
            </div>
            <p className="text-muted-foreground text-sm">{t('capHint')}</p>
            {initial.platformSmsCap !== null && (
              <p className="text-warning text-sm">
                {t('capPlatform', { n: formatCount(initial.platformSmsCap, locale) })}
              </p>
            )}
          </fieldset>
        </fieldset>
      </Card>

      <div className="bg-background/95 sticky bottom-0 z-10 -mx-1 flex justify-end border-t px-1 py-3 backdrop-blur">
        <Button
          type="submit"
          size="lg"
          disabled={save.isPending || templateProblems.length > 0}
          data-testid="settings-save"
        >
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

const clampInt = (raw: string, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(Number(raw) || 0)));

function Toggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary mt-0.5 size-5 shrink-0"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="leading-snug font-medium">
          {label}
        </label>
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      </div>
    </div>
  );
}

/** The SMS text with variable buttons, a live preview and the SMS count. */
function TemplateEditor({
  value,
  onChange,
  problems,
}: {
  value: string;
  onChange: (v: string) => void;
  problems: string[];
}) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const { data: context } = useMeContext();
  const ref = useRef<HTMLTextAreaElement>(null);
  const preview = renderSmsTemplate(value, {
    student: 'আরিফ হোসেন',
    date: formatDate(new Date(), 'bn', 'long'),
    institute: context?.tenant.name ?? '',
  });
  const len = smsLength(preview);
  const varLabel: Record<SmsTemplateVariable, string> = {
    student: t('varStudent'),
    date: t('varDate'),
    institute: t('varInstitute'),
  };
  const insert = (v: SmsTemplateVariable) => {
    const el = ref.current;
    const token = `{${v}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const message = (p: string) => {
    const unknown = /^Unknown variable \{(.*)\}$/.exec(p);
    if (unknown) return t('unknownVar', { name: `{${unknown[1]}}` });
    if (p.startsWith('Too long')) return t('tooLong');
    return p;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sms-template">{t('template')}</Label>
        <textarea
          id="sms-template"
          ref={ref}
          className={textareaClass}
          value={value}
          maxLength={500}
          aria-invalid={problems.length > 0 || undefined}
          aria-describedby="sms-template-help"
          onChange={(e) => onChange(e.target.value)}
          data-testid="sms-template"
        />
      </div>
      <div id="sms-template-help" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('templateVars')}</span>
          {SMS_TEMPLATE_VARIABLES.map((v) => (
            <Button key={v} type="button" size="sm" variant="outline" onClick={() => insert(v)}>
              <span dir="ltr" className="font-mono text-xs">{`{${v}}`}</span>
              <span>{varLabel[v]}</span>
            </Button>
          ))}
          {value !== DEFAULT_ABSENT_SMS_TEMPLATE && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(DEFAULT_ABSENT_SMS_TEMPLATE)}
            >
              {t('useDefault')}
            </Button>
          )}
        </div>
        {problems.length > 0 && (
          <ul className="text-destructive text-sm" role="alert">
            {problems.map((p) => (
              <li key={p}>{message(p)}</li>
            ))}
          </ul>
        )}
      </div>
      <div
        className="bg-canvas flex flex-col gap-2 rounded-lg border p-3"
        data-testid="sms-preview"
      >
        <span className="text-muted-foreground text-xs font-medium">{t('preview')}</span>
        <p className="break-words whitespace-pre-wrap" lang="bn">
          {preview}
        </p>
        <p className="text-muted-foreground text-sm" data-testid="sms-length">
          {t('length', {
            chars: formatCount(len.length, locale),
            segments: formatCount(len.segments, locale),
          })}
        </p>
        {len.encoding === 'UCS2' && (
          <p className="text-muted-foreground text-xs">{t('unicodeNote')}</p>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── Holidays ─────────────────────────────

function Holidays() {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const { data: context } = useMeContext();
  const year = Number((context?.today ?? '').slice(0, 4)) || new Date().getFullYear();
  const key = ['attendance-holidays', session?.tenant?.id, year];
  const holidays = useQuery({
    queryKey: key,
    queryFn: () => client.api<Holiday[]>(`/attendance/holidays?year=${year}`),
  });
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (h: Omit<Holiday, 'id'>) =>
      client.api<Holiday>('/attendance/holidays', { method: 'POST', json: h }),
    onSuccess: () => {
      setAdding(false);
      refresh();
    },
    onError: (e) => toast.error(describe(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.api(`/attendance/holidays/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      refresh();
    },
    onError: (e) => toast.error(describe(e)),
  });

  return (
    <Card id="settings-holidays" title={t('holidaysTitle')} hint={t('holidaysHint')}>
      {holidays.isPending ? (
        <Skeleton className="h-24" />
      ) : holidays.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(holidays.error)}</AlertDescription>
        </Alert>
      ) : holidays.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noHolidays')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {holidays.data.map((h) => {
            const name = locale === 'bn' ? h.nameBn : h.nameEn;
            const dates =
              h.startDate === h.endDate
                ? formatDate(dateToDb(h.startDate), locale, 'long')
                : `${formatDate(dateToDb(h.startDate), locale, 'medium')} – ${formatDate(dateToDb(h.endDate), locale, 'medium')}`;
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium break-words">{name}</span>
                  <span className="text-muted-foreground text-sm">{dates}</span>
                </span>
                {confirmDelete === h.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{t('deleteHoliday', { name })}</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => remove.mutate(h.id)}
                      disabled={remove.isPending}
                    >
                      {t('delete')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>
                      {t('cancel')}
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${t('delete')}: ${name}`}
                    onClick={() => setConfirmDelete(h.id)}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <HolidayForm
          year={year}
          pending={create.isPending}
          onCancel={() => setAdding(false)}
          onSubmit={(h) => create.mutate(h)}
        />
      ) : (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => setAdding(true)}
          data-testid="add-holiday"
        >
          <PlusIcon aria-hidden />
          {t('addHoliday')}
        </Button>
      )}
    </Card>
  );
}

function HolidayForm({
  year,
  pending,
  onCancel,
  onSubmit,
}: {
  year: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (h: Omit<Holiday, 'id'>) => void;
}) {
  const t = useTranslations('attendanceSettings');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  return (
    <form
      className="bg-canvas flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        onSubmit({
          nameBn: String(d.get('nameBn')).trim(),
          nameEn: String(d.get('nameEn')).trim(),
          startDate: start,
          endDate: end || start,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="holiday-bn">{t('holidayNameBn')}</Label>
          <Input id="holiday-bn" name="nameBn" required maxLength={120} lang="bn" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="holiday-en">{t('holidayNameEn')}</Label>
          <Input id="holiday-en" name="nameEn" required maxLength={120} lang="en" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="holiday-start">{t('start')}</Label>
          <Input
            id="holiday-start"
            type="date"
            required
            min={`${year}-01-01`}
            max={`${year + 1}-12-31`}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="holiday-end">{t('end')}</Label>
          <Input
            id="holiday-end"
            type="date"
            min={start || `${year}-01-01`}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {t('add')}
        </Button>
      </div>
    </form>
  );
}

// ───────────────────────────── Section teachers ─────────────────────────────

function SectionTeachers() {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id ?? '';
  const section = label('section', 'Section', { inText: true });
  const mine = useQuery({
    queryKey: ['attendance-my-sections', tenantId],
    queryFn: () => client.api<MySectionsResponse>('/attendance/my-sections'),
  });
  const staff = useQuery({
    queryKey: ['attendance-staff', tenantId],
    queryFn: () => client.api<AttendanceStaffMember[]>('/attendance/staff'),
  });
  return (
    <Card
      id="settings-teachers"
      title={t('teachersTitle', { section })}
      hint={t('teachersHint', { section })}
    >
      {mine.isPending || staff.isPending ? (
        <Skeleton className="h-32" />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {(mine.data?.sections ?? []).map((s) => (
            <SectionTeacherRow
              key={s.id}
              sectionId={s.id}
              name={`${displayName(s.classLevel.nameBn, s.classLevel.nameEn, locale)}, ${s.name}`}
              staff={staff.data ?? []}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SectionTeacherRow({
  sectionId,
  name,
  staff,
}: {
  sectionId: string;
  name: string;
  staff: AttendanceStaffMember[];
}) {
  const t = useTranslations('attendanceSettings');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['section-teachers', session?.tenant?.id, sectionId];
  const teachers = useQuery({
    queryKey: key,
    queryFn: () => client.api<SectionTeacherEntry[]>(`/attendance/sections/${sectionId}/teachers`),
  });
  const save = useMutation({
    mutationFn: (next: { userId: string; isClassTeacher: boolean }[]) =>
      client.api<SectionTeacherEntry[]>(`/attendance/sections/${sectionId}/teachers`, {
        method: 'PUT',
        json: { teachers: next },
      }),
    onSuccess: (rows) => {
      queryClient.setQueryData(key, rows);
      void queryClient.invalidateQueries({ queryKey: ['attendance-my-sections'] });
    },
    onError: (e) => toast.error(describe(e)),
  });
  const current = teachers.data ?? [];
  const asInput = (rows: SectionTeacherEntry[]) =>
    rows.map((r) => ({ userId: r.user.id, isClassTeacher: r.isClassTeacher }));
  const available = staff.filter((m) => !current.some((c) => c.user.id === m.id));
  const items = available.map((m) => ({ value: m.id, label: displayUserName(m, locale) }));

  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-testid="section-teachers">
      <span className="font-medium break-words">{name}</span>
      <div className="flex flex-wrap items-center gap-2">
        {teachers.isPending ? (
          <Skeleton className="h-8 w-40" />
        ) : current.length === 0 ? (
          <span className="text-muted-foreground text-sm">{t('noTeachers')}</span>
        ) : (
          current.map((c) => {
            const person = displayUserName(c.user, locale);
            return (
              <span
                key={c.user.id}
                className={cn(
                  'inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg border py-0.5 pr-0.5 pl-2.5 text-sm',
                  c.isClassTeacher && 'border-primary bg-primary-soft',
                )}
              >
                <span className="min-w-0 truncate">{person}</span>
                {c.isClassTeacher ? (
                  <span className="text-accent-foreground shrink-0 text-xs font-medium">
                    ({t('classTeacher')})
                  </span>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${t('makeClassTeacher')}: ${person}`}
                    title={t('makeClassTeacher')}
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate(
                        current.map((x) => ({
                          userId: x.user.id,
                          isClassTeacher: x.user.id === c.user.id,
                        })),
                      )
                    }
                  >
                    <StarIcon aria-hidden />
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('remove', { name: person })}
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate(asInput(current.filter((x) => x.user.id !== c.user.id)))
                  }
                >
                  <XIcon aria-hidden />
                </Button>
              </span>
            );
          })
        )}
        {items.length > 0 && (
          <Select
            items={items}
            value={null}
            onValueChange={(v) =>
              v &&
              save.mutate([
                ...asInput(current),
                { userId: v, isClassTeacher: current.length === 0 },
              ])
            }
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-36"
              aria-label={`${t('addTeacher')}: ${name}`}
            >
              <PlusIcon aria-hidden className="size-4" />
              <SelectValue placeholder={t('addTeacher')} />
            </SelectTrigger>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </li>
  );
}
