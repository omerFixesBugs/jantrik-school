'use client';

import { formatCount, formatIdentifier, formatTaka, type FeeGuardianView } from '@jantrik/shared';
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  GlobeLockIcon,
  HourglassIcon,
  SearchXIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';
import { DueCard } from './due-card';
import { GuardianNotice } from './guardian-gate';
import { PaySheet } from './pay-sheet';
import { PaymentHistory } from './payment-history';
import { OverduePill } from './status-pills';
import { SubmissionList } from './submission-list';
import { isOwed, MAX_PENDING_PER_CHILD, pendingDueIds, useChildFees } from './use-child-fees';

// Loaded only when a guardian opens it: the fees page keeps its first-load size (perf budget).
const OnlinePaySheet = dynamic(() => import('./online-pay-sheet'), { ssr: false });

/** A guardian's view of one child's fees (GET /me/children/:id/fees). */
export function ChildFeesView({ childId }: { childId: string }) {
  const t = useTranslations('fees.guardian');
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  const q = useChildFees(childId);

  return (
    <div
      className="flex min-w-0 flex-col gap-(--section-gap)"
      data-testid="child-fees"
      aria-busy={q.isPending || undefined}
    >
      <ButtonLink variant="ghost" size="sm" href="/dashboard" className="-ms-2 self-start">
        <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
        {t('back')}
      </ButtonLink>
      {q.isPending ? (
        <div className="flex flex-col gap-(--section-gap)" aria-label={tCommon('loading')}>
          <div className="flex items-center gap-4">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-48" />
            </div>
          </div>
          <Skeleton className="rounded-card h-44" />
          <div className="grid gap-(--gap) md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="rounded-card h-48" />
            <Skeleton className="rounded-card h-48" />
          </div>
        </div>
      ) : q.isError ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <GuardianNotice
            icon={SearchXIcon}
            title={t('notFoundTitle')}
            text={t('notFoundText')}
            testId="child-fees-not-found"
          />
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="text-destructive flex flex-wrap items-center justify-between gap-2">
              <span>
                {t('loadFailed')} {describe(q.error)}
              </span>
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                {tCommon('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : (
        <Loaded childId={childId} view={q.data} />
      )}
    </div>
  );
}

function Loaded({ childId, view }: { childId: string; view: FeeGuardianView }) {
  const t = useTranslations('fees.guardian');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const [paying, setPaying] = useState(false);
  // "Start again" from a payment that did not go through opens the online sheet at once.
  const again = useSearchParams().get('pay') === 'online';
  const [payingOnline, setPayingOnline] = useState(again);
  const taka = (paisa: number) => formatTaka(paisa, locale);

  const { ledger } = view;
  const student = ledger.student;
  const name = displayName(student.nameBn, student.nameEn, locale);
  const e = student.enrolment;
  const owedDues = ledger.dues.filter(isOwed);
  // Paid and cancelled dues: the latest first.
  const settled = ledger.dues.filter((d) => !isOwed(d)).reverse();
  const pending = pendingDueIds(view);
  const waiting = view.submissions.filter((s) => s.status === 'PENDING').length;
  const owed = ledger.totals.balance;
  const overdue = ledger.totals.overdue;
  const fineOwed = owedDues.reduce((sum, d) => sum + d.balance.fine, 0);
  const canReport = owed > 0 && view.accounts.length > 0;
  const full = waiting >= MAX_PENDING_PER_CHILD;
  // Online payment (sprint 1 P7a2): offered when the school has it on; a payment in progress is
  // continued rather than started again.
  const online = view.online;
  const canPayOnline = owed > 0 && online.available && !online.inProgress;

  const facts = [
    e ? displayName(e.classLevel.nameBn, e.classLevel.nameEn, locale) : null,
    e?.section ? `${label('section', 'Section')} ${e.section.name}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <>
      <header className="flex items-center gap-4">
        <PersonAvatar name={name} size="xl" />
        <div className="flex min-w-0 flex-col">
          <p className="text-muted-foreground text-sm">{t('title')}</p>
          <h1 className="truncate text-2xl font-semibold">{name}</h1>
          <p className="text-muted-foreground text-sm">
            {facts && <>{facts} · </>}
            {/* A label and its identifier stay together, and an identifier never breaks. */}
            {e?.roll != null && (
              <>
                <span className="whitespace-nowrap">
                  {t('roll')}{' '}
                  <span className="text-foreground tabular-nums" dir="ltr">
                    {formatIdentifier(e.roll)}
                  </span>
                </span>
                {' · '}
              </>
            )}
            <span className="whitespace-nowrap">
              {t('studentId')}{' '}
              <span className="text-foreground tabular-nums" dir="ltr">
                {formatIdentifier(student.studentCode)}
              </span>
            </span>
          </p>
        </div>
      </header>

      <section
        data-slot="card"
        className="bg-card rounded-card shadow-card flex flex-col gap-4 border p-(--panel-p) sm:flex-row sm:items-end sm:justify-between"
        aria-label={t('summary.title')}
        data-testid="child-fees-summary-card"
      >
        <div className="flex min-w-0 flex-col gap-2">
          {owed > 0 ? (
            <>
              <span className="text-muted-foreground">{t('summary.owedNow')}</span>
              <span
                className="font-numeric text-[2.25rem] leading-none font-light sm:text-[2.5rem]"
                data-testid="child-fees-owed"
              >
                {taka(owed)}
              </span>
              {(overdue > 0 || fineOwed > 0) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {overdue > 0 && <OverduePill amount={taka(overdue)} />}
                  {fineOwed > 0 && (
                    <span className="text-muted-foreground text-sm">
                      {t('summary.fineIncluded', { amount: taka(fineOwed) })}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-start gap-3">
              <span className="bg-success-soft text-success flex size-10 shrink-0 items-center justify-center rounded-xl">
                <CircleCheckIcon aria-hidden className="size-5" />
              </span>
              <div className="flex flex-col">
                <span className="text-xl font-semibold">{t('summary.allPaid')}</span>
                <span className="text-muted-foreground text-sm">
                  {ledger.dues.length === 0 ? t('dues.empty') : t('summary.allPaidText')}
                </span>
              </div>
            </div>
          )}
          {waiting > 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <HourglassIcon aria-hidden className="text-info size-4 shrink-0" />
              {t('summary.pending', { count: formatCount(waiting, locale), n: waiting })}
            </p>
          )}
        </div>

        {(owed > 0 || online.inProgress) && (
          <div className="flex flex-col gap-2 sm:max-w-xs sm:items-end sm:text-end">
            {online.inProgress &&
              (online.inProgress.mine ? (
                <ButtonLink
                  size="lg"
                  className="w-full sm:w-auto"
                  href={`/children/${childId}/fees/pay/${online.inProgress.intentId}`}
                  data-testid="child-online-continue"
                >
                  <GlobeLockIcon aria-hidden />
                  {t('online.continueOpen')}
                </ButtonLink>
              ) : (
                <p className="text-muted-foreground text-sm" data-testid="child-online-other">
                  {t('online.otherInProgress')}
                </p>
              ))}
            {canPayOnline && (
              <Button
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => setPayingOnline(true)}
                data-testid="child-online-open"
              >
                <GlobeLockIcon aria-hidden />
                {t('online.open')}
              </Button>
            )}
            {owed === 0 ? null : canReport ? (
              <>
                <Button
                  size="lg"
                  variant={online.available ? 'outline' : 'default'}
                  className="w-full sm:w-auto"
                  onClick={() => setPaying(true)}
                  disabled={full}
                  aria-describedby={full ? 'child-pay-full' : undefined}
                  data-testid="child-pay-open"
                >
                  <SmartphoneIcon aria-hidden />
                  {t('pay.open')}
                </Button>
                <p id="child-pay-full" className="text-muted-foreground text-sm">
                  {full
                    ? t('pay.pendingFull', { count: formatCount(waiting, locale), n: waiting })
                    : t('summary.payAtOffice')}
                </p>
              </>
            ) : online.available ? null : (
              <p className="text-muted-foreground text-sm" data-testid="child-pay-no-accounts">
                {t('pay.noAccounts')}
              </p>
            )}
          </div>
        )}
      </section>

      {owedDues.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="child-owed-title">
          <h2 id="child-owed-title" className="text-lg font-semibold">
            {t('dues.owedTitle')}
          </h2>
          <ul className="grid gap-(--gap) md:grid-cols-2 xl:grid-cols-3">
            {owedDues.map((d) => (
              <DueCard
                key={d.id}
                due={d}
                concessions={ledger.concessions}
                pending={pending.has(d.id)}
                previousYear={
                  ledger.currentYearId !== null && d.academicYear.id !== ledger.currentYearId
                }
              />
            ))}
          </ul>
        </section>
      )}

      <div
        className={cn(
          'grid items-start gap-(--section-gap)',
          view.submissions.length > 0 && 'lg:grid-cols-2',
        )}
      >
        {view.submissions.length > 0 && (
          <SubmissionList childId={childId} submissions={view.submissions} />
        )}
        <PaymentHistory childId={childId} payments={ledger.payments} />
      </div>

      {settled.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="child-settled-title">
          <h2 id="child-settled-title" className="text-lg font-semibold">
            {t('dues.settledTitle')}
          </h2>
          <ul className="grid gap-(--gap) md:grid-cols-2 xl:grid-cols-3">
            {settled.map((d) => (
              <DueCard key={d.id} due={d} concessions={ledger.concessions} pending={false} />
            ))}
          </ul>
        </section>
      )}

      {/* Stays while open even if a refresh empties the list (it then explains the refusal). */}
      {(canReport || paying) && (
        <PaySheet open={paying} onOpenChange={setPaying} childId={childId} view={view} />
      )}
      {payingOnline && (
        <OnlinePaySheet
          open={canPayOnline}
          onOpenChange={setPayingOnline}
          childId={childId}
          view={view}
        />
      )}
    </>
  );
}
