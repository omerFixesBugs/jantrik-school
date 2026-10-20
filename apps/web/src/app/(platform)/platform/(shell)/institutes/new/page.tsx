'use client';

import {
  PLATFORM_MODULES,
  formatCount,
  instituteSlugSchema,
  normalizeBdPhone,
  todayIn,
  type IsoDate,
  type PlatformCreateInstituteInput,
  type PlatformInstituteOptions,
  type PlatformModule,
} from '@jantrik/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, CheckIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ChoiceChip, Field, SectionCard, SelectField, TextField } from '@/components/form-kit';
import {
  fieldErrorsOf,
  parseLimit,
  takaToPaisa,
  usePlatformError,
} from '@/components/platform/institute-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { platformApi } from '@/lib/platform/platform-api';

const PRICE_FIELDS = [
  ['corePaisa', 'CORE'],
  ['attendancePaisa', 'ATTENDANCE'],
  ['feesPaisa', 'FEES'],
  ['examsPaisa', 'EXAMS'],
] as const;

interface Form {
  name: string;
  slug: string;
  instituteTypeKey: string;
  modules: PlatformModule[];
  ownerName: string;
  ownerNameBn: string;
  ownerPhone: string;
  planName: string;
  pricing: 'PER_STUDENT' | 'FLAT';
  prices: Record<(typeof PRICE_FIELDS)[number][0] | 'flatPaisa', string>;
  cycle: 'MONTHLY' | 'YEARLY';
  yearlyDiscountPercent: string;
  dueDays: string;
  trialEndsOn: string;
  studentLimit: string;
  smsDailyCap: string;
  yearName: string;
  yearStart: string;
  yearEnd: string;
}

/** Add an institute: it starts in TRIAL, and the owner gets an invitation (no SMS is sent). */
export default function NewInstitutePage() {
  const t = useTranslations('platformInstitutes');
  const tModules = useTranslations('platformInstitutes.modules');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const queryClient = useQueryClient();
  const explain = usePlatformError();
  const year = todayIn('Asia/Dhaka').slice(0, 4);
  const [form, setForm] = useState<Form>({
    name: '',
    slug: '',
    instituteTypeKey: '',
    modules: ['ATTENDANCE'],
    ownerName: '',
    ownerNameBn: '',
    ownerPhone: '',
    planName: 'Standard',
    pricing: 'PER_STUDENT',
    prices: { corePaisa: '', attendancePaisa: '', feesPaisa: '', examsPaisa: '', flatPaisa: '' },
    cycle: 'MONTHLY',
    yearlyDiscountPercent: '0',
    dueDays: '10',
    trialEndsOn: '',
    studentLimit: '',
    smsDailyCap: '',
    yearName: year,
    yearStart: `${year}-01-01`,
    yearEnd: `${year}-12-31`,
  });
  const [problems, setProblems] = useState<Set<string>>(new Set());
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const options = useQuery({
    queryKey: ['platform-institute-options'],
    queryFn: () => platformApi<PlatformInstituteOptions>('/platform/institutes/options'),
    staleTime: 5 * 60_000,
  });

  /** The request body, or the fields that are not right yet. */
  const build = (): { body: PlatformCreateInstituteInput } | { invalid: Set<string> } => {
    const invalid = new Set<string>();
    if (form.name.trim().length < 2) invalid.add('name');
    if (!instituteSlugSchema.safeParse(form.slug).success) invalid.add('slug');
    if (!form.instituteTypeKey) invalid.add('instituteTypeKey');
    if (!form.ownerName.trim()) invalid.add('owner.name');
    const phone = normalizeBdPhone(form.ownerPhone);
    if (!phone) invalid.add('owner.phone');
    if (!form.planName.trim()) invalid.add('plan.planName');
    const price = (key: keyof Form['prices']) => {
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
    const studentLimit = parseLimit(form.studentLimit, 1);
    if (studentLimit === undefined) invalid.add('limits.studentLimit');
    const smsDailyCap = parseLimit(form.smsDailyCap, 0);
    if (smsDailyCap === undefined) invalid.add('limits.smsDailyCap');
    if (
      !form.yearName.trim() ||
      !form.yearStart ||
      !form.yearEnd ||
      form.yearEnd <= form.yearStart
    ) {
      invalid.add('academicYear');
    }
    if (invalid.size > 0) return { invalid };
    return {
      body: {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        instituteTypeKey: form.instituteTypeKey,
        modules: form.modules,
        owner: {
          phone: phone!,
          name: form.ownerName.trim(),
          nameBn: form.ownerNameBn.trim() || null,
        },
        plan: {
          planName: form.planName.trim(),
          pricing: form.pricing,
          ...prices,
          cycle: form.cycle,
          yearlyDiscountPercent: form.cycle === 'YEARLY' ? discount : 0,
          dueDays: due,
        },
        trialEndsOn: (form.trialEndsOn || null) as IsoDate | null,
        academicYear: {
          name: form.yearName.trim(),
          startDate: form.yearStart as IsoDate,
          endDate: form.yearEnd as IsoDate,
        },
        limits: { studentLimit: studentLimit ?? null, smsDailyCap: smsDailyCap ?? null },
      },
    };
  };

  const create = useMutation({
    mutationFn: (body: PlatformCreateInstituteInput) =>
      platformApi<{ id: string; name: string }>('/platform/institutes', {
        method: 'POST',
        json: body,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['platform-institutes'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-institute-options'] });
      toast.success(t('created', { name: res.name }));
      router.push(`/platform/institutes/${res.id}`);
    },
    onError: (e) => {
      setProblems(fieldErrorsOf(e));
      toast.error(explain(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = build();
    if ('invalid' in built) {
      setProblems(built.invalid);
      toast.error(t('errorCheckForm'));
      return;
    }
    setProblems(new Set());
    create.mutate(built.body);
  };
  const err = (path: string, message: string) =>
    problems.has(path) || [...problems].some((p) => p.startsWith(`${path}.`)) ? message : null;

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate data-testid="new-institute">
      <div className="flex flex-col gap-2">
        <Link
          href="/platform/institutes"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
          {t('backToList')}
        </Link>
        <h1 className="font-heading text-2xl font-semibold">{t('newTitle')}</h1>
        <p className="text-muted-foreground max-w-prose">{t('newHint')}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard id="new-institute-basics" title={t('basicsTitle')}>
          <TextField
            id="institute-name"
            label={t('name')}
            value={form.name}
            onChange={(v) => set('name', v)}
            required
            error={err('name', t('errorName'))}
            data-testid="institute-name"
          />
          <TextField
            id="institute-slug"
            label={t('slug')}
            hint={t('slugHint')}
            value={form.slug}
            onChange={(v) => set('slug', v.toLowerCase())}
            required
            dir="ltr"
            autoCapitalize="none"
            spellCheck={false}
            error={
              problems.has('slug')
                ? create.error && fieldErrorsOf(create.error).has('slug')
                  ? explain(create.error)
                  : t('errorSlug')
                : null
            }
            data-testid="institute-slug"
          />
          <SelectField
            id="institute-type-new"
            label={t('type')}
            value={form.instituteTypeKey}
            onChange={(v) => set('instituteTypeKey', v)}
            placeholder={t('choose')}
            required
            error={err('instituteTypeKey', t('errorType'))}
            options={(options.data?.types ?? []).map((x) => ({
              value: x.key,
              label: locale === 'bn' ? x.nameBn : x.nameEn,
            }))}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('modulesTitle')}</legend>
            <div className="flex flex-wrap gap-2">
              <span className="border-primary bg-primary-soft text-accent-foreground flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium">
                <CheckIcon aria-hidden className="size-4" />
                {tModules('CORE')}
                <span className="sr-only">({t('alwaysOn')})</span>
              </span>
              {PLATFORM_MODULES.map((m) => (
                <ChoiceChip
                  key={m}
                  type="checkbox"
                  name={`module-${m}`}
                  checked={form.modules.includes(m)}
                  onChange={(on) =>
                    set('modules', on ? [...form.modules, m] : form.modules.filter((x) => x !== m))
                  }
                >
                  {tModules(m)}
                </ChoiceChip>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">{t('modulesHint')}</p>
          </fieldset>
        </SectionCard>

        <SectionCard id="new-institute-owner" title={t('ownerTitle')} hint={t('ownerHint')}>
          <TextField
            id="owner-name"
            label={t('ownerName')}
            value={form.ownerName}
            onChange={(v) => set('ownerName', v)}
            required
            error={err('owner.name', t('errorRequired'))}
            data-testid="owner-name"
          />
          <TextField
            id="owner-name-bn"
            label={t('ownerNameBn')}
            value={form.ownerNameBn}
            onChange={(v) => set('ownerNameBn', v)}
            lang="bn"
          />
          <TextField
            id="owner-phone"
            label={t('ownerPhone')}
            hint={t('ownerPhoneHint')}
            value={form.ownerPhone}
            onChange={(v) => set('ownerPhone', v)}
            required
            type="tel"
            inputMode="tel"
            dir="ltr"
            error={err('owner.phone', t('errorPhone'))}
            data-testid="owner-phone"
          />
        </SectionCard>

        <SectionCard id="new-institute-plan" title={t('planTitle')} hint={t('planHint')}>
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
        </SectionCard>

        <SectionCard id="new-institute-limits" title={t('trialLimitsTitle')}>
          <Field id="trial-ends" label={t('trialEndsOn')} hint={t('trialEndsHint')}>
            <Input
              id="trial-ends"
              type="date"
              value={form.trialEndsOn}
              onChange={(e) => set('trialEndsOn', e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              id="student-limit"
              label={t('studentLimit')}
              hint={t('noLimitHint')}
              value={form.studentLimit}
              onChange={(v) => set('studentLimit', v)}
              inputMode="numeric"
              error={err('limits.studentLimit', t('errorLimit'))}
            />
            <TextField
              id="sms-cap"
              label={t('smsDailyCap')}
              hint={t('noLimitHint')}
              value={form.smsDailyCap}
              onChange={(v) => set('smsDailyCap', v)}
              inputMode="numeric"
              error={err('limits.smsDailyCap', t('errorLimit'))}
            />
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t('firstYear')}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                id="year-name"
                label={t('yearName')}
                value={form.yearName}
                onChange={(v) => set('yearName', v)}
              />
              <Field id="year-start" label={t('yearStart')}>
                <Input
                  id="year-start"
                  type="date"
                  value={form.yearStart}
                  onChange={(e) => set('yearStart', e.target.value)}
                />
              </Field>
              <Field id="year-end" label={t('yearEnd')}>
                <Input
                  id="year-end"
                  type="date"
                  value={form.yearEnd}
                  onChange={(e) => set('yearEnd', e.target.value)}
                />
              </Field>
            </div>
            {problems.has('academicYear') && (
              <p className="text-destructive text-sm" role="alert">
                {t('errorYear')}
              </p>
            )}
          </fieldset>
        </SectionCard>
      </div>

      {create.isError && (
        <Alert variant="destructive">
          <AlertDescription>{explain(create.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={create.isPending} data-testid="create-institute">
          {t('create')}
        </Button>
        <p className="text-muted-foreground text-sm">
          {t('createNote', { days: formatCount(14, locale) })}
        </p>
      </div>
    </form>
  );
}

/** A taka amount (up to 2 decimals). */
function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
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
        />
      </div>
    </Field>
  );
}
