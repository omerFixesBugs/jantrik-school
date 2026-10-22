'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatTaka,
  type FeeDueView,
  type FeeLedger,
  type FeeReceipt,
} from '@jantrik/shared';
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  ClockAlertIcon,
  HandCoinsIcon,
  InboxIcon,
  WalletIcon,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { KpiTile } from '@/components/dashboard/kpi';
import { CollectSheet, type CollectItem } from '@/components/fees/counter/collect-sheet';
import { DueActionDialog, type DueAction } from '@/components/fees/counter/due-actions';
import { EmptyState, feeKeys, LoadError, Panel } from '@/components/fees/counter/kit';
import {
  ConcessionList,
  DueCard,
  PaymentList,
  StudentHeader,
  UpcomingRow,
  upcomingKey,
  upcomingNet,
  WaiverList,
} from '@/components/fees/counter/ledger-parts';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { PageGate } from '@/components/page-gate';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, useFeeRoles, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export default function FeeLedgerPage() {
  return (
    <PageGate page="fees">
      <div className="flex flex-col gap-(--section-gap)">
        <FeesTabs />
        <Ledger />
      </div>
    </PageGate>
  );
}

/** Something owed on it now (an open due with a balance). */
const owing = (d: FeeDueView) => d.status === 'OPEN' && d.balance.total > 0;

/**
 * One student's fees at the counter (docs/fees.md → Collecting cash): who it is, what they owe
 * (overdue dues chosen already), periods they may pay ahead, and a bar that stays on screen with
 * the chosen total and "আদায় করুন". Managers also waive fines and cancel dues from here.
 */
function Ledger() {
  const t = useTranslations('fees.counter');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const router = useRouter();
  const period = usePeriodLabel();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const { manages } = useFeeRoles();
  const { id } = useParams<{ id: string }>();
  const key = feeKeys.ledger(tenantId, id);
  const ledger = useQuery({
    queryKey: key,
    queryFn: () => client.api<FeeLedger>(`/fees/students/${id}/ledger`),
  });

  // The choice: null until the person changes it (then the overdue dues are chosen).
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [ahead, setAhead] = useState<Set<string>>(() => new Set());
  const [showAhead, setShowAhead] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [action, setAction] = useState<DueAction | null>(null);

  if (ledger.isPending) return <LedgerSkeleton />;
  if (ledger.isError) {
    const gone = ledger.error instanceof ApiError && ledger.error.status === 404;
    return (
      <div className="flex flex-col gap-3">
        <BackToSearch />
        <LoadError
          message={
            gone ? t('ledger.notFound') : `${t('ledger.loadFailed')} ${describe(ledger.error)}`
          }
          onRetry={gone ? undefined : () => void ledger.refetch()}
        />
      </div>
    );
  }

  const data = ledger.data;
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const open = data.dues.filter(owing);
  const settled = data.dues.filter((d) => !owing(d));
  const chosen = new Set(picked ?? open.filter((d) => d.overdue).map((d) => d.id));
  // Only what is still owed counts: a reload may have paid or cancelled something chosen.
  const chosenDues = open.filter((d) => chosen.has(d.id));
  const chosenAhead = data.upcoming.filter((u) => ahead.has(upcomingKey(u)) && upcomingNet(u) > 0);
  const total =
    chosenDues.reduce((sum, d) => sum + d.balance.total, 0) +
    chosenAhead.reduce((sum, u) => sum + upcomingNet(u), 0);
  const count = chosenDues.length + chosenAhead.length;
  const payable = open.length > 0 || data.upcoming.some((u) => upcomingNet(u) > 0);
  const overdueCount = open.filter((d) => d.overdue).length;
  const activePayments = data.payments.filter((p) => p.status === 'ACTIVE').length;

  const choose = (dueId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(dueId);
    else next.delete(dueId);
    setPicked(next);
  };
  const chooseAhead = (k: string, on: boolean) => {
    const next = new Set(ahead);
    if (on) next.add(k);
    else next.delete(k);
    setAhead(next);
  };

  const order = new Map(data.dues.map((d, i) => [d.id, i]));
  const items: CollectItem[] = [
    ...chosenDues.map((d) => ({
      key: d.id,
      label: `${pick(locale, d.head)} · ${period(d)}`,
      dueDate: d.dueDate,
      order: order.get(d.id) ?? 0,
      principal: d.balance.principal,
      fine: d.balance.fine,
    })),
    ...chosenAhead.map((u, i) => ({
      key: `ahead:${upcomingKey(u)}`,
      label: `${pick(locale, u.head)} · ${period(u)}`,
      dueDate: u.dueDate,
      order: data.dues.length + i,
      principal: upcomingNet(u),
      fine: 0,
    })),
  ];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['fees'] });
  const onCollected = (receipt: FeeReceipt) => {
    queryClient.setQueryData(feeKeys.receipt(tenantId, receipt.id), receipt);
    // Every staff fee screen shows it (ledger, closing, reports, dashboard card).
    void queryClient.invalidateQueries({ queryKey: ['fees'] });
    toast.success(t('collect.done', { number: receipt.receiptNumber }));
    setCollecting(false);
    router.push(`/fees/receipts/${receipt.id}`);
  };

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-ledger">
      <BackToSearch />
      <StudentHeader ledger={data} />

      <ul className="flex flex-wrap gap-(--gap)">
        <KpiTile
          label={t('ledger.balance')}
          icon={WalletIcon}
          value={taka(data.totals.balance)}
          hint={t('ledger.balanceHint')}
          className="grow basis-36"
          testId="fees-total-balance"
        />
        <KpiTile
          label={t('ledger.overdue')}
          icon={ClockAlertIcon}
          value={taka(data.totals.overdue)}
          hint={
            overdueCount > 0
              ? t('ledger.overdueHint', {
                  count: formatCount(overdueCount, locale),
                  n: overdueCount,
                })
              : t('ledger.overdueNone')
          }
          className="grow basis-36"
          testId="fees-total-overdue"
        />
        <KpiTile
          label={t('ledger.paid')}
          icon={CircleCheckIcon}
          value={taka(data.totals.paid)}
          hint={t('ledger.paidHint', {
            count: formatCount(activePayments, locale),
            n: activePayments,
          })}
          className="hidden grow basis-36 md:block"
          testId="fees-total-paid"
        />
      </ul>

      <div className="grid items-start gap-(--section-gap) xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-(--section-gap)">
          {data.dues.length === 0 ? (
            <EmptyState
              icon={InboxIcon}
              title={t('ledger.nothingYetTitle')}
              text={
                data.upcoming.length > 0 ? t('ledger.nothingYetAhead') : t('ledger.nothingYetText')
              }
              testId="fees-dues-none"
            />
          ) : open.length === 0 ? (
            <EmptyState
              icon={CircleCheckIcon}
              title={t('ledger.allPaidTitle')}
              text={data.upcoming.length > 0 ? t('ledger.allPaidText') : undefined}
              testId="fees-dues-clear"
            />
          ) : (
            <Panel
              id="fees-dues"
              title={t('ledger.dues')}
              hint={t('ledger.duesHint')}
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setPicked(
                      chosenDues.length === open.length
                        ? new Set()
                        : new Set(open.map((d) => d.id)),
                    )
                  }
                  data-testid="fees-select-all"
                >
                  {chosenDues.length === open.length
                    ? t('ledger.selectNone')
                    : t('ledger.selectAll')}
                </Button>
              }
            >
              <ul className="-mx-(--panel-p) flex flex-col divide-y border-y">
                {open.map((d) => (
                  <DueCard
                    key={d.id}
                    due={d}
                    checked={chosen.has(d.id)}
                    onToggle={(on) => choose(d.id, on)}
                    manages={manages}
                    onAction={(kind) => setAction({ kind, due: d })}
                  />
                ))}
              </ul>
            </Panel>
          )}

          {data.upcoming.length > 0 && (
            <section
              data-slot="card"
              aria-labelledby="fees-advance-title"
              className="bg-card rounded-card shadow-card flex min-w-0 flex-col border"
            >
              <h2 id="fees-advance-title" className="m-0">
                <button
                  type="button"
                  aria-expanded={showAhead}
                  aria-controls="fees-advance-list"
                  onClick={() => setShowAhead(!showAhead)}
                  data-testid="fees-advance-toggle"
                  className="hover:bg-muted/60 focus-visible:ring-ring rounded-card flex min-h-(--control-h-lg) w-full items-center gap-3 p-(--panel-p) text-start outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="bg-primary-soft text-primary-ink flex size-9 shrink-0 items-center justify-center rounded-xl">
                    <CalendarClockIcon aria-hidden className="size-4.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base font-semibold">{t('ledger.advance')}</span>
                    <span className="text-muted-foreground text-sm font-normal">
                      {t('ledger.advanceCount', {
                        count: formatCount(data.upcoming.length, locale),
                        n: data.upcoming.length,
                      })}
                      {chosenAhead.length > 0 &&
                        ` · ${t('ledger.advancePicked', { count: formatCount(chosenAhead.length, locale) })}`}
                    </span>
                  </span>
                  <ChevronDownIcon
                    aria-hidden
                    className={cn(
                      'text-muted-foreground size-5 shrink-0 transition-transform',
                      showAhead && 'rotate-180',
                    )}
                  />
                </button>
              </h2>
              {showAhead && (
                <div id="fees-advance-list" className="flex flex-col gap-2 pb-2">
                  <p className="text-muted-foreground px-(--panel-p) text-sm">
                    {t('ledger.advanceHint')}
                  </p>
                  <ul className="flex flex-col divide-y border-y">
                    {data.upcoming.map((u) => (
                      <UpcomingRow
                        key={upcomingKey(u)}
                        item={u}
                        checked={ahead.has(upcomingKey(u))}
                        onToggle={(on) => chooseAhead(upcomingKey(u), on)}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {settled.length > 0 && (
            <Panel id="fees-settled" title={t('ledger.settled')}>
              <ul className="-mx-(--panel-p) flex flex-col divide-y border-t">
                {settled.map((d) => (
                  <DueCard
                    key={d.id}
                    due={d}
                    checked={false}
                    onToggle={() => undefined}
                    manages={manages}
                    onAction={(kind) => setAction({ kind, due: d })}
                  />
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-(--section-gap)">
          <Panel id="fees-history" title={t('ledger.history')} testId="fees-history">
            <PaymentList payments={data.payments} />
          </Panel>
          {data.concessions.length > 0 && (
            <Panel id="fees-concessions" title={t('ledger.concessions')}>
              <ConcessionList concessions={data.concessions} />
            </Panel>
          )}
          {data.waivers.length > 0 && (
            <Panel id="fees-waivers" title={t('ledger.waivers')}>
              <WaiverList waivers={data.waivers} dues={data.dues} />
            </Panel>
          )}
        </aside>
      </div>

      {payable && (
        <div
          data-testid="fees-collect-bar"
          className="bg-card sticky bottom-0 z-20 -mx-4 -mb-(--section-gap) flex items-center gap-3 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(var(--shadow-rgb)/0.25)] sm:-mx-6 sm:px-6 print:hidden"
        >
          <div className="flex min-w-0 flex-1 flex-col" aria-live="polite">
            <span className="text-muted-foreground truncate text-sm">
              {count > 0
                ? t('collect.selected', { count: formatCount(count, locale), n: count })
                : t('collect.nothingSelected')}
            </span>
            <span
              className="font-numeric text-2xl leading-tight font-semibold"
              data-testid="fees-collect-total"
            >
              {taka(total)}
            </span>
          </div>
          <Button
            size="lg"
            onClick={() => setCollecting(true)}
            disabled={total === 0}
            data-testid="fees-collect-open"
            className="min-h-11 px-6"
          >
            <HandCoinsIcon aria-hidden className="size-5" />
            {t('collect.open')}
          </Button>
        </div>
      )}

      <CollectSheet
        open={collecting}
        onOpenChange={setCollecting}
        studentId={data.student.id}
        studentName={pick(locale, data.student)}
        dueIds={chosenDues.map((d) => d.id)}
        advance={chosenAhead.map((u) => ({ headId: u.headId, periodKey: u.periodKey }))}
        items={items}
        total={total}
        onStale={() => void refresh()}
        onCollected={onCollected}
      />

      {action && (
        <DueActionDialog
          action={action}
          onClose={() => setAction(null)}
          onDone={(message) => {
            setAction(null);
            toast.success(message);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function BackToSearch() {
  const t = useTranslations('fees.counter.ledger');
  return (
    <ButtonLink href="/fees" variant="ghost" size="sm" className="-ms-2 self-start print:hidden">
      <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
      {t('back')}
    </ButtonLink>
  );
}

function LedgerSkeleton() {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col gap-(--section-gap)" aria-busy="true" aria-label={t('loading')}>
      <Skeleton className="h-(--control-h-sm) w-32" />
      <Skeleton className="rounded-card h-28 w-full" />
      <div className="grid grid-cols-2 gap-(--gap) md:grid-cols-3">
        <Skeleton className="rounded-card h-32" />
        <Skeleton className="rounded-card h-32" />
        <Skeleton className="rounded-card hidden h-32 md:block" />
      </div>
      <Skeleton className="rounded-card h-72 w-full" />
    </div>
  );
}
