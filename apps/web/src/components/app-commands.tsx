'use client';

import {
  createGoSequence,
  isHelpShortcut,
  isNewShortcut,
  isPaletteShortcut,
  isSearchShortcut,
  type MeContext,
} from '@jantrik/shared';
import { SearchIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { isApple, Kbd } from '@/components/kbd';
import { canSee, navItem } from '@/lib/navigation';

/**
 * The palette's code (the dialog, the search, the commands) is loaded the first time it is
 * wanted: on the shortcut, or when a pointer or focus reaches its button, so it is usually there
 * by the time it opens. The first screen of every page goes without it (docs/design.md →
 * Performance budget).
 */
const loadPalette = () => import('@/components/app-palette');
const PaletteDialogs = dynamic(() => loadPalette().then((m) => m.PaletteDialogs), {
  ssr: false,
});

/** Never fire a shortcut while someone types (an input, a select, an editor, the palette). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="combobox"]') !== null
  );
}

/** A dialog, menu or list is open: page shortcuts would act behind it (and lose its input). */
const overlayOpen = () =>
  document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  ) !== null;

/**
 * The institute app's palette and keyboard layer: Ctrl/⌘ K, `?`, `/` (the page's search), `n`
 * (the page's "add" button) and `g` + letter. Rendered once by the shell.
 */
export function AppCommands({
  context,
  open,
  onOpenChange,
}: {
  context: MeContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  // Mounted once wanted, then kept (so closing animates and reopening is instant).
  const [wanted, setWanted] = useState(false);
  if ((open || help) && !wanted) setWanted(true);

  // The keyboard layer. `g` goes only where the sidebar would.
  const seesStudents = canSee(navItem('students'), context);
  const attendance = canSee(navItem('attendance'), context);
  const exams = canSee(navItem('exams'), context);
  const goTargets = useMemo(() => {
    const targets: Record<string, string> = { KeyD: '/dashboard' };
    if (seesStudents) targets['KeyS'] = '/students';
    if (attendance) {
      targets['KeyA'] = '/attendance';
      targets['KeyT'] = '/attendance/today';
      targets['KeyR'] = '/attendance/register';
    }
    if (exams) targets['KeyE'] = '/exams';
    return targets;
  }, [seesStudents, attendance, exams]);
  useEffect(() => {
    const goTo = createGoSequence<string>(goTargets);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (isPaletteShortcut(e)) {
        // Toggles the palette; never opens it over another dialog.
        if (open || !overlayOpen()) {
          e.preventDefault();
          onOpenChange(!open);
        }
        return;
      }
      if (open || isTypingTarget(e.target) || overlayOpen()) return;
      if (isHelpShortcut(e)) {
        e.preventDefault();
        setHelp(true);
      } else if (isSearchShortcut(e)) {
        const field = document.querySelector<HTMLElement>('[data-page-search]');
        if (field) {
          e.preventDefault();
          field.focus();
        }
      } else if (isNewShortcut(e)) {
        document.querySelector<HTMLElement>('[data-page-new]')?.click();
      } else {
        const href = goTo(e, performance.now());
        if (href) router.push(href);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange, router, goTargets]);

  if (!wanted) return null;
  return (
    <PaletteDialogs
      context={context}
      open={open}
      onOpenChange={onOpenChange}
      help={help}
      onHelpChange={setHelp}
    />
  );
}

/** Starts loading the palette's code ahead of the click (hover, focus, a finger landing). */
const preloadPalette = () => void loadPalette().catch(() => undefined);

/** The top bar's way into the palette: looks like a search field, is a button. */
export function PaletteButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('palette');
  const mac = isApple();
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={preloadPalette}
      onPointerDown={preloadPalette}
      onFocus={preloadPalette}
      data-testid="palette-button"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring bg-card hover:bg-muted flex h-(--control-h) min-w-(--control-h) shrink-0 items-center justify-center gap-2 rounded-full border px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-offset-2 lg:w-72 lg:justify-start"
    >
      <SearchIcon aria-hidden className="size-4 shrink-0" />
      <span className="hidden min-w-0 truncate lg:block">{t('button')}</span>
      <span className="sr-only lg:hidden">{t('title')}</span>
      <span aria-hidden className="ms-auto hidden gap-1 lg:flex">
        <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
