'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  formatTaka,
  formatTime,
  type BroadcastView,
} from '@jantrik/shared';
import { ArrowLeftIcon, BanIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { SectionCard } from '@/components/form-kit';
import { BroadcastComposer } from '@/components/notices/broadcast-composer';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { BROADCAST_STATUS_VARIANT } from '@/lib/notices';

/** One broadcast: a draft opens in the composer; otherwise its status and live SMS counts. */
export default function BroadcastPage() {
  const t = useTranslations('notices.broadcasts');
  const tErr = useTranslations('notices.broadcasts.errors');
  const describe = useErrorMessage();
  const locale = useLocale() as Locale;
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['broadcasts', session?.tenant?.id, id];
  const broadcast = useQuery({
    queryKey: key,
    queryFn: () => client.api<BroadcastView>(`/broadcasts/${id}`),
    // While it is being sent, the counts move: refresh every few seconds.
    refetchInterval: (q) =>
      q.state.data?.status === 'SENT' && q.state.data.sms.queued > 0 ? 5000 : false,
  });
  const cancel = useMutation({
    mutationFn: () =>
      client.api<BroadcastView>(`/broadcasts/${id}/cancel`, { method: 'POST', json: {} }),
    onSuccess: async (b) => {
      toast.success(t('cancelled'));
      queryClient.setQueryData(key, b);
      await queryClient.invalidateQueries({ queryKey: ['broadcasts', session?.tenant?.id] });
    },
  });

  if (!broadcast.data) {
    return (
      <PageGate page="broadcasts">
        <Skeleton className="h-64" />
      </PageGate>
    );
  }
  const b = broadcast.data;
  if (b.status === 'DRAFT') {
    return (
      <PageGate page="broadcasts">
        <BroadcastComposer broadcast={b} />
      </PageGate>
    );
  }
  const when = (iso: string) => ({ date: formatDate(iso, locale), time: formatTime(iso, locale) });
  return (
    <PageGate page="broadcasts">
      <SectionCard
        id="broadcast"
        title={t('title')}
        actions={
          <ButtonLink variant="ghost" href="/broadcasts">
            <ArrowLeftIcon aria-hidden />
            {t('back')}
          </ButtonLink>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={BROADCAST_STATUS_VARIANT[b.status]} data-testid="broadcast-status">
            {t(`status.${b.status}`)}
          </Badge>
          <span className="text-muted-foreground text-sm">{t(`recipients.${b.recipients}`)}</span>
        </div>
        <p className="break-words whitespace-pre-line">{b.body}</p>
        <p className="text-muted-foreground text-sm">
          {b.status === 'SCHEDULED' && b.scheduledAt && t('scheduledFor', when(b.scheduledAt))}
          {b.status === 'SENT' && b.sentAt && t('sentAt', when(b.sentAt))}
        </p>
        {b.status === 'SENT' && (
          <p className="text-sm" data-testid="broadcast-counts">
            {t('counts', {
              sent: formatCount(b.sms.sent, locale),
              queued: formatCount(b.sms.queued, locale),
              failed: formatCount(b.sms.failed, locale),
            })}
            {b.estimatedCostPaisa !== null && ` · ${formatTaka(b.estimatedCostPaisa, locale)}`}
          </p>
        )}
        {b.status === 'FAILED_OVER_CAP' && b.failure && (
          <Alert variant="destructive">
            <AlertDescription>{t('alert.FAILED_OVER_CAP')}</AlertDescription>
          </Alert>
        )}
        {cancel.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {cancel.error instanceof ApiError && cancel.error.code && tErr.has(cancel.error.code)
                ? tErr(cancel.error.code)
                : describe(cancel.error)}
            </AlertDescription>
          </Alert>
        )}
        {b.status === 'SCHEDULED' && (
          <Button
            variant="destructive"
            className="self-start"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            data-testid="broadcast-cancel"
          >
            <BanIcon aria-hidden />
            {t('cancel')}
          </Button>
        )}
      </SectionCard>
    </PageGate>
  );
}
