'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  effectiveAdmissionFields,
  formatIdentifier,
  type AdmissionApplicationDetail,
} from '@jantrik/shared';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorCode, useCycles } from '@/components/admission/admission-kit';
import {
  ApplicationFields,
  applicationPayload,
  emptyApplication,
  localProblems,
  serverProblems,
} from '@/components/admission/application-form';
import { SectionCard, SelectField } from '@/components/form-kit';
import { ActionBar } from '@/components/form-layout';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** A walk-in or paper application typed by staff (decision P3-J). */
export default function NewApplicationPage() {
  return (
    <PageGate page="admission">
      <NewApplication />
    </PageGate>
  );
}

function NewApplication() {
  const tf = useTranslations('admissions.staff.form');
  const td = useTranslations('admissions.staff.detail');
  const ta = useTranslations('admission');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { client } = useAuth();
  const cycles = useCycles();
  const [cycleClassId, setCycleClassId] = useState('');
  const [values, setValues] = useState(emptyApplication);
  const [touched, setTouched] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      client.api<AdmissionApplicationDetail>('/admission/applications', {
        method: 'POST',
        json: { cycleClassId, ...applicationPayload(values) },
      }),
    onSuccess: (a) => {
      void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
      void queryClient.invalidateQueries({ queryKey: ['admission-cycles'] });
      toast.success(tf('created', { no: formatIdentifier(a.applicationNo) }));
      router.push(`/admission/applications/${a.id}`);
    },
    onError: (e) => {
      const code = errorCode(e);
      if (code === 'ADMISSION_DUPLICATE') {
        const no = (e as ApiError).body as { applicationNo?: string } | null;
        toast.error(td('duplicate', { no: formatIdentifier(no?.applicationNo ?? '') }));
      } else if (code === 'ADMISSION_PHONE_CAP') toast.error(td('phoneCap'));
      else if (code === 'ADMISSION_FIELDS_REQUIRED') toast.error(td('fieldsRequired'));
      else if (e instanceof ApiError && (e.status === 400 || e.status === 422))
        toast.error(td('checkForm'));
      else toast.error(describe(e));
    },
  });

  if (cycles.isPending) return <Skeleton className="h-96 rounded-xl" />;
  const choices = (cycles.data ?? []).flatMap((c) =>
    c.classes.map((cc) => ({
      cycle: c,
      value: cc.id,
      label: `${displayName(c.nameBn, c.nameEn, locale)} — ${displayName(
        cc.classLevel.nameBn,
        cc.classLevel.nameEn,
        locale,
      )}${cc.studyGroup ? ` · ${displayName(cc.studyGroup.nameBn, cc.studyGroup.nameEn, locale)}` : ''}`,
    })),
  );
  if (choices.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border p-6 text-center">
        {tf('noOpenCycle')}
      </p>
    );
  }
  const chosen = choices.find((c) => c.value === cycleClassId)?.cycle ?? null;
  const settings = chosen ? effectiveAdmissionFields(chosen.fields, chosen.collectPhoto) : null;
  const local = touched ? localProblems(values, ta('errorRequired')) : {};
  const errors = {
    ...serverProblems(create.error, ta('errorInvalid'), ta('errorRequired')),
    ...local,
  };
  const blocked = !cycleClassId || Object.keys(localProblems(values, 'x')).length > 0;

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!blocked) create.mutate();
      }}
    >
      <SectionCard id="application-class" title={tf('class')}>
        <SelectField
          id="cycleClassId"
          label={tf('class')}
          value={cycleClassId}
          onChange={setCycleClassId}
          placeholder={tf('chooseClass')}
          options={choices.map(({ value, label }) => ({ value, label }))}
          error={touched && !cycleClassId ? ta('errorRequired') : errors['cycleClassId']}
          required
        />
      </SectionCard>
      <ApplicationFields values={values} onChange={setValues} errors={errors} settings={settings} />
      <ActionBar>
        <Button type="submit" disabled={create.isPending} data-testid="save-application">
          {tf('submit')}
        </Button>
      </ActionBar>
    </form>
  );
}
