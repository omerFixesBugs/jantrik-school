'use client';

import { BookmarkPlusIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { canonicalQuery, type SavedView } from '@/lib/view-state';
import { cn } from '@/lib/utils';

/**
 * Saved views as tabs over a table (docs/design.md → Principles 6): "All" plus the person's own
 * named filter sets. A view is a URL query, so choosing one is the same as following a link.
 */
export function SavedViews({
  views,
  query,
  keys,
  onSelect,
  onSave,
  onRemove,
}: {
  views: readonly SavedView[];
  /** The query showing now. */
  query: string;
  /** The query keys that make up a view (filters and sort, not paging). */
  keys: readonly string[];
  onSelect: (query: string) => void;
  onSave: (name: string, query: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations('table');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const now = canonicalQuery(query, keys);
  const active = views.find((v) => canonicalQuery(v.query, keys) === now);
  const unsaved = now !== '' && !active;

  const save = () => {
    if (!name.trim()) return;
    onSave(name, now);
    setName('');
    setNaming(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="saved-views">
      {/* Tabs once there is a view to switch to; until then only "keep this filter". */}
      {views.length > 0 && (
        <nav aria-label={t('views')} className="flex flex-wrap items-center gap-1.5">
          <ViewTab label={t('allView')} current={now === ''} onClick={() => onSelect('')} />
          {views.map((v) => {
            const current = active?.id === v.id;
            // One frame, two buttons side by side: the view, and removing it.
            return (
              <span
                key={v.id}
                className={cn(
                  'inline-flex rounded-md border',
                  current ? 'border-primary bg-primary-soft' : 'bg-card',
                )}
              >
                <ViewTab
                  label={v.name}
                  current={current}
                  onClick={() => onSelect(v.query)}
                  framed={false}
                  className="rounded-e-none pe-1.5"
                />
                <button
                  type="button"
                  aria-label={t('removeView', { name: v.name })}
                  onClick={() => onRemove(v.id)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-w-(--control-h-sm) items-center justify-center rounded-e-md outline-none focus-visible:ring-2"
                >
                  <XIcon aria-hidden className="size-3.5" />
                </button>
              </span>
            );
          })}
        </nav>
      )}
      {naming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex items-center gap-1.5"
        >
          <label htmlFor="view-name" className="sr-only">
            {t('viewName')}
          </label>
          <Input
            id="view-name"
            autoFocus
            value={name}
            maxLength={40}
            placeholder={t('viewName')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
            className="h-(--control-h-sm) w-44"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            {t('saveView')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
            {t('cancel')}
          </Button>
        </form>
      ) : (
        unsaved && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setNaming(true)}
            data-testid="save-view"
          >
            <BookmarkPlusIcon aria-hidden />
            {t('keepView')}
          </Button>
        )
      )}
    </div>
  );
}

function ViewTab({
  label,
  current,
  onClick,
  framed = true,
  className,
}: {
  label: string;
  current: boolean;
  onClick: () => void;
  /** Its own border and fill (false inside a saved view's frame). */
  framed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring inline-flex min-h-(--control-h-sm) items-center rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        current ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
        framed && 'border',
        framed && (current ? 'border-primary bg-primary-soft' : 'bg-card'),
        className,
      )}
    >
      {label}
    </button>
  );
}
