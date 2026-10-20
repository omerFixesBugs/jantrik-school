'use client';

import type { PlatformPlanInput, PlatformSubscription } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { ChoiceChip, Field, TextField } from '@/components/form-kit';
import { paisaToTaka, takaToPaisa } from '@/components/platform/institute-kit';
import { Input } from '@/components/ui/input';

const PRICE_FIELDS = [
  ['corePaisa', 'CORE'],
  ['attendancePaisa', 'ATTENDANCE'],
  ['feesPaisa', 'FEES'],
  ['examsPaisa', 'EXAMS'],
] as const;
type PriceKey = (typeof PRICE_FIELDS)[number][0] | 'flatPaisa';

/** A plan as typed (taka amounts and numbers as text). */
export interface PlanForm {
  planName: string;
  pricing: 'PER_STUDENT' | 'FLAT';
  prices: Record<PriceKey, string>;
  cycle: 'MONTHLY' | 'YEARLY';
  yearlyDiscountPercent: string;
  dueDays: string;
}

export const newPlanForm = (): PlanForm => ({
  planName: 'Standard',
  pricing: 'PER_STUDENT',
  prices: { corePaisa: '', attendancePaisa: '', feesPaisa: '', examsPaisa: '', flatPaisa: '' },
  cycle: 'MONTHLY',
  yearlyDiscountPercent: '0',
  dueDays: '10',
});

export const planFormOf = (s: PlatformSubscription): PlanForm => ({
  planName: s.planName ?? 'Standard',
  pricing: s.pricing,
  prices: {
    corePaisa: paisaToTaka(s.corePaisa),
    attendancePaisa: paisaToTaka(s.attendancePaisa),
    feesPaisa: paisaToTaka(s.feesPaisa),
    examsPaisa: paisaToTaka(s.examsPaisa),
    flatPaisa: paisaToTaka(s.flatPaisa),
  },
  cycle: s.cycle,
  yearlyDiscountPercent: String(s.yearlyDiscountPercent),
  dueDays: String(s.dueDays),
});

/** The plan to send; adds the paths of fields that are not right (`plan.<field>`) to `invalid`. */
export function planFromForm(form: PlanForm, invalid: Set<string>): PlatformPlanInput {
  if (!form.planName.trim()) invalid.add('plan.planName');
  const price = (key: PriceKey) => {
    const raw = form.prices[key];
    if (raw.trim() === '') return 0;
    const paisa = takaToPaisa(raw);
    if (paisa === null) invalid.add(`plan.${key}`);
    return paisa ?? 0;
  };
  const prices =
    form.pricing === 'FLAT'
      ? { flatPaisa: price('flatPaisa') }
      : Object.fromEntries(PRICE_FIELDS.map(([key]) => [key, price(key)]));
  const discount = Number(form.yearlyDiscountPercent);
  if (!Number.isInteger(discount) || discount < 0 || discount > 100) {
    invalid.add('plan.yearlyDiscountPercent');
  }
  const due = Number(form.dueDays);
  if (!Number.isInteger(due) || due < 1 || due > 90) invalid.add('plan.dueDays');
  return {
    planName: form.planName.trim(),
    pricing: form.pricing,
    ...prices,
    cycle: form.cycle,
    yearlyDiscountPercent: form.cycle === 'YEARLY' ? discount : 0,
    dueDays: due,
  };
}

/** The plan's fields: name, pricing (per module or flat), cycle and discount, days to pay. */
export function PlanFields({
  form,
  onChange,
  err,
}: {
  form: PlanForm;
  onChange: (form: PlanForm) => void;
  /** The message when `path` (e.g. `plan.dueDays`) is not right, else null. */
  err: (path: string, message: string) => string | null;
}) {
  const t = useTranslations('platformInstitutes');
  const tModules = useTranslations('platformInstitutes.modules');
  const set = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <>
      <TextField
        id="plan-name"
        label={t('planName')}
        value={form.planName}
        onChange={(v) => set('planName', v)}
        required
        error={err('plan.planName', t('errorRequired'))}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t('pricing')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['PER_STUDENT', 'FLAT'] as const).map((p) => (
            <ChoiceChip
              key={p}
              type="radio"
              name="pricing"
              checked={form.pricing === p}
              onChange={() => set('pricing', p)}
            >
              {t(`pricing_${p}`)}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      {form.pricing === 'PER_STUDENT' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {PRICE_FIELDS.map(([key, module]) => (
            <MoneyField
              key={key}
              id={`price-${module}`}
              label={t('pricePerStudent', { module: tModules(module) })}
              value={form.prices[key]}
              onChange={(v) => set('prices', { ...form.prices, [key]: v })}
              error={err(`plan.${key}`, t('errorMoney'))}
            />
          ))}
        </div>
      ) : (
        <MoneyField
          id="price-flat"
          label={t('priceFlat')}
          value={form.prices.flatPaisa}
          onChange={(v) => set('prices', { ...form.prices, flatPaisa: v })}
          error={err('plan.flatPaisa', t('errorMoney'))}
        />
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t('cycle')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['MONTHLY', 'YEARLY'] as const).map((c) => (
            <ChoiceChip
              key={c}
              type="radio"
              name="cycle"
              checked={form.cycle === c}
              onChange={() => set('cycle', c)}
            >
              {t(`cycle_${c}`)}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {form.cycle === 'YEARLY' && (
          <TextField
            id="yearly-discount"
            label={t('yearlyDiscount')}
            hint={t('yearlyDiscountHint')}
            value={form.yearlyDiscountPercent}
            onChange={(v) => set('yearlyDiscountPercent', v)}
            inputMode="numeric"
            error={err('plan.yearlyDiscountPercent', t('errorPercent'))}
          />
        )}
        <TextField
          id="due-days"
          label={t('dueDays')}
          hint={t('dueDaysHint')}
          value={form.dueDays}
          onChange={(v) => set('dueDays', v)}
          inputMode="numeric"
          error={err('plan.dueDays', t('errorDueDays'))}
        />
      </div>
    </>
  );
}

/** A taka amount (up to 2 decimals). */
export function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  testId?: string;
}) {
  return (
    <Field id={id} label={label} error={error}>
      <div className="relative">
        <span
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
        >
          ৳
        </span>
        <Input
          id={id}
          className="pl-7"
          inputMode="decimal"
          dir="ltr"
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          data-testid={testId}
        />
      </div>
    </Field>
  );
}
