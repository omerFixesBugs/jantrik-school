'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatTaka, type FeeReceipt } from '@jantrik/shared';
import { ArrowLeftIcon, BanIcon, PrinterIcon, UserSearchIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { feeKeys, LoadError, StatusPill } from '@/components/fees/counter/kit';
import { ReasonDialog } from '@/components/fees/counter/reason-dialog';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { Receipt, type ReceiptPaper } from '@/components/fees/receipt';
import { PageGate } from '@/components/page-gate';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useFeeRoles } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/** The paper this browser printed on last (the counter's printer rarely changes). */
const PAPER_KEY = 'jantrik.receiptPaper';
const PAPERS: readonly ReceiptPaper[] = ['a5', '80'];

function readPaper(): ReceiptPaper {
  try {
    const saved = window.localStorage.getItem(PAPER_KEY);
    return saved === '80' ? '80' : 'a5';
  } catch {
    return 'a5';
  }
}

function savePaper(paper: ReceiptPaper) {
  try {
    window.localStorage.setItem(PAPER_KEY, paper);
  } catch {
    // Private mode or blocked storage: the choice is just not remembered.
  }
}

export default function FeeReceiptPage() {
  return (
    <PageGate page="fees">
      <div className="flex flex-col gap-(--section-gap)">
        <FeesTabs />
        <ReceiptScreen />
      </div>
    </PageGate>
  );
}

/**
 * A receipt (docs/fees.md → Receipts): the paper (A5 or 80 mm thermal, remembered here), print,
 * back to the student's fees; OWNER/ADMIN may void it with a reason, after which it says VOID.
 * Only the receipt itself prints.
 */
function ReceiptScreen() {
  const t = useTranslations('fees.counter.receipt');
  const tCommon = useTranslations('fees.common.receipt');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const { manages } = useFeeRoles();
  const { id } = useParams<{ id: string }>();
  const key = feeKeys.receipt(tenantId, id);
  const receipt = useQuery({
    queryKey: key,
    queryFn: () => client.api<FeeReceipt>(`/fees/payments/${id}`),
  });
  // Mounted on the client only (inside PageGate), so reading storage here cannot mismatch.
  const [paper, setPaper] = useState<ReceiptPaper>(readPaper);
  const [voiding, setVoiding] = useState(false);

  if (receipt.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)" aria-busy="true">
        <Skeleton className="h-(--control-h) w-full max-w-xl" />
        <Skeleton className="mx-auto h-[28rem] w-full max-w-[148mm]" />
      </div>
    );
  }
  if (receipt.isError) {
    const gone = receipt.error instanceof ApiError && receipt.error.status === 404;
    return (
      <LoadError
        message={gone ? t('notFound') : `${t('loadFailed')} ${describe(receipt.error)}`}
        onRetry={gone ? undefined : () => void receipt.refetch()}
      />
    );
  }

  const r = receipt.data;
  const isVoid = r.status === 'VOID';
  const choose = (next: ReceiptPaper) => {
    setPaper(next);
    savePaper(next);
  };

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-receipt-page">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <ButtonLink
          href={`/fees/students/${r.student.id}`}
          variant="ghost"
          size="sm"
          className="-ms-2"
          data-testid="receipt-back"
        >
          <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
          {t('back')}
        </ButtonLink>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={tCommon('paper')}
            className="bg-muted inline-flex gap-1 rounded-full p-1"
          >
            {PAPERS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={paper === p}
                onClick={() => choose(p)}
                data-testid={`receipt-paper-${p}`}
                className={cn(
                  'focus-visible:ring-ring min-h-(--control-h-sm) rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2',
                  paper === p
                    ? 'bg-card text-foreground ring-input font-semibold shadow-sm ring-1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p === 'a5' ? tCommon('paperA5') : tCommon('paper80')}
              </button>
            ))}
          </div>
          <Button onClick={() => window.print()} data-testid="receipt-print">
            <PrinterIcon aria-hidden />
            {tCommon('print')}
          </Button>
          {manages && !isVoid && (
            <Button
              variant="destructive"
              onClick={() => setVoiding(true)}
              data-testid="receipt-void-open"
            >
              <BanIcon aria-hidden />
              {t('void')}
            </Button>
          )}
        </div>
      </div>

      {isVoid && r.void && (
        <p className="flex flex-wrap items-center gap-2 text-sm print:hidden" role="status">
          <StatusPill kind="void">{tCommon('void')}</StatusPill>
          <span className="text-muted-foreground">{t('isVoid', { reason: r.void.reason })}</span>
        </p>
      )}

      <div className="min-w-0 overflow-x-auto print:overflow-visible">
        <Receipt receipt={r} paper={paper} />
      </div>

      <ButtonLink href="/fees" variant="outline" className="self-center print:hidden">
        <UserSearchIcon aria-hidden />
        {t('next')}
      </ButtonLink>

      {voiding && (
        <ReasonDialog
          open
          onOpenChange={(open) => !open && setVoiding(false)}
          title={t('voidTitle', { number: r.receiptNumber })}
          description={t('voidText', { amount: formatTaka(r.amountPaisa, locale) })}
          confirmLabel={t('voidConfirm')}
          testId="void-dialog"
          reasonTestId="void-reason"
          confirmTestId="void-confirm"
          errorText={(error) =>
            error instanceof ApiError && error.code === 'ALREADY_VOID'
              ? t('alreadyVoid')
              : describe(error)
          }
          onConfirm={async (reason) => {
            try {
              const next = await client.api<FeeReceipt>(`/fees/payments/${r.id}/void`, {
                method: 'POST',
                json: { reason },
              });
              queryClient.setQueryData(key, next);
              toast.success(t('voided', { number: r.receiptNumber }));
              setVoiding(false);
            } finally {
              // Its dues owe again, and the day's closing changes: whatever the answer was.
              void queryClient.invalidateQueries({ queryKey: key });
              void queryClient.invalidateQueries({
                queryKey: feeKeys.ledger(tenantId, r.student.id),
              });
              void queryClient.invalidateQueries({ queryKey: feeKeys.closing(tenantId) });
            }
          }}
        />
      )}
    </div>
  );
}
