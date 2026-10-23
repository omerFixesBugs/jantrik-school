'use client';

import { formatBdPhone, formatIdentifier, type FeeStudentHit } from '@jantrik/shared';
import { CircleCheckIcon, CircleXIcon, ClockAlertIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { pick } from '@/lib/fees';
import { useLabel } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * Small pieces the counter screens share (docs/design.md → Components): status pills with an
 * icon and a word, the empty state, the failed-load line with a retry, and how a student's class
 * and guardian read on a card.
 */

/** Query keys of the counter, so a collection or a void refreshes every screen that shows it. */
export const feeKeys = {
  search: (tenant: string | undefined, q: string) => ['fees', 'search', tenant, q] as const,
  ledger: (tenant: string | undefined, studentId: string) =>
    ['fees', 'ledger', tenant, studentId] as const,
  receipt: (tenant: string | undefined, paymentId: string) =>
    ['fees', 'receipt', tenant, paymentId] as const,
  closing: (tenant: string | undefined) => ['fees', 'closing', tenant] as const,
};

/** A guardian phone as the API gave it: in full (formatted) for managers, masked otherwise. */
export const phoneText = (phone: string): string =>
  phone.startsWith('+') ? formatBdPhone(phone) : phone;

/** "ষষ্ঠ শ্রেণি · শাখা ক · রোল 12" (the roll is an identifier: ASCII). */
export function usePlace() {
  const t = useTranslations('fees.counter.search');
  const label = useLabel();
  return (enrolment: FeeStudentHit['enrolment'], locale: Locale): string =>
    enrolment
      ? [
          pick(locale, enrolment.classLevel),
          enrolment.section && `${label('section', 'Section')} ${enrolment.section.name}`,
          enrolment.roll != null && `${t('roll')} ${formatIdentifier(enrolment.roll)}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : t('notEnrolled');
}

/** A student status other than active, as a pill with its icon (active stays quiet). */
export function StudentStatusPill({ status }: { status: FeeStudentHit['status'] }) {
  const t = useTranslations('studentStatus');
  if (status === 'ACTIVE') return null;
  return (
    <Pill tone={status === 'DROPPED_OUT' ? 'destructive' : 'neutral'}>
      <CircleXIcon aria-hidden className="size-3.5 shrink-0" />
      {t(status)}
    </Pill>
  );
}

type StatusKind = 'overdue' | 'paid' | 'cancelled' | 'void';
const STATUS: Record<
  StatusKind,
  { icon: LucideIcon; tone: 'destructive' | 'success' | 'neutral' }
> = {
  overdue: { icon: ClockAlertIcon, tone: 'destructive' },
  paid: { icon: CircleCheckIcon, tone: 'success' },
  cancelled: { icon: CircleXIcon, tone: 'neutral' },
  void: { icon: CircleXIcon, tone: 'destructive' },
};

/** A due's or a receipt's state: icon and word, never colour alone. */
export function StatusPill({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  const { icon: Icon, tone } = STATUS[kind];
  return (
    <Pill tone={tone}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </Pill>
  );
}

/** What is empty, what to do, and the action when there is one. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  testId,
  className,
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  action?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-slot="card"
      data-testid={testId}
      className={cn(
        'bg-card rounded-card shadow-card flex flex-col items-center gap-3 border px-6 py-12 text-center',
        className,
      )}
    >
      <span className="bg-primary-soft text-primary-ink flex size-14 items-center justify-center rounded-xl">
        <Icon aria-hidden className="size-7" />
      </span>
      <p className="text-lg font-medium">{title}</p>
      {text && <p className="text-muted-foreground max-w-md text-sm">{text}</p>}
      {action}
    </div>
  );
}

/** A part that failed to load: what happened, and a retry. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslations('common');
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('retry')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A titled floating card for one part of a page. */
export function Panel({
  title,
  id,
  hint,
  actions,
  children,
  className,
  testId,
}: {
  title: string;
  id: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-slot="card"
      aria-labelledby={`${id}-title`}
      data-testid={testId}
      className={cn(
        'bg-card rounded-card shadow-card flex min-w-0 flex-col gap-3 border p-(--panel-p)',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={`${id}-title`} className="text-base font-semibold">
            {title}
          </h2>
          {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
