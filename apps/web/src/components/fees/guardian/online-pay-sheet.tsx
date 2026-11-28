'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatTaka,
  ONLINE_MAX_PAISA,
  ONLINE_MIN_PAISA,
  type FeeDueView,
  type FeeGuardianView,
  type OnlinePaymentView,
  type StartOnlinePaymentInput,
} from '@jantrik/shared';
import { LockIcon, TriangleAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { Locale } from '@/i18n/config';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { randomId } from '@/lib/uuid';
import { childFeesKey, isOwed, MAX_DUES_PER_SUBMISSION } from './use-child-fees';

/** Overdue dues are ticked first; when none is overdue, every owed due. */
function defaultDues(owed: FeeDueView[]): string[] {
  const late = owed.filter((d) => d.overdue);
  return (late.length > 0 ? late : owed).slice(0, MAX_DUES_PER_SUBMISSION).map((d) => d.id);
}

/**
 * "Pay online" (sprint 1 P7a2, S22): the child's owed dues as checkboxes, each paid in full with
 * what it owes today (fine included); the total; no amount to type, because the school sets it.
 * "Continue to SSLCommerz" starts the payment and opens its page, which sends the guardian on to
 * the gateway. Loaded only when opened (the fees page keeps its first-load size).
 */
export default function OnlinePaySheet({
  open,
  onOpenChange,
  childId,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  childId: string;
  view: FeeGuardianView;
}) {
  const t = useTranslations('fees.guardian.online');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-2xl p-0 sm:rounded-2xl sm:border sm:data-[side=bottom]:bottom-4"
        data-testid="online-pay-sheet"
      >
        <SheetTitle className="px-4 pt-4 pe-14 text-lg">{t('title')}</SheetTitle>
        <OnlinePayForm childId={childId} view={view} />
      </SheetContent>
    </Sheet>
  );
}

function OnlinePayForm({ childId, view }: { childId: string; view: FeeGuardianView }) {
  const t = useTranslations('fees.guardian.online');
  const tDues = useTranslations('fees.guardian.dues');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const taka = (paisa: number) => formatTaka(paisa, locale);

  const owed = view.ledger.dues.filter(isOwed);
  const [dueIds, setDueIds] = useState<string[]>(() => defaultDues(owed));
  const [problem, setProblem] = useState<string | null>(null);
  /** An attempt whose answer was lost: a retry of the same dues reuses its id (same payment). */
  const retry = useRef<{ id: string; signature: string } | null>(null);
  const chosen = owed.filter((d) => dueIds.includes(d.id));
  const total = chosen.reduce((sum, d) => sum + d.balance.total, 0);
  const atMax = dueIds.length >= MAX_DUES_PER_SUBMISSION;
  const tooSmall = chosen.length > 0 && total < ONLINE_MIN_PAISA;
  const tooLarge = total > ONLINE_MAX_PAISA;

  const start = useMutation({
    mutationFn: (body: StartOnlinePaymentInput) =>
      client.api<OnlinePaymentView>(`/me/children/${childId}/fees/online-payments`, {
        method: 'POST',
        json: body,
      }),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: childFeesKey(session?.tenant?.id, childId) });

  function explain(error: unknown): string {
    if (error instanceof ApiError) {
      const body = error.body as { amountPaisa?: number; intentId?: string; mine?: boolean } | null;
      switch (error.code) {
        case 'DUES_CHANGED':
          void refresh();
          return typeof body?.amountPaisa === 'number'
            ? t('errors.duesChanged', { amount: taka(body.amountPaisa) })
            : t('errors.changed');
        case 'NOTHING_DUE':
          void refresh();
          return t('errors.changed');
        case 'PAYMENT_IN_PROGRESS':
          void refresh();
          return body?.mine ? t('errors.inProgressMine') : t('errors.inProgressOther');
        case 'ONLINE_AMOUNT_OUT_OF_RANGE':
          return t('errors.range', { min: taka(ONLINE_MIN_PAISA), max: taka(ONLINE_MAX_PAISA) });
        case 'ONLINE_PAYMENTS_OFF':
          void refresh();
          return t('errors.off');
      }
      if (error.status === 404) {
        void refresh();
        return t('errors.changed');
      }
      if (error.status === 429) {
        const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60));
        return t('errors.rateLimited', { minutes: formatCount(minutes, locale), n: minutes });
      }
    }
    return describe(error);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (start.isPending || chosen.length === 0 || tooSmall || tooLarge) return;
    const ids = chosen.map((d) => d.id);
    const signature = JSON.stringify([ids, total]);
    const clientRequestId = retry.current?.signature === signature ? retry.current.id : randomId();
    setProblem(null);
    start.mutate(
      { dueIds: ids, expectedAmountPaisa: total, clientRequestId },
      {
        onSuccess: (payment) => {
          retry.current = null;
          void refresh();
          router.push(`/children/${childId}/fees/pay/${payment.id}`);
        },
        onError: (error) => {
          const unknown =
            error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
          retry.current = unknown ? { id: clientRequestId, signature } : null;
          setProblem(explain(error));
        },
      },
    );
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit} noValidate>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
        <SheetDescription className="text-sm">{t('text')}</SheetDescription>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1 ps-5 text-sm">
          <li>{t('inFull')}</li>
          <li>{t('setBySchool')}</li>
        </ul>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('dues')}</legend>
          <ul className="flex flex-col gap-2">
            {owed.map((d) => {
              const checked = dueIds.includes(d.id);
              const disabled = !checked && atMax;
              return (
                <li key={d.id}>
                  <label
                    className={cn(
                      'bg-card flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
                      'has-checked:border-primary-ink has-checked:bg-primary-soft',
                      'has-focus-visible:ring-ring has-focus-visible:ring-3',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      value={d.id}
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setDueIds((ids) => (on ? [...ids, d.id] : ids.filter((id) => id !== d.id)));
                        setProblem(null);
                      }}
                      className="accent-primary size-5 shrink-0"
                      data-testid="online-due"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium wrap-break-word">
                        {pick(locale, d.head)}
                        <span className="text-muted-foreground font-normal"> · {period(d)}</span>
                      </span>
                      {d.overdue && (
                        <span className="text-destructive flex items-center gap-1 text-xs font-medium">
                          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                          {tDues('status.OVERDUE')}
                        </span>
                      )}
                      {d.balance.fine > 0 && (
                        <span className="text-muted-foreground text-xs">
                          {t('fineIncluded', { amount: taka(d.balance.fine) })}
                        </span>
                      )}
                    </span>
                    <span className="num shrink-0 font-medium">{taka(d.balance.total)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <p className="flex items-baseline justify-between gap-3 px-3 text-base font-semibold">
          <span>{t('total')}</span>
          <span className="num" data-testid="online-total">
            {total > 0 ? taka(total) : '—'}
          </span>
        </p>
        {tooSmall && (
          <p className="text-muted-foreground text-sm" data-testid="online-too-small">
            {t('minimum', { amount: taka(ONLINE_MIN_PAISA) })}
          </p>
        )}
        {tooLarge && (
          <p className="text-muted-foreground text-sm">
            {t('maximum', { amount: taka(ONLINE_MAX_PAISA) })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-3 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {problem && (
          <Alert variant="destructive" data-testid="online-error">
            <AlertDescription className="text-destructive">{problem}</AlertDescription>
          </Alert>
        )}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={start.isPending || chosen.length === 0 || tooSmall || tooLarge}
          data-testid="online-continue"
        >
          <LockIcon aria-hidden />
          {start.isPending ? t('starting') : t('continue')}
        </Button>
        <p className="text-muted-foreground text-center text-xs">{t('gatewayNote')}</p>
      </div>
    </form>
  );
}
