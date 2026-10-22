'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  addMonths,
  formatDate,
  formatMonth,
  formatTaka,
  receiptSmsText,
  toAsciiDigits,
  type FeeAmountType,
  type FeeSettingsInput,
  type FeeSettingsView,
} from '@jantrik/shared';
import { InfoIcon, MessageSquareTextIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChoiceChip, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { ActionBar } from '@/components/form-layout';
import { MoneyField } from '@/components/fees/money-field';
import { Pill } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { DuesJobButton } from './dues-actions';
import {
  LoadError,
  localDigits,
  NativeSelect,
  parseWhole,
  SettingRow,
  Switch,
  useFeeMutation,
  useFeeQuery,
  useOrdinal,
} from './kit';

const NOTE_MAX = 200;

interface Form {
  /** 'YYYY-MM', or '' for "not yet". */
  duesFrom: string;
  receiptSmsEnabled: boolean;
  siblingOn: boolean;
  siblingType: FeeAmountType;
  /** As typed (Bangla or ASCII digits). */
  siblingPercent: string;
  siblingFixedPaisa: number | null;
  fromChild: number;
  receiptNote: string;
}

const toForm = (s: FeeSettingsView, locale: string): Form => ({
  duesFrom: s.duesFrom ? s.duesFrom.slice(0, 7) : '',
  receiptSmsEnabled: s.receiptSmsEnabled,
  siblingOn: s.sibling !== null,
  siblingType: s.sibling?.type ?? 'PERCENT',
  siblingPercent: s.sibling?.type === 'PERCENT' ? localDigits(String(s.sibling.value), locale) : '',
  siblingFixedPaisa: s.sibling?.type === 'FIXED' ? s.sibling.value : null,
  fromChild: s.sibling?.fromChild ?? 2,
  receiptNote: s.receiptNote ?? '',
});

/** What decides "unsaved": the form with typed digits made comparable. */
const canon = (f: Form) =>
  JSON.stringify({
    ...f,
    siblingPercent:
      f.siblingOn && f.siblingType === 'PERCENT' ? toAsciiDigits(f.siblingPercent.trim()) : '',
    siblingFixedPaisa: f.siblingOn && f.siblingType === 'FIXED' ? f.siblingFixedPaisa : null,
    fromChild: f.siblingOn ? f.fromChild : 2,
    siblingType: f.siblingOn ? f.siblingType : 'PERCENT',
    receiptNote: f.receiptNote.trim(),
  });

/** Start and general settings: when dues start, receipt SMS, the sibling rule, the receipt note. */
export function GeneralSection() {
  const t = useTranslations('fees.setup.general');
  const locale = useLocale() as Locale;
  const settings = useFeeQuery<FeeSettingsView>('/fees/settings');
  return (
    <>
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
      </header>
      {settings.isPending ? (
        <Skeleton className="h-112 rounded-xl" />
      ) : settings.isError ? (
        <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsForm key={JSON.stringify(settings.data) + locale} initial={settings.data} />
      )}
    </>
  );
}

function SettingsForm({ initial }: { initial: FeeSettingsView }) {
  const t = useTranslations('fees.setup.general');
  const tKit = useTranslations('fees.setup.kit');
  const locale = useLocale() as Locale;
  const ordinal = useOrdinal();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const { data: context } = useMeContext();
  const [form, setForm] = useState<Form>(() => toForm(initial, locale));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = canon(form) !== canon(toForm(initial, locale));

  // ── Checks (the API checks again).
  const percent = parseWhole(form.siblingPercent);
  const percentError =
    form.siblingOn &&
    form.siblingType === 'PERCENT' &&
    (percent === null || percent < 1 || percent > 100)
      ? t('sibling.percentError')
      : null;
  const fixedError =
    form.siblingOn && form.siblingType === 'FIXED' && (form.siblingFixedPaisa ?? 0) < 1
      ? t('sibling.fixedError')
      : null;
  const noteError = form.receiptNote.trim().length > NOTE_MAX ? t('receipt.noteTooLong') : null;
  const valid = !percentError && !fixedError && !noteError;

  const save = useFeeMutation(
    (body: FeeSettingsInput) =>
      client.api<FeeSettingsView>('/fees/settings', { method: 'PUT', json: body }),
    {
      success: t('saved'),
      onSuccess: (next) =>
        queryClient.setQueryData(['fees-setup', session?.tenant?.id, '/fees/settings'], next),
    },
  );
  const submit = () => {
    setTried(true);
    if (!valid) return;
    save.mutate({
      duesFrom: form.duesFrom ? `${form.duesFrom}-01` : null,
      receiptSmsEnabled: form.receiptSmsEnabled,
      sibling: form.siblingOn
        ? {
            type: form.siblingType,
            value: form.siblingType === 'PERCENT' ? percent! : form.siblingFixedPaisa!,
            fromChild: form.fromChild,
          }
        : null,
      receiptNote: form.receiptNote.trim() || null,
    });
  };

  // ── The months offered: two years back to a year ahead, and whatever is saved.
  const today = context?.today ?? new Date().toISOString().slice(0, 10);
  const yearStart = context?.academicYear?.startDate.slice(0, 7) ?? null;
  const months = Array.from({ length: 37 }, (_, i) => addMonths(today.slice(0, 7), i - 24));
  if (form.duesFrom && !months.includes(form.duesFrom)) months.push(form.duesFrom);
  months.sort();
  const monthOptions = [
    { value: '', label: t('dues.notYet') },
    ...months.map((m) => ({
      value: m,
      label:
        m === yearStart
          ? t('dues.yearStart', { month: formatMonth(m, locale) })
          : formatMonth(m, locale),
    })),
  ];

  const sample = receiptSmsText({
    institute: context?.tenant.name ?? '',
    student: t('receipt.sampleStudent'),
    amountPaisa: 150_000,
    receiptNumber: `${today.slice(0, 4)}-000123`,
    date: formatDate(today, 'bn'),
    balancePaisa: 0,
  });

  const siblingSummary = !form.siblingOn
    ? null
    : form.siblingType === 'PERCENT'
      ? percent !== null && !percentError
        ? t('sibling.summaryPercent', {
            from: ordinal(form.fromChild),
            value: localDigits(String(percent), locale),
          })
        : null
      : form.siblingFixedPaisa
        ? t('sibling.summaryFixed', {
            from: ordinal(form.fromChild),
            amount: formatTaka(form.siblingFixedPaisa, locale),
          })
        : null;

  return (
    <>
      <form
        className="flex flex-col gap-(--section-gap)"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
        data-testid="fees-settings-form"
      >
        {!initial.saved && (
          <p
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="fees-settings-unsaved"
          >
            <Pill tone="info">
              <InfoIcon aria-hidden className="size-3.5" />
              {t('notSavedYet')}
            </Pill>
            <span className="text-muted-foreground">{t('notSavedYetText')}</span>
          </p>
        )}

        <SectionCard id="fees-settings-dues" title={t('dues.title')}>
          <SettingRow
            id="fees-dues-from-row"
            label={t('dues.label')}
            labelFor="fees-dues-from"
            hint={t('dues.hint')}
          >
            <NativeSelect
              id="fees-dues-from"
              value={form.duesFrom}
              onChange={(v) => set('duesFrom', v)}
              options={monthOptions}
              aria-describedby="fees-dues-from-row-hint"
              className="sm:max-w-xs"
            />
            {form.duesFrom === '' && (
              <p className="text-muted-foreground mt-2 text-sm">{t('dues.notYetNote')}</p>
            )}
          </SettingRow>
        </SectionCard>

        <SectionCard id="fees-settings-receipt" title={t('receipt.title')}>
          <div className="flex flex-col gap-4">
            <SettingRow
              id="fees-receipt-sms-row"
              label={t('receipt.smsLabel')}
              hint={t('receipt.smsHint')}
            >
              <div className="flex flex-col gap-3">
                <Switch
                  id="fees-receipt-sms"
                  checked={form.receiptSmsEnabled}
                  onChange={(v) => set('receiptSmsEnabled', v)}
                  labelledBy="fees-receipt-sms-row-label"
                  describedBy="fees-receipt-sms-row-hint"
                  testId="fees-receipt-sms"
                />
                {form.receiptSmsEnabled && (
                  <figure className="bg-muted flex gap-2 rounded-xl p-3 text-sm">
                    <MessageSquareTextIcon
                      aria-hidden
                      className="text-muted-foreground mt-0.5 size-4 shrink-0"
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <figcaption className="text-muted-foreground text-xs">
                        {t('receipt.sample')}
                      </figcaption>
                      <p lang="bn" className="wrap-break-word">
                        {sample}
                      </p>
                    </div>
                  </figure>
                )}
              </div>
            </SettingRow>
            <SettingRow
              id="fees-receipt-note-row"
              label={t('receipt.noteLabel')}
              labelFor="fees-receipt-note"
              hint={t('receipt.noteHint')}
            >
              <textarea
                id="fees-receipt-note"
                value={form.receiptNote}
                onChange={(e) => set('receiptNote', e.target.value)}
                rows={3}
                maxLength={NOTE_MAX + 50}
                aria-invalid={noteError ? true : undefined}
                aria-describedby="fees-receipt-note-count fees-receipt-note-row-hint"
                placeholder={t('receipt.notePlaceholder')}
                className="border-input bg-card focus-visible:border-ring focus-visible:ring-ring/40 aria-invalid:border-destructive min-h-24 w-full min-w-0 rounded-md border px-2.5 py-2 text-(length:--input-fs) outline-none focus-visible:ring-3"
                data-testid="fees-receipt-note"
              />
              <p
                id="fees-receipt-note-count"
                className={
                  noteError ? 'text-destructive mt-1 text-sm' : 'text-muted-foreground mt-1 text-sm'
                }
                aria-live="polite"
              >
                {noteError ??
                  t('receipt.noteCount', {
                    used: localDigits(String(form.receiptNote.trim().length), locale),
                    max: localDigits(String(NOTE_MAX), locale),
                  })}
              </p>
            </SettingRow>
          </div>
        </SectionCard>

        <SectionCard id="fees-settings-sibling" title={t('sibling.title')}>
          <SettingRow id="fees-sibling-row" label={t('sibling.label')} hint={t('sibling.hint')}>
            <div className="flex flex-col gap-4">
              <Switch
                id="fees-sibling-on"
                checked={form.siblingOn}
                onChange={(v) => set('siblingOn', v)}
                labelledBy="fees-sibling-row-label"
                describedBy="fees-sibling-row-hint"
                testId="fees-sibling-on"
              />
              {form.siblingOn && (
                <div className="flex flex-col gap-4">
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1.5 text-sm font-medium">{t('sibling.type')}</legend>
                    <div className="flex flex-wrap gap-2">
                      <ChoiceChip
                        type="radio"
                        name="fees-sibling-type"
                        checked={form.siblingType === 'PERCENT'}
                        onChange={() => set('siblingType', 'PERCENT')}
                      >
                        {t('sibling.percent')}
                      </ChoiceChip>
                      <ChoiceChip
                        type="radio"
                        name="fees-sibling-type"
                        checked={form.siblingType === 'FIXED'}
                        onChange={() => set('siblingType', 'FIXED')}
                      >
                        {t('sibling.fixed')}
                      </ChoiceChip>
                    </div>
                  </fieldset>
                  <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    {form.siblingType === 'PERCENT' ? (
                      <TextField
                        id="fees-sibling-percent"
                        label={t('sibling.percentLabel')}
                        value={form.siblingPercent}
                        onChange={(v) => set('siblingPercent', v)}
                        inputMode="numeric"
                        autoComplete="off"
                        className="tabular-nums"
                        error={tried || form.siblingPercent ? percentError : null}
                        data-testid="fees-sibling-percent"
                      />
                    ) : (
                      <MoneyField
                        id="fees-sibling-fixed"
                        label={t('sibling.fixedLabel')}
                        valuePaisa={form.siblingFixedPaisa}
                        onChange={(p) => set('siblingFixedPaisa', p)}
                        error={tried ? fixedError : null}
                        testId="fees-sibling-fixed"
                      />
                    )}
                    <SelectField
                      id="fees-sibling-from"
                      label={t('sibling.fromLabel')}
                      value={String(form.fromChild)}
                      onChange={(v) => set('fromChild', Number(v))}
                      options={Array.from({ length: 9 }, (_, i) => ({
                        value: String(i + 2),
                        label: t('sibling.fromOption', { ordinal: ordinal(i + 2) }),
                      }))}
                    />
                  </div>
                  {siblingSummary && (
                    <p className="bg-primary-soft text-accent-foreground rounded-xl px-3 py-2 text-sm">
                      {siblingSummary}
                    </p>
                  )}
                </div>
              )}
            </div>
          </SettingRow>
        </SectionCard>

        <ActionBar
          note={dirty ? tKit('unsaved') : undefined}
          className="sm:mx-0 sm:rounded-xl sm:border"
        >
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setForm(toForm(initial, locale));
              setTried(false);
            }}
          >
            {tKit('cancel')}
          </Button>
          <Button
            type="submit"
            disabled={(!dirty && initial.saved) || save.isPending}
            data-testid="fees-settings-save"
          >
            {tKit('save')}
          </Button>
        </ActionBar>
      </form>
      <DuesJobs dirty={dirty} initial={initial} />
    </>
  );
}

/** Generate now / recalculate: what the saved setup produces, so not while changes are unsaved. */
function DuesJobs({ dirty, initial }: { dirty: boolean; initial: FeeSettingsView }) {
  const t = useTranslations('fees.setup.dues');
  const started = initial.saved && initial.duesFrom !== null;
  return (
    <SectionCard id="fees-dues-jobs" title={t('title')} hint={t('intro')}>
      <div className="flex flex-col gap-4">
        <SettingRow id="fees-generate-row" label={t('generateLabel')} hint={t('generateHint')}>
          <div className="flex flex-col items-start gap-2">
            <DuesJobButton kind="generate" disabled={dirty || !started} />
            {(dirty || !started) && (
              <p className="text-muted-foreground text-sm">
                {dirty ? t('saveFirst') : t('setStartFirst')}
              </p>
            )}
          </div>
        </SettingRow>
        <SettingRow
          id="fees-recalculate-row"
          label={t('recalculateLabel')}
          hint={t('recalculateHint')}
        >
          <div className="flex flex-col items-start gap-2">
            <DuesJobButton kind="recalculate" disabled={dirty || !started} />
            {(dirty || !started) && (
              <p className="text-muted-foreground text-sm">
                {dirty ? t('saveFirst') : t('setStartFirst')}
              </p>
            )}
          </div>
        </SettingRow>
      </div>
    </SectionCard>
  );
}
