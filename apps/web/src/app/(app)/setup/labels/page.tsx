'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LABEL_KEYS, type LabelKey, type SetupLabel } from '@jantrik/shared';
import { RotateCcwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard } from '@/components/form-kit';
import { SetupPage, useSetupMutation, useSetupQuery } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { labelInText, useErrorMessage } from '@/lib/hooks';

type Values = Record<LabelKey, { bn: string; en: string }>;

/** Rename Section → Batch, Class → Course, …; a live preview shows the words in use. */
export default function LabelsPage() {
  const describe = useErrorMessage();
  const labels = useSetupQuery<SetupLabel[]>('/setup/labels');
  return (
    <SetupPage tab="labels">
      {labels.isPending ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : labels.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(labels.error)}</AlertDescription>
        </Alert>
      ) : (
        <LabelsForm initial={labels.data} />
      )}
    </SetupPage>
  );
}

function LabelsForm({ initial }: { initial: SetupLabel[] }) {
  const t = useTranslations('setup');
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(
    () => Object.fromEntries(initial.map((l) => [l.key, { bn: l.bn, en: l.en }])) as Values,
  );
  const set = (key: LabelKey, lang: 'bn' | 'en', v: string) =>
    setValues((all) => ({ ...all, [key]: { ...all[key], [lang]: v } }));
  const changed = initial.filter(
    (l) => values[l.key].bn.trim() !== l.bn || values[l.key].en.trim() !== l.en,
  );
  const invalid = LABEL_KEYS.some((k) => !values[k].bn.trim() || !values[k].en.trim());
  const save = useSetupMutation(
    () =>
      client.api('/setup/labels', {
        method: 'PUT',
        json: {
          labels: changed.map((l) => ({
            key: l.key,
            bn: values[l.key].bn.trim(),
            en: values[l.key].en.trim(),
          })),
        },
      }),
    {
      success: t('saved'),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me-context'] }),
    },
  );

  const v = (key: LabelKey, lang: 'bn' | 'en') => values[key][lang].trim() || '…';
  const inText = (key: LabelKey) => labelInText(v(key, 'en'), 'en');

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && changed.length > 0) save.mutate(undefined);
      }}
      data-testid="labels-form"
    >
      <SectionCard id="setup-labels" title={t('tabLabels')} hint={t('labelsHint')}>
        <ul className="flex flex-col divide-y rounded-lg border">
          {initial.map((l) => {
            const isDefault = values[l.key].bn === l.defaultBn && values[l.key].en === l.defaultEn;
            return (
              <li
                key={l.key}
                className="flex flex-col gap-2 px-3 py-3"
                data-testid={`label-${l.key}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t(`labelKey_${l.key}`)}</span>
                  {!isDefault && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setValues((all) => ({
                          ...all,
                          [l.key]: { bn: l.defaultBn, en: l.defaultEn },
                        }))
                      }
                    >
                      <RotateCcwIcon aria-hidden />
                      {t('resetLabel', { bn: l.defaultBn, en: l.defaultEn })}
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label={`${t(`labelKey_${l.key}`)} (${t('bangla')})`}
                    lang="bn"
                    maxLength={40}
                    required
                    value={values[l.key].bn}
                    onChange={(e) => set(l.key, 'bn', e.target.value)}
                  />
                  <Input
                    aria-label={`${t(`labelKey_${l.key}`)} (${t('english')})`}
                    lang="en"
                    maxLength={40}
                    required
                    value={values[l.key].en}
                    onChange={(e) => set(l.key, 'en', e.target.value)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard id="setup-labels-preview" title={t('preview')} hint={t('previewHint')}>
        <div className="grid gap-3 sm:grid-cols-2" data-testid="labels-preview">
          <div className="bg-canvas flex flex-col gap-1.5 rounded-lg border p-3" lang="bn">
            <span className="text-muted-foreground text-xs font-medium">{t('bangla')}</span>
            <p>{`নতুন ${v('student', 'bn')} ভর্তি করুন`}</p>
            <p>{`${v('class_level', 'bn')}: ষষ্ঠ · ${v('section', 'bn')}: ক · ${v('roll', 'bn')}: 12`}</p>
            <p>{`${v('academic_year', 'bn')} ২০২৬ · ${v('shift', 'bn')}: প্রভাতি · ${v('study_group', 'bn')}: বিজ্ঞান`}</p>
          </div>
          <div className="bg-canvas flex flex-col gap-1.5 rounded-lg border p-3" lang="en">
            <span className="text-muted-foreground text-xs font-medium">{t('english')}</span>
            <p>{`Admit a new ${inText('student')}`}</p>
            <p>{`${v('class_level', 'en')}: Six · ${v('section', 'en')}: A · ${v('roll', 'en')}: 12`}</p>
            <p>{`${v('academic_year', 'en')} 2026 · ${v('shift', 'en')}: Morning · ${v('study_group', 'en')}: Science`}</p>
          </div>
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={invalid || changed.length === 0 || save.isPending}
          data-testid="labels-save"
        >
          {t('save')}
        </Button>
        {invalid && (
          <span className="text-destructive text-sm" role="alert">
            {t('labelsRequired')}
          </span>
        )}
      </div>
    </form>
  );
}
