import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Wide, short forms (docs/design.md → Principles 5): related fields side by side, 1 column on a
 * phone, 2 from 768 px, 3 from 1280 px; the save bar always on screen.
 */

/** The field grid. Give a field `className="md:col-span-2"` (or `xl:col-span-3`) to widen it. */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-3', className)}>
      {children}
    </div>
  );
}

/**
 * Save and cancel, stuck to the bottom of the screen while the form scrolls. `note` says what
 * is pending ("unsaved changes").
 */
export function ActionBar({
  children,
  note,
  className,
}: {
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-card/95 sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-2.5 backdrop-blur-sm sm:-mx-6 sm:px-6',
        'pb-[max(0.625rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      {note && <div className="text-muted-foreground me-auto text-sm">{note}</div>}
      {children}
    </div>
  );
}
