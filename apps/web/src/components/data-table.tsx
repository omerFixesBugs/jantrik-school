'use client';

import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, Columns3Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/*
 * The dense table (docs/design.md → Layout): a sticky header under the top bar, sortable headers,
 * numbers right-aligned and tabular, rows that open (a click or Space/Enter, ↑↓ between rows), and
 * row actions that show on hover and focus (always on touch). Row height and padding come from
 * the density tokens. Phones get cards from the page instead.
 */

export interface DataColumn<T> {
  id: string;
  /** The header text (also the column chooser's label). */
  header: string;
  cell: (row: T) => ReactNode;
  /** 'end' for numbers. */
  align?: 'start' | 'end';
  /** The API's sort key; no key, no sorting. */
  sortKey?: string;
  /** Can be hidden in the column chooser (the first column never). */
  hideable?: boolean;
  className?: string;
}

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

/** Clicks on these inside a row are their own (a link, a call button), not "open the row". */
const OWN_CLICK =
  'a, button, input, select, textarea, label, [role="menuitem"], [role="checkbox"], [role="switch"], [role="button"], [role="combobox"]';

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowLabel,
  hidden = [],
  sort,
  onSortChange,
  onRowOpen,
  activeKey,
  actions,
  footer,
  caption,
  testId,
  scrollX = false,
  className,
}: {
  columns: DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Read out for a row ("তাসনিম রহমান, ষষ্ঠ শ্রেণি ক"). */
  rowLabel?: (row: T) => string;
  hidden?: readonly string[];
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  onRowOpen?: (row: T) => void;
  /** The row open in the side peek. */
  activeKey?: string | null;
  /** Row actions, at the end of the row: quiet until the row is hovered or focused. */
  actions?: (row: T) => ReactNode;
  /** A totals row (`<tr>` cells), in `tfoot`. */
  footer?: ReactNode;
  caption: string;
  testId?: string;
  /**
   * Scroll sideways at every width, the header not sticking: for a table that shares the width
   * with a side peek, where it may no longer fit.
   */
  scrollX?: boolean;
  className?: string;
}) {
  const t = useTranslations('table');
  const body = useRef<HTMLTableSectionElement>(null);
  const shown = columns.filter((c, i) => i === 0 || !hidden.includes(c.id));

  const moveFocus = (from: HTMLTableRowElement, step: 1 | -1) => {
    const all = [...(body.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]') ?? [])];
    all[all.indexOf(from) + step]?.focus();
  };
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return; // keys inside a link or button are theirs
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
    } else if ((e.key === 'Enter' || e.key === ' ') && onRowOpen) {
      e.preventDefault();
      onRowOpen(row);
    }
  };
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowOpen || (e.target as HTMLElement).closest(OWN_CLICK)) return;
    onRowOpen(row);
  };

  return (
    // From 1280 px the table fits and the header sticks under the top bar (overflow-x clip: an
    // auto box would trap the sticky header inside it); narrower, it scrolls sideways instead and
    // the header does not stick (inside the scrolling box its top offset would cover the rows).
    <div
      className={cn(
        'bg-card overflow-x-auto rounded-lg border',
        !scrollX && 'xl:overflow-x-clip',
        className,
      )}
    >
      <table className="w-full text-sm" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {shown.map((c) => {
              // Only a sortable column can be the sorted one (undefined === undefined is not a match).
              const sorted = c.sortKey && sort && sort.key === c.sortKey ? sort.dir : null;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={
                    sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                  }
                  className={cn(
                    'bg-card text-muted-foreground h-(--row-h) border-b px-(--cell-px) text-sm font-medium whitespace-nowrap first:ps-4',
                    !scrollX && 'xl:sticky xl:top-(--topbar-h) xl:z-10',
                    c.align === 'end' ? 'text-end' : 'text-start',
                    c.className,
                  )}
                >
                  {c.sortKey && onSortChange ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange({
                          key: c.sortKey!,
                          dir: sorted === 'asc' ? 'desc' : 'asc',
                        })
                      }
                      className={cn(
                        'hover:text-foreground focus-visible:ring-ring -mx-1 inline-flex items-center gap-1 rounded px-1 outline-none focus-visible:ring-2',
                        sorted && 'text-foreground',
                        c.align === 'end' && 'flex-row-reverse',
                      )}
                    >
                      {c.header}
                      {sorted === 'asc' ? (
                        <ArrowUpIcon aria-hidden className="size-3.5" />
                      ) : sorted === 'desc' ? (
                        <ArrowDownIcon aria-hidden className="size-3.5" />
                      ) : (
                        <ChevronsUpDownIcon aria-hidden className="size-3.5 opacity-60" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {actions && (
              <th
                scope="col"
                className={cn(
                  'bg-card w-px border-b pe-3',
                  !scrollX && 'xl:sticky xl:top-(--topbar-h) xl:z-10',
                )}
              >
                <span className="sr-only">{t('actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                data-row
                tabIndex={onRowOpen ? 0 : undefined}
                aria-label={rowLabel?.(row)}
                aria-current={activeKey === key ? 'true' : undefined}
                onKeyDown={(e) => onRowKey(e, row)}
                onClick={(e) => onRowClick(e, row)}
                className={cn(
                  'group/row focus-visible:ring-ring border-b outline-none last:border-0 focus-visible:ring-2 focus-visible:ring-inset',
                  onRowOpen && 'cursor-default hover:bg-muted/70',
                  activeKey === key && 'bg-primary-soft hover:bg-primary-soft',
                )}
              >
                {shown.map((c) => (
                  <td
                    key={c.id}
                    className={cn(
                      'h-(--row-h) px-(--cell-px) py-(--cell-py) align-middle first:ps-4',
                      c.align === 'end' && 'num',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
                {actions && (
                  <td className="w-px pe-3 text-end whitespace-nowrap">
                    <div className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-aria-[current=true]/row:opacity-100 [@media(hover:none)]:opacity-100">
                      {actions(row)}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        {footer && <tfoot className="bg-muted border-t font-medium">{footer}</tfoot>}
      </table>
    </div>
  );
}

/** Show or hide a table's columns; the choice is the person's own (useHiddenColumns). */
export function ColumnChooser<T>({
  columns,
  hidden,
  onChange,
}: {
  columns: DataColumn<T>[];
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
}) {
  const t = useTranslations('table');
  const hideable = columns.filter((c, i) => i > 0 && c.hideable);
  if (hideable.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" data-testid="column-chooser">
            <Columns3Icon aria-hidden />
            {t('columns')}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('showColumns')}</DropdownMenuLabel>
          {hideable.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={!hidden.includes(c.id)}
              onCheckedChange={(on) =>
                onChange(on ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])
              }
            >
              {c.header}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
