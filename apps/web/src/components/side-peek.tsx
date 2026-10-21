'use client';

import { ExternalLinkIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';

/**
 * The side peek (docs/design.md → Principles 7): a row's summary beside the list, on wide desktops
 * only (the list stays usable: this is not a modal). Esc or the close button shuts it; the full
 * page is one link away. Below 1280 px a row opens its page instead (the caller decides).
 */
export function SidePeek({
  title,
  href,
  onClose,
  children,
  testId,
}: {
  title: string;
  /** The full page. */
  href: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const t = useTranslations('table');
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // What opened the peek (a row), remembered before focus moves into it, and again when another
  // row is opened while it is open; focus goes back there when it closes.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !panel.current?.contains(active)) opener.current = active;
    heading.current?.focus();
  }, [href]);
  useEffect(() => {
    const back = opener;
    const box = panel.current;
    return () => {
      // Only when focus was in the panel (or went with it): someone typing in the search box or
      // sorting the list keeps their place.
      const now = document.activeElement;
      const lost = !now || now === document.body || Boolean(box?.contains(now));
      if (lost && back.current?.isConnected) back.current.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog or menu closing on Esc is theirs, not the peek's.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      ref={panel}
      aria-label={title}
      data-testid={testId}
      className="bg-card fixed top-(--topbar-h) end-0 bottom-0 z-20 flex w-[min(26rem,40vw)] flex-col border-s shadow-lg"
    >
      <div className="flex items-center gap-2 border-b px-(--panel-p) py-2.5">
        <h2
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-base font-semibold outline-none"
        >
          {title}
        </h2>
        <ButtonLink size="sm" variant="outline" href={href} data-testid="peek-open">
          <ExternalLinkIcon aria-hidden />
          {t('openPage')}
        </ButtonLink>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label={t('closePeek')}>
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-(--panel-p)">{children}</div>
    </aside>
  );
}
