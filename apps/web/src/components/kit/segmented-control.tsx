'use client';

import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * A pill segmented control (আজ | সপ্তাহ | মাস): one choice of a few, always visible. A radio group
 * (docs/design.md → Components): one tab stop, the arrow keys move the choice, Home and End jump
 * to the ends.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  testId,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  /** Names the group for screen readers ("সময়"). */
  label: string;
  className?: string;
  testId?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const choose = (i: number) => {
    const next = (i + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    // Alt+← is the browser's back, Ctrl+Home its own: not ours.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowDown: at + 1,
      ArrowLeft: at - 1,
      ArrowUp: at - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    choose(moves[e.key]!);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKey}
      className={cn('bg-muted inline-flex gap-1 rounded-full p-1', className)}
    >
      {options.map((o, i) => {
        const checked = i === at;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'focus-visible:ring-ring min-h-(--control-h-sm) rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2',
              checked
                ? 'bg-card text-foreground ring-input font-semibold shadow-sm ring-1'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
