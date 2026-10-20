'use client';

import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { toAsciiDigits } from '@jantrik/shared';
import { SearchIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/*
 * The command palette (Ctrl/⌘ K; docs/design.md → Principles 8): pages, actions and records in one
 * box, keyboard first. Generic: the caller (app-commands.tsx for the institute app) gives it the
 * commands and, optionally, a live search. Base UI handles the arrow keys and Enter (Enter clicks
 * the highlighted item, which runs it).
 */

export interface PaletteCommand {
  id: string;
  label: string;
  /** Shown at the end of the row (a code, a class, a key). */
  hint?: string;
  /** Extra words to match: the other language's label, synonyms. */
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

// A type alias (not an interface): Base UI's group type needs an index signature.
export type PaletteGroup = {
  id: string;
  label: string;
  items: PaletteCommand[];
};

/** Lower-case, ASCII digits, single spaces: so "০১৭১১" finds "01711" and "Class" finds "class". */
export const normalizeQuery = (s: string) =>
  toAsciiDigits(s).toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export function matches(command: PaletteCommand, query: string): boolean {
  if (!query) return true;
  const hay = normalizeQuery(`${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`);
  return query.split(' ').every((word) => hay.includes(word));
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  query,
  onQueryChange,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already filtered for `query` (static commands with `matches`, records from the server). */
  groups: PaletteGroup[];
  query: string;
  onQueryChange: (query: string) => void;
  /** A live search is still running (records may still appear). */
  loading?: boolean;
}) {
  const t = useTranslations('palette');
  const visible = useMemo(() => groups.filter((g) => g.items.length > 0), [groups]);
  const mac = isApple();
  const count = visible.reduce((n, g) => n + g.items.length, 0);

  const run = (command: PaletteCommand) => {
    onOpenChange(false);
    command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="bg-foreground/25 fixed inset-0 z-50" />
        <Dialog.Popup
          aria-label={t('title')}
          data-testid="command-palette"
          className="bg-popover text-popover-foreground fixed top-[10vh] left-1/2 z-50 flex max-h-[76vh] w-[min(40rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border shadow-lg outline-none"
        >
          <Dialog.Title className="sr-only">{t('title')}</Dialog.Title>
          <Autocomplete.Root
            items={visible}
            filteredItems={visible}
            inline
            open
            mode="none"
            autoHighlight="always"
            value={query}
            onValueChange={(v) => onQueryChange(v)}
            itemToStringValue={(item: PaletteCommand) => item.label}
          >
            <div className="flex items-center gap-2.5 border-b px-3.5">
              <SearchIcon aria-hidden className="text-muted-foreground size-4.5 shrink-0" />
              <Autocomplete.Input
                autoFocus
                placeholder={t('placeholder')}
                className="h-12 min-w-0 flex-1 bg-transparent text-(length:--input-fs) outline-none placeholder:text-muted-foreground"
              />
              {loading && <span className="text-muted-foreground text-xs">{t('searching')}</span>}
            </div>
            <Autocomplete.List className="flex-1 overflow-y-auto p-1.5">
              {(group: PaletteGroup) => (
                <Autocomplete.Group key={group.id} items={group.items} className="pb-1">
                  <Autocomplete.GroupLabel className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">
                    {group.label}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: PaletteCommand) => (
                      <Autocomplete.Item
                        key={item.id}
                        value={item}
                        onClick={() => run(item)}
                        className="data-highlighted:bg-accent data-highlighted:text-accent-foreground flex min-h-(--control-h) cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-sm outline-none select-none"
                      >
                        <item.icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint && (
                          <span className="text-muted-foreground shrink-0 text-xs" dir="auto">
                            {item.hint}
                          </span>
                        )}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
            {visible.length === 0 && (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                {loading ? t('searching') : t('empty')}
              </p>
            )}
            {/* Always mounted, so a change is announced (a region inserted with its text is not). */}
            <p className="sr-only" role="status">
              {loading ? t('searching') : count === 0 ? t('empty') : t('results', { count })}
            </p>
          </Autocomplete.Root>
          <div className="text-muted-foreground bg-muted flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3.5 py-2 text-xs">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('move')}
            </span>
            <span>
              <Kbd>Enter</Kbd> {t('open')}
            </span>
            <span>
              <Kbd>Esc</Kbd> {t('close')}
            </span>
            <span className="ms-auto">
              <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd> <Kbd>K</Kbd>
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** ⌘ on Apple keyboards, Ctrl elsewhere. Only rendered in the browser (behind the session). */
export const isApple = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

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
