'use client';

import type { FeeSubmissionView } from '@jantrik/shared';
import {
  BanIcon,
  CircleCheckIcon,
  ClockIcon,
  HourglassIcon,
  TriangleAlertIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill, type PillTone } from '@/components/kit/pill';
import type { DueState } from './use-child-fees';

/** Status is never colour alone (docs/design.md): an icon and the word, in its tone. */
function Mark({ tone, icon: Icon, label }: { tone: PillTone; icon: LucideIcon; label: string }) {
  return (
    <Pill tone={tone}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </Pill>
  );
}

const DUE_MARK: Record<DueState, { tone: PillTone; icon: LucideIcon }> = {
  OVERDUE: { tone: 'destructive', icon: TriangleAlertIcon },
  OPEN: { tone: 'neutral', icon: ClockIcon },
  PAID: { tone: 'success', icon: CircleCheckIcon },
  CANCELLED: { tone: 'neutral', icon: BanIcon },
};

export function DueStatusPill({ state }: { state: DueState }) {
  const t = useTranslations('fees.guardian.dues.status');
  return <Mark {...DUE_MARK[state]} label={t(state)} />;
}

const SUBMISSION_MARK: Record<FeeSubmissionView['status'], { tone: PillTone; icon: LucideIcon }> = {
  PENDING: { tone: 'info', icon: HourglassIcon },
  VERIFIED: { tone: 'success', icon: CircleCheckIcon },
  REJECTED: { tone: 'destructive', icon: Undo2Icon },
  VOIDED: { tone: 'neutral', icon: BanIcon },
};

export function SubmissionStatusPill({ status }: { status: FeeSubmissionView['status'] }) {
  const t = useTranslations('fees.guardian.submissions.status');
  return <Mark {...SUBMISSION_MARK[status]} label={t(status)} />;
}

/** The overdue amount as a pill: the icon, the word and the figure. */
export function OverduePill({ amount }: { amount: string }) {
  const t = useTranslations('fees.guardian.summary');
  return (
    <Pill tone="destructive" className="font-numeric whitespace-normal">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {t('overdue', { amount })}
    </Pill>
  );
}
