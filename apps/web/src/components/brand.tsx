import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/** The mark: a blackboard-green tile with য and a turmeric spark (docs/design.md → Brand). */
export function LogoMark({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'font-heading relative inline-flex size-9 shrink-0 items-center justify-center rounded-[11px] text-xl leading-none font-semibold',
        inverted ? 'bg-white text-[#0e5e50]' : 'bg-primary text-primary-foreground',
        className,
      )}
    >
      <span className="translate-y-[1px]">য</span>
      <span className="bg-accent-warm absolute top-1.5 right-1.5 size-1.5 rounded-full" />
    </span>
  );
}

/** Mark + wordmark. `compact` hides the wordmark (collapsed sidebar). */
export function Logo({
  compact,
  inverted,
  className,
}: {
  compact?: boolean;
  inverted?: boolean;
  className?: string;
}) {
  const t = useTranslations('app');
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark inverted={inverted} />
      <span
        className={cn(
          'font-heading text-lg leading-none font-semibold whitespace-nowrap',
          compact && 'sr-only',
        )}
      >
        {t('name')}
      </span>
    </span>
  );
}

const LETTERS = [...'অআইঈউঊঋএঐওঔ', ...'কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহ', 'ড়', 'ঢ়', 'য়', 'ৎ'];

/** Phone version of the chart: one row of letters, the first in turmeric. */
export function AlphabetStrip({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'font-heading flex gap-4 overflow-hidden text-2xl leading-none whitespace-nowrap select-none',
        className,
      )}
    >
      {LETTERS.slice(0, 16).map((letter, i) => (
        <span key={letter} className={i === 0 ? 'text-accent-warm' : 'text-white/20'}>
          {letter}
        </span>
      ))}
    </div>
  );
}

/**
 * The বর্ণমালা (alphabet chart) pattern for the login brand panel: chalk letters on green, one
 * in turmeric. Decorative only.
 */
export function AlphabetChart({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'font-heading grid grid-cols-6 gap-x-6 gap-y-3 text-[2.6rem] leading-none select-none sm:grid-cols-7 xl:grid-cols-8',
        className,
      )}
    >
      {LETTERS.map((letter, i) => (
        <span
          key={letter}
          className={cn(
            'flex aspect-square items-center justify-center',
            i === 0 ? 'text-accent-warm' : 'text-white/[0.13]',
          )}
        >
          {letter}
        </span>
      ))}
    </div>
  );
}
