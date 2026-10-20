'use client';

import { formatDate, formatTime, type PlatformSettings } from '@jantrik/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/form-kit';
import { paisaToTaka, takaToPaisa, usePlatformError } from '@/components/platform/institute-kit';
import { MoneyField } from '@/components/platform/plan-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { platformApi } from '@/lib/platform/platform-api';

/** Platform settings: what one SMS segment costs Jantrik (audited). */
export default function PlatformSettingsPage() {
  const t = useTranslations('platformSettings');
  const explain = usePlatformError();
  const q = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => platformApi<PlatformSettings>('/platform/settings'),
  });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground max-w-prose">{t('hint')}</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : q.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{explain(q.error)}</AlertDescription>
        </Alert>
      ) : (
        <SmsCost settings={q.data} />
      )}
    </div>
  );
}

function SmsCost({ settings }: { settings: PlatformSettings }) {
  const t = useTranslations('platformSettings');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(paisaToTaka(settings.smsCostPerSegmentPaisa));
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (paisa: number) =>
      platformApi<PlatformSettings>('/platform/settings', {
        method: 'PUT',
        json: { smsCostPerSegmentPaisa: paisa },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(['platform-settings'], next);
      void queryClient.invalidateQueries({ queryKey: ['platform-usage'] });
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(explain(e)),
  });
  const updated = new Date(settings.updatedAt);
  return (
    <SectionCard id="settings-sms-cost" title={t('smsCostTitle')} hint={t('smsCostHint')}>
      <form
        className="flex flex-col gap-3 sm:max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const paisa = takaToPaisa(value);
          const ok = paisa !== null && paisa <= 10_000;
          setInvalid(!ok);
          if (ok) save.mutate(paisa!);
        }}
      >
        <MoneyField
          id="sms-cost"
          label={t('smsCost')}
          value={value}
          onChange={setValue}
          error={invalid ? t('errorCost') : null}
          testId="sms-cost"
        />
        <Button
          type="submit"
          className="w-fit"
          disabled={save.isPending}
          data-testid="save-sms-cost"
        >
          {t('save')}
        </Button>
      </form>
      <p className="text-muted-foreground text-sm" data-testid="settings-updated">
        {settings.updatedBy
          ? t('updatedBy', {
              name: settings.updatedBy,
              date: `${formatDate(updated, locale, 'medium')} · ${formatTime(updated, locale)}`,
            })
          : t('updatedDefault')}
      </p>
    </SectionCard>
  );
}
