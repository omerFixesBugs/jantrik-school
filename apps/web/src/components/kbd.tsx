import { cn } from '@/lib/utils';

/** ⌘ on Apple keyboards, Ctrl elsewhere. Only rendered in the browser (behind the session). */
export const isApple = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** A key cap (the palette, its button and the shortcuts list). */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'bg-card text-foreground inline-flex min-w-5 items-center justify-center rounded border px-1 font-sans text-[0.75rem] leading-4',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
