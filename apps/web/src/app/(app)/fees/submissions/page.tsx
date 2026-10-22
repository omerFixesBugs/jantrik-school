'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FEE_SUBMISSION_STATUSES, formatCount, type FeeSubmissionView } from '@jantrik/shared';
import { InboxIcon, PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { EmptyState, LoadError } from '@/components/fees/reports/kit';
import { RecordTransfer } from '@/components/fees/reports/record-transfer';
import {
  ReceiptDialog,
  RejectDialog,
  SubmissionCard,
  submissionKeys,
  VerifyDialog,
} from '@/components/fees/reports/submissions';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useUrlParams } from '@/lib/view-state';

type Status = FeeSubmissionView['status'];

/** The API returns at most this many (the newest first, except the waiting ones). */
const LIST_LIMIT = 200;

export default function FeeSubmissionsPage() {
  return (
    <PageGate page="fees">
      {/* The status filter lives in the URL (useSearchParams). */}
      <Suspense>
        <Submissions />
      </Suspense>
    </PageGate>
  );
}

const asStatus = (v: string | null): Status | null =>
  v !== null && (FEE_SUBMISSION_STATUSES as readonly string[]).includes(v) ? (v as Status) : null;

/**
 * The bKash/Nagad review queue: the waiting transfers first (oldest first, so nobody waits
 * longest), each checked in the institute's own app and then verified or returned. Staff can
 * also record a transfer a guardian reported by phone.
 */
function Submissions() {
  const t = useTranslations('fees.reports.submissions');
  const tRecord = useTranslations('fees.reports.record');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const queryClient = useQueryClient();
  const { params, set } = useUrlParams();
  const status = asStatus(params.get('status')) ?? 'PENDING';

  const [recording, setRecording] = useState(false);
  const [verifying, setVerifying] = useState<FeeSubmissionView | null>(null);
  const [rejecting, setRejecting] = useState<FeeSubmissionView | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; receiptNumber: string } | null>(null);

  const list = useQuery({
    queryKey: submissionKeys.list(tenantId, status),
    queryFn: () =>
      client.api<FeeSubmissionView[]>(`/fees/submissions?${new URLSearchParams({ status })}`),
  });
  const items = list.data ?? [];
  const count = formatCount(items.length, locale);

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-submissions">
      <FeesTabs />

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        </div>
        {!recording && (
          <Button
            variant="outline"
            onClick={() => setRecording(true)}
            data-testid="record-transfer-open"
          >
            <PlusIcon aria-hidden />
            {tRecord('open')}
          </Button>
        )}
      </header>

      {recording && (
        <RecordTransfer
          onCancel={() => setRecording(false)}
          onDone={() => {
            setRecording(false);
            // The new transfer waits to be checked: show that list.
            set({ status: null });
            void queryClient.invalidateQueries({ queryKey: submissionKeys.all(tenantId) });
            void queryClient.invalidateQueries({ queryKey: submissionKeys.summary(tenantId) });
          }}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* Four choices may not fit a 360 px phone in Bangla: the track scrolls, never the page. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1 py-0.5">
          <SegmentedControl
            label={t('statusLabel')}
            value={status}
            onChange={(s) => set({ status: s === 'PENDING' ? null : s })}
            options={FEE_SUBMISSION_STATUSES.map((s) => ({ value: s, label: t(`filter.${s}`) }))}
            testId="submissions-status"
          />
        </div>
        {list.data && items.length > 0 && (
          <p
            className="text-muted-foreground text-sm"
            aria-live="polite"
            data-testid="result-count"
          >
            {status === 'PENDING'
              ? t('countPending', { count, n: items.length })
              : t('countOther', { count, n: items.length })}
            {items.length >= LIST_LIMIT && ` · ${t('latestOnly')}`}
          </p>
        )}
      </div>

      {list.isPending ? (
        <div
          className="grid gap-(--gap) md:grid-cols-2 2xl:grid-cols-3"
          aria-busy="true"
          aria-label={t('list')}
        >
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="rounded-card h-80" />
          ))}
        </div>
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={status === 'PENDING' ? t('emptyPending') : t('emptyOther')}
          hint={status === 'PENDING' ? t('emptyPendingHint') : t('emptyOtherHint')}
          testId="submissions-empty"
        />
      ) : (
        <ul className="grid gap-(--gap) md:grid-cols-2 2xl:grid-cols-3" aria-label={t('list')}>
          {items.map((s) => (
            <SubmissionCard
              key={s.id}
              submission={s}
              onVerify={() => setVerifying(s)}
              onReject={() => setRejecting(s)}
              onViewReceipt={() => s.receipt && setReceipt(s.receipt)}
            />
          ))}
        </ul>
      )}

      {verifying && (
        <VerifyDialog
          key={verifying.id}
          submission={verifying}
          onClose={() => setVerifying(null)}
          onReject={() => {
            setVerifying(null);
            setRejecting(verifying);
          }}
        />
      )}
      {rejecting && (
        <RejectDialog
          key={rejecting.id}
          submission={rejecting}
          onClose={() => setRejecting(null)}
        />
      )}
      {receipt && <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
