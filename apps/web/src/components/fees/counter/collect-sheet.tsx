'use client';

import { useMutation } from '@tanstack/react-query';
import {
  allocate,
  formatCount,
  formatTaka,
  type CollectFeeInput,
  type FeeReceipt,
  type IsoDate,
} from '@jantrik/shared';
import { BanknoteIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { MoneyField } from '@/components/fees/money-field';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { Locale } from '@/i18n/config';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { randomId } from '@/lib/uuid';

/** One chosen due (or period paid ahead) as the preview needs it. */
export interface CollectItem {
  key: string;
  label: string;
  dueDate: IsoDate;
  /** The ledger's own order (due date, then the head's order): ties in allocation follow it. */
  order: number;
  principal: number;
  fine: number;
}

type Body = Omit<CollectFeeInput, 'clientRequestId'>;
type Attempt = { key: string; id: string } | null;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Taking cash for the chosen dues (docs/fees.md → Collecting cash), in a bottom sheet: the amount
 * (the whole total by default; less is allowed, never more), where it will go (principal oldest
 * first, then fines: the API's own `allocate`), cash as the method, and confirm.
 *
 * Every attempt carries a `clientRequestId`. A request that may have reached the server (no
 * answer, or a 5xx) is retried with the **same** id, so the API answers with the receipt it
 * already made instead of taking the money twice; any other answer ends the attempt.
 */
export function CollectSheet({
  open,
  onOpenChange,
  studentId,
  studentName,
  dueIds,
  advance,
  items,
  total,
  onStale,
  onCollected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentId: string;
  studentName: string;
  dueIds: string[];
  advance: { headId: string; periodKey: string }[];
  items: CollectItem[];
  /** What the chosen dues owe now (sent as `expectedOutstandingPaisa`). */
  total: number;
  /** The ledger moved on the server: load it again. */
  onStale: () => void;
  onCollected: (receipt: FeeReceipt) => void;
}) {
  const t = useTranslations('fees.counter.collect');
  const locale = useLocale() as Locale;
  // Outlives the sheet closing: reopening after a lost answer still retries the same attempt.
  const attempt = useRef<Attempt>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-card mx-auto max-h-[92dvh] w-full max-w-xl gap-0 overflow-y-auto"
        data-testid="fees-collect-sheet"
      >
        <SheetHeader className="pe-12">
          <SheetTitle className="text-lg">{t('title')}</SheetTitle>
          <SheetDescription>
            {t('description', {
              name: studentName,
              count: formatCount(items.length, locale),
              n: items.length,
              total: formatTaka(total, locale),
            })}
          </SheetDescription>
        </SheetHeader>
        {/* Mounted while open: every opening starts from the chosen total. */}
        <CollectForm
          body={{ studentId, dueIds, advance, amountPaisa: 0, expectedOutstandingPaisa: total }}
          items={items}
          total={total}
          attemptRef={attempt}
          onStale={onStale}
          onCollected={onCollected}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

function CollectForm({
  body,
  items,
  total,
  attemptRef,
  onStale,
  onCollected,
  onCancel,
}: {
  body: Body;
  items: CollectItem[];
  total: number;
  attemptRef: RefObject<Attempt>;
  onStale: () => void;
  onCollected: (receipt: FeeReceipt) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('fees.counter.collect');
  const tMethod = useTranslations('fees.common.method');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client } = useAuth();
  const taka = (paisa: number) => formatTaka(paisa, locale);

  const [amount, setAmount] = useState<number | null>(total);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // When the total moves under the sheet (the ledger was reloaded), a full payment follows it;
  // a partial amount the person typed stays (react.dev: adjusting state while rendering).
  const [seenTotal, setSeenTotal] = useState(total);
  if (total !== seenTotal) {
    setSeenTotal(total);
    if (amount === seenTotal) setAmount(total);
  }

  const tooMuch = amount !== null && amount > total;
  const missing = amount === null || amount < 1;
  const amountError = tooMuch
    ? t('amountTooMuch', { total: taka(total) })
    : tried && missing
      ? t('amountMissing')
      : null;

  const problemText = (error: unknown): string => {
    if (error instanceof NetworkError) return t('network');
    if (!(error instanceof ApiError)) return describe(error);
    const owed = (error.body as { outstandingPaisa?: unknown } | undefined)?.outstandingPaisa;
    const owedText = typeof owed === 'number' ? taka(owed) : '—';
    const stale: Record<string, string> = {
      DUES_CHANGED: t('duesChanged', { total: owedText }),
      AMOUNT_EXCEEDS_DUE: t('exceeds', { total: owedText }),
      NOTHING_DUE: t('nothingDue'),
      IDEMPOTENCY_MISMATCH: t('idempotency'),
      INVALID_ADVANCE: t('invalidAdvance'),
    };
    const known = error.code ? stale[error.code] : undefined;
    if (known || error.status === 404) {
      onStale();
      return known ?? t('notFound');
    }
    return describe(error);
  };

  const send = useMutation({
    mutationFn: async (payload: Body) => {
      const key = JSON.stringify(payload);
      if (attemptRef.current?.key !== key) attemptRef.current = { key, id: randomId() };
      const json = { ...payload, clientRequestId: attemptRef.current.id };
      for (let retry = 0; ; retry++) {
        try {
          return await client.api<FeeReceipt>('/fees/payments', { method: 'POST', json });
        } catch (error) {
          if (error instanceof NetworkError && retry < 2) {
            await wait(1000 * (retry + 1));
            continue;
          }
          throw error;
        }
      }
    },
    onSuccess: (receipt) => {
      attemptRef.current = null;
      onCollected(receipt);
    },
    onError: (error) => {
      const unknownOutcome =
        error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
      if (!unknownOutcome) attemptRef.current = null;
      setProblem(problemText(error));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (missing || tooMuch || send.isPending || amount === null) return;
    setProblem(null);
    send.mutate({ ...body, amountPaisa: amount, expectedOutstandingPaisa: total });
  };

  // Where the money goes, as the API will allocate it.
  const valid = !missing && !tooMuch && amount !== null;
  const allocations = valid
    ? allocate(
        items.map((i) => ({
          id: i.key,
          dueDate: i.dueDate,
          sortOrder: i.order,
          principal: i.principal,
          fine: i.fine,
        })),
        amount,
      )
    : [];
  const applied = new Map(allocations.map((a) => [a.dueId, a]));
  const ordered = [...items].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.order - b.order,
  );

  return (
    <form className="flex flex-col" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-4 px-4 pb-2">
        <MoneyField
          id="fees-collect-amount"
          label={t('amount')}
          valuePaisa={amount}
          onChange={(paisa) => {
            setAmount(paisa);
            setProblem(null);
          }}
          hint={t('amountHint')}
          error={amountError}
          required
          testId="fees-amount"
        />

        {valid && (
          <section aria-labelledby="fees-collect-preview" className="flex flex-col gap-2">
            <h3 id="fees-collect-preview" className="text-sm font-medium">
              {t('preview')}
            </h3>
            <ul className="bg-muted flex flex-col divide-y rounded-xl" data-testid="fees-preview">
              {ordered.map((item) => {
                const got = applied.get(item.key);
                const paid = got ? got.principalPaisa + got.finePaisa : 0;
                const owed = item.principal + item.fine;
                return (
                  <li key={item.key} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-sm leading-snug">{item.label}</span>
                    <span className="flex shrink-0 flex-col items-end">
                      <span
                        className={cn(
                          'font-numeric text-sm font-semibold',
                          paid === 0 && 'text-muted-foreground',
                        )}
                      >
                        {paid > 0 ? taka(paid) : '—'}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {paid === 0
                          ? t('untouched')
                          : paid === owed
                            ? got && got.finePaisa > 0
                              ? t('withFine', { amount: taka(got.finePaisa) })
                              : t('full')
                            : t('partial', { left: taka(owed - paid) })}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {amount < total && (
              <p className="text-muted-foreground text-sm" data-testid="fees-left-after">
                {t('leftAfter', { amount: taka(total - amount) })}
              </p>
            )}
          </section>
        )}

        <p className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('method')}:</span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <BanknoteIcon aria-hidden className="text-muted-foreground size-4" />
            {tMethod('CASH')}
          </span>
        </p>

        {problem && (
          <p
            role="alert"
            className="bg-destructive-soft text-destructive rounded-xl px-3 py-2 text-sm"
            data-testid="fees-collect-error"
          >
            {problem}
          </p>
        )}
      </div>

      <SheetFooter className="bg-card sticky bottom-0 flex-row gap-2 border-t pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button type="button" variant="outline" size="lg" onClick={onCancel}>
          {t('back')}
        </Button>
        <Button
          type="submit"
          size="lg"
          className="flex-1"
          disabled={send.isPending}
          aria-busy={send.isPending || undefined}
          data-testid="fees-collect-confirm"
        >
          {send.isPending ? t('saving') : t('confirm', { amount: taka(valid ? amount : total) })}
        </Button>
      </SheetFooter>
    </form>
  );
}
