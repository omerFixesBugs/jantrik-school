'use client';

import { BD_PHONE_E164, formatBdPhone, formatCount, type FeeSubmissionView } from '@jantrik/shared';
import {
  BanIcon,
  CircleCheckIcon,
  CopyIcon,
  HourglassIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Pill, type PillTone } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import type { AuthClient } from '@/lib/auth/auth-client';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * Small pieces the fee review, report and reminder screens share (docs/design.md → Components):
 * status as icon + word, phone numbers that may arrive masked, empty states, errors with a
 * retry, CSV downloads and the minimum-days choices.
 */

type SubmissionStatus = FeeSubmissionView['status'];

const STATUS: Record<SubmissionStatus, { icon: LucideIcon; tone: PillTone }> = {
  PENDING: { icon: HourglassIcon, tone: 'warning' },
  VERIFIED: { icon: CircleCheckIcon, tone: 'success' },
  REJECTED: { icon: Undo2Icon, tone: 'destructive' },
  VOIDED: { icon: BanIcon, tone: 'neutral' },
};

/** A bKash/Nagad submission's status: icon and word, never colour alone. */
export function SubmissionStatusPill({ status }: { status: SubmissionStatus }) {
  const t = useTranslations('fees.common.status');
  const { icon: Icon, tone } = STATUS[status];
  return (
    <Pill tone={tone}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {t(status)}
    </Pill>
  );
}

/** A full number (E.164) the person may dial; the accountant gets masked ones ("018•••••101"). */
export const isDialable = (phone: string): boolean => BD_PHONE_E164.test(phone);

/** A phone number as shown: formatted when full, as given when masked. Always ASCII. */
export function PhoneText({ phone, className }: { phone: string; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)} dir="ltr">
      {isDialable(phone) ? formatBdPhone(phone) : phone}
    </span>
  );
}

/** A TrxID: ASCII, monospace, easy to select whole, with a copy button beside it. */
export function TrxId({ trxId, className }: { trxId: string; className?: string }) {
  const t = useTranslations('fees.reports');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trxId);
      toast.success(t('common.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <span
        className="bg-muted min-w-0 rounded-md px-2 py-0.5 font-mono text-sm font-semibold tracking-wide break-all select-all"
        dir="ltr"
        data-testid="submission-trx"
      >
        {trxId}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={t('submissions.copyTrx', { trxId })}
        onClick={() => void copy()}
      >
        <CopyIcon aria-hidden />
      </Button>
    </span>
  );
}

/** What a due is, in words: "বেতন · অক্টোবর ২০২৬". */
export function useDueName() {
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  return (due: {
    head: { nameBn: string; nameEn: string };
    periodKey: string;
    term?: { nameBn: string; nameEn: string } | null;
  }) => `${pick(locale, due.head)} · ${period(due)}`;
}

/** Empty: one sentence on what is empty, one on what to do, and the action when there is one. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-slot="card"
      className="bg-card rounded-card shadow-card flex flex-col items-center gap-3 border px-6 py-12 text-center"
      data-testid={testId}
    >
      <span className="bg-primary-soft text-primary-ink flex size-14 items-center justify-center rounded-xl">
        <Icon aria-hidden className="size-7" />
      </span>
      <p className="text-lg font-medium">{title}</p>
      {hint && <p className="text-muted-foreground max-w-md text-sm">{hint}</p>}
      {action}
    </div>
  );
}

/** A part that could not be loaded: why, and a way to try again. */
export function LoadError({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        {describe(error)}
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tCommon('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Downloads a file from the API (a CSV export) under a name of our choosing. */
export async function downloadFile(client: AuthClient, path: string, filename: string) {
  const blob = await client.download(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** "Overdue for at least" choices: overdue at all, then about two weeks, a month, two, three. */
export const MIN_DAYS = [1, 15, 30, 60, 90] as const;

/** The minimum-days choices as select options ("৩০ দিন বা বেশি"), with `current` if it is another. */
export function useMinDaysOptions(current?: number) {
  const t = useTranslations('fees.reports.common');
  const locale = useLocale() as Locale;
  const days: number[] = [...MIN_DAYS];
  if (current && !days.includes(current)) days.push(current);
  return days
    .sort((a, b) => a - b)
    .map((d) => ({
      value: String(d),
      label: d === 1 ? t('minDaysAny') : t('minDaysN', { days: formatCount(d, locale) }),
    }));
}

/** A whole number from the URL within bounds, or the fallback. */
export function intParam(value: string | null, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  return value !== null && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
