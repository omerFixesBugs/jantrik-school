import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Pills (docs/design.md → Components): a rounded label in a soft fill of its meaning. Every tone
 * is a tested pair (themes.test.ts: the ink on its soft fill, 4.5:1 in every theme).
 */

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'destructive' | 'info';

const TONE: Record<PillTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  accent: 'bg-primary-soft text-primary-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  destructive: 'bg-destructive-soft text-destructive',
  info: 'bg-info-soft text-info',
};

export function Pill({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: PillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs leading-5 font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A change against the comparison period: ↗ or ↘ and the size of it. The colour follows the
 * meaning, not the direction (more absences is red although the number went up): `better` says
 * which way is good. `label` is the whole sentence for screen readers ("২.৪% বেশি, গত সপ্তাহের
 * চেয়ে"); the arrow and number are what the eye reads.
 */
export function DeltaPill({
  change,
  display,
  better,
  label,
  className,
}: {
  /** Signed change (any unit); zero is "no change". */
  change: number;
  /** The size of the change as shown, without a sign ("২.৪%"). */
  display: string;
  better: 'up' | 'down';
  label: string;
  className?: string;
}) {
  const flat = change === 0;
  const good = flat ? null : change > 0 === (better === 'up');
  const Icon = flat ? MinusIcon : change > 0 ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <Pill
      tone={good === null ? 'neutral' : good ? 'success' : 'destructive'}
      className={cn('font-numeric font-semibold', className)}
    >
      <Icon aria-hidden className="size-3.5" />
      <span aria-hidden>{display}</span>
      <span className="sr-only">{label}</span>
    </Pill>
  );
}
