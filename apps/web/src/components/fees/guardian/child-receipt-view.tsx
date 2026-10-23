'use client';

import { useQuery } from '@tanstack/react-query';
import type { FeeReceipt } from '@jantrik/shared';
import { ArrowLeftIcon, PrinterIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Receipt, type ReceiptPaper } from '@/components/fees/receipt';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { GuardianNotice } from './guardian-gate';

/** One of the child's receipts (GET /me/children/:id/fees/payments/:paymentId), to print. */
export function ChildReceiptView({ childId, paymentId }: { childId: string; paymentId: string }) {
  const t = useTranslations('fees.guardian.receipt');
  const tReceipt = useTranslations('fees.common.receipt');
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const [paper, setPaper] = useState<ReceiptPaper>('a5');
  const q = useQuery({
    queryKey: ['child-receipt', session?.tenant?.id, childId, paymentId],
    queryFn: () => client.api<FeeReceipt>(`/me/children/${childId}/fees/payments/${paymentId}`),
    enabled: Boolean(childId && paymentId),
  });

  return (
    <div
      className="flex min-w-0 flex-col gap-(--section-gap)"
      data-testid="child-receipt-page"
      aria-busy={q.isPending || undefined}
    >
      <ButtonLink
        variant="ghost"
        size="sm"
        href={`/children/${childId}/fees`}
        className="-ms-2 self-start"
        data-testid="child-receipt-back"
      >
        <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
        {t('back')}
      </ButtonLink>

      {q.isPending ? (
        <Skeleton className="mx-auto h-112 w-full max-w-[148mm]" aria-label={tCommon('loading')} />
      ) : q.isError ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <GuardianNotice icon={SearchXIcon} title={t('title')} text={t('notFound')} />
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="text-destructive flex flex-wrap items-center justify-between gap-2">
              {describe(q.error)}
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                {tCommon('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">
              {t('title')}{' '}
              <span className="font-mono text-xl font-medium" dir="ltr">
                {q.data.receiptNumber}
              </span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                value={paper}
                onChange={setPaper}
                label={tReceipt('paper')}
                options={[
                  { value: 'a5', label: tReceipt('paperA5') },
                  { value: '80', label: tReceipt('paper80') },
                ]}
                testId="receipt-paper"
              />
              <Button onClick={() => window.print()} data-testid="receipt-print">
                <PrinterIcon aria-hidden />
                {t('print')}
              </Button>
            </div>
          </div>
          {/* The receipt is paper: black on white in every theme, as it prints. */}
          <Receipt receipt={q.data} paper={paper} />
        </>
      )}
    </div>
  );
}
