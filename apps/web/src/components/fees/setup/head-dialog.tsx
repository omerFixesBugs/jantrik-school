'use client';

import {
  FEE_FINE_TYPES,
  FEE_FREQUENCIES,
  FEE_HEAD_KINDS,
  type FeeFineType,
  type FeeFrequency,
  type FeeHeadInput,
  type FeeHeadKind,
  type FeeHeadView,
} from '@jantrik/shared';
import { InfoIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChoiceChip, SelectField, TextField, ToggleField } from '@/components/form-kit';
import { MoneyField } from '@/components/fees/money-field';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { FeeDialog, fieldsFromError, localDigits, parseWhole, useFeeMutation } from './kit';

/** One fine step (flat, or per day) is at most ৳1 lakh (the API's limit). */
const FINE_STEP_MAX = 10_000_000;

interface HeadForm {
  nameBn: string;
  nameEn: string;
  kind: FeeHeadKind;
  frequency: FeeFrequency;
  dueDay: string;
  dueOffsetDays: string;
  oneTimeFrom: string;
  fineType: FeeFineType;
  fineAmountPaisa: number | null;
  fineCapPaisa: number | null;
  siblingEligible: boolean;
  sortOrder: string;
}

const toForm = (h: FeeHeadView | null, nextSort: number, locale: string): HeadForm => ({
  nameBn: h?.nameBn ?? '',
  nameEn: h?.nameEn ?? '',
  kind: h?.kind ?? 'TUITION',
  frequency: h?.frequency ?? 'MONTHLY',
  dueDay: String(h?.dueDay ?? 10),
  dueOffsetDays: localDigits(String(h?.dueOffsetDays ?? 0), locale),
  oneTimeFrom: h?.oneTimeFrom ?? '',
  fineType: h?.fine.type ?? 'NONE',
  fineAmountPaisa: h && h.fine.type !== 'NONE' ? h.fine.amountPaisa : null,
  fineCapPaisa: h?.fine.capPaisa ?? null,
  siblingEligible: h?.siblingEligible ?? false,
  sortOrder: localDigits(String(h?.sortOrder ?? nextSort), locale),
});

/** Create or change a fee head: what it is for, how often, when it falls due, the late fine. */
export function HeadDialog({
  head,
  nextSort,
  onClose,
  onSaved,
}: {
  head: FeeHeadView | null;
  nextSort: number;
  onClose: () => void;
  onSaved: (head: FeeHeadView, created: boolean) => void;
}) {
  const t = useTranslations('fees.setup.heads');
  const tCommon = useTranslations('fees.common');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [form, setForm] = useState<HeadForm>(() => toForm(head, nextSort, locale));
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Set<string>>(new Set());
  const set = <K extends keyof HeadForm>(k: K, v: HeadForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServer(new Set());
  };

  const offset = parseWhole(form.dueOffsetDays);
  const sort = parseWhole(form.sortOrder);
  const usesOffset = form.frequency === 'YEARLY' || form.frequency === 'ONE_TIME';
  const fineOn = form.fineType !== 'NONE';
  const errors: Partial<Record<string, string>> = {};
  if (!form.nameBn.trim()) errors.nameBn = t('errorRequired');
  if (!form.nameEn.trim()) errors.nameEn = t('errorRequired');
  if (usesOffset && (offset === null || offset > 365)) errors.dueOffsetDays = t('errorOffset');
  if (sort === null || sort > 9999) errors.sortOrder = t('errorSort');
  if (fineOn && (!form.fineAmountPaisa || form.fineAmountPaisa > FINE_STEP_MAX))
    errors['fine.amountPaisa'] = t('errorFineAmount');
  if (
    form.fineType === 'PER_DAY' &&
    (form.fineCapPaisa === null || form.fineCapPaisa < (form.fineAmountPaisa ?? 0))
  )
    errors['fine.capPaisa'] = t('errorFineCap');
  // What the server refused, shown on its field.
  for (const f of server) {
    if (f === 'nameBn' || f === 'nameEn') errors[f] ??= t('errorDuplicate');
    else errors[f] ??= t('errorField');
  }
  const shown = (k: string) => (tried || server.size > 0 ? (errors[k] ?? null) : null);

  const save = useFeeMutation(
    (body: FeeHeadInput) =>
      head
        ? client.api<FeeHeadView>(`/fees/heads/${head.id}`, { method: 'PATCH', json: body })
        : client.api<FeeHeadView>('/fees/heads', { method: 'POST', json: body }),
    {
      success: head ? t('saved') : t('created'),
      onSuccess: (out) => onSaved(out, !head),
      onError: (e) => setServer(fieldsFromError(e)),
    },
  );

  const submit = () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    save.mutate({
      nameBn: form.nameBn.trim(),
      nameEn: form.nameEn.trim(),
      kind: form.kind,
      frequency: form.frequency,
      dueDay: form.frequency === 'MONTHLY' ? Number(form.dueDay) : null,
      dueOffsetDays: usesOffset ? offset! : 0,
      oneTimeFrom: form.frequency === 'ONE_TIME' && form.oneTimeFrom ? form.oneTimeFrom : null,
      fine: {
        type: form.fineType,
        amountPaisa: fineOn ? form.fineAmountPaisa! : 0,
        capPaisa: form.fineType === 'PER_DAY' ? form.fineCapPaisa : null,
      },
      siblingEligible: form.siblingEligible,
      sortOrder: sort!,
    });
  };

  return (
    <FeeDialog
      onClose={onClose}
      title={
        head ? t('editTitle', { name: locale === 'bn' ? head.nameBn : head.nameEn }) : t('newTitle')
      }
      description={t('dialogHint')}
      submitLabel={head ? t('save') : t('create')}
      pending={save.isPending}
      onSubmit={submit}
      testId="fee-head-dialog"
      submitTestId="fee-head-save"
      wide
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <TextField
          id="head-name-bn"
          label={t('nameBn')}
          value={form.nameBn}
          onChange={(v) => set('nameBn', v)}
          maxLength={100}
          required
          error={shown('nameBn')}
          placeholder={t('nameBnPlaceholder')}
          data-testid="fee-head-name-bn"
        />
        <TextField
          id="head-name-en"
          label={t('nameEn')}
          value={form.nameEn}
          onChange={(v) => set('nameEn', v)}
          maxLength={100}
          required
          lang="en"
          error={shown('nameEn')}
          placeholder={t('nameEnPlaceholder')}
          data-testid="fee-head-name-en"
        />
        <SelectField
          id="head-kind"
          label={t('kind')}
          value={form.kind}
          onChange={(v) => set('kind', v as FeeHeadKind)}
          options={FEE_HEAD_KINDS.map((k) => ({ value: k, label: tCommon(`kind.${k}`) }))}
        />
        <SelectField
          id="head-frequency"
          label={t('frequency')}
          value={form.frequency}
          onChange={(v) => set('frequency', v as FeeFrequency)}
          options={FEE_FREQUENCIES.map((f) => ({ value: f, label: tCommon(`frequency.${f}`) }))}
        />

        {form.frequency === 'MONTHLY' && (
          <SelectField
            id="head-due-day"
            label={t('dueDay')}
            hint={t('dueDayHint')}
            value={form.dueDay}
            onChange={(v) => set('dueDay', v)}
            error={shown('dueDay')}
            options={Array.from({ length: 28 }, (_, i) => ({
              value: String(i + 1),
              label: t('dueDayOption', { day: localDigits(String(i + 1), locale) }),
            }))}
          />
        )}
        {usesOffset && (
          <TextField
            id="head-due-offset"
            label={form.frequency === 'YEARLY' ? t('offsetYearly') : t('offsetOneTime')}
            hint={t('offsetHint')}
            value={form.dueOffsetDays}
            onChange={(v) => set('dueOffsetDays', v)}
            inputMode="numeric"
            autoComplete="off"
            className="tabular-nums"
            error={shown('dueOffsetDays')}
          />
        )}
        {form.frequency === 'ONE_TIME' && (
          <TextField
            id="head-one-time-from"
            type="date"
            label={t('oneTimeFrom')}
            hint={t('oneTimeFromHint')}
            value={form.oneTimeFrom}
            onChange={(v) => set('oneTimeFrom', v)}
            error={shown('oneTimeFrom')}
          />
        )}
        {form.frequency === 'PER_TERM' && (
          <p className="bg-muted text-muted-foreground flex gap-2 rounded-xl p-3 text-sm sm:col-span-2">
            <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('perTermHint')}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-3 border-t pt-4">
        <legend className="sr-only">{t('fine')}</legend>
        <div className="flex flex-col gap-1">
          <span aria-hidden className="text-sm font-medium">
            {t('fine')}
          </span>
          <span className="text-muted-foreground text-sm">{t('fineHint')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {FEE_FINE_TYPES.map((f) => (
            <ChoiceChip
              key={f}
              type="radio"
              name="head-fine-type"
              checked={form.fineType === f}
              onChange={() => set('fineType', f)}
            >
              {tCommon(`fineType.${f}`)}
            </ChoiceChip>
          ))}
        </div>
        {fineOn && (
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <MoneyField
              id="head-fine-amount"
              label={form.fineType === 'FLAT' ? t('fineFlat') : t('finePerDay')}
              valuePaisa={form.fineAmountPaisa}
              onChange={(p) => set('fineAmountPaisa', p)}
              error={shown('fine.amountPaisa')}
              testId="fee-head-fine-amount"
            />
            {form.fineType === 'PER_DAY' && (
              <MoneyField
                id="head-fine-cap"
                label={t('fineCap')}
                hint={t('fineCapHint')}
                valuePaisa={form.fineCapPaisa}
                onChange={(p) => set('fineCapPaisa', p)}
                error={shown('fine.capPaisa')}
                testId="fee-head-fine-cap"
              />
            )}
          </div>
        )}
      </fieldset>

      <div className="grid gap-x-4 gap-y-3 border-t pt-4 sm:grid-cols-2">
        <ToggleField
          id="head-sibling"
          checked={form.siblingEligible}
          onChange={(v) => set('siblingEligible', v)}
          label={t('siblingEligible')}
          hint={t('siblingEligibleHint')}
        />
        <TextField
          id="head-sort"
          label={t('sortOrder')}
          hint={t('sortOrderHint')}
          value={form.sortOrder}
          onChange={(v) => set('sortOrder', v)}
          inputMode="numeric"
          autoComplete="off"
          className="tabular-nums"
          error={shown('sortOrder')}
        />
      </div>
    </FeeDialog>
  );
}
