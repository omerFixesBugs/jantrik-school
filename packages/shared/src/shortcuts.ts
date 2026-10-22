/**
 * Keyboard shortcuts (docs/design.md → Principles 8). Matched by the key's position
 * (`KeyboardEvent.code`), not its character, so they work with Bangla keyboard layouts too, and
 * never while an input method is composing.
 */
export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Ctrl+K (or ⌘K on a Mac): the command palette. */
export function isPaletteShortcut(e: KeyLike): boolean {
  return e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing;
}

/** A plain key: no Ctrl, ⌘ or Alt (Shift only when asked), not composing. */
function plain(e: KeyLike, shift = false): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey === shift && !e.isComposing;
}

/** `?`: the shortcut list (Shift + the key right of `.`). */
export const isHelpShortcut = (e: KeyLike): boolean => e.code === 'Slash' && plain(e, true);
/** `/`: focus the page's search. */
export const isSearchShortcut = (e: KeyLike): boolean => e.code === 'Slash' && plain(e);
/** `n`: new (the page's main "add" action). */
export const isNewShortcut = (e: KeyLike): boolean => e.code === 'KeyN' && plain(e);

/**
 * `g` then a letter, within `timeoutMs`: go somewhere. `targets` maps the second key's code
 * (e.g. 'KeyD') to a destination. Returns a function to feed every keydown; it answers the
 * destination when a sequence completes, else null.
 */
export function createGoSequence<T>(
  targets: Readonly<Record<string, T>>,
  timeoutMs = 1500,
): (e: KeyLike, now: number) => T | null {
  let armedAt: number | null = null;
  return (e, now) => {
    if (!plain(e)) {
      armedAt = null;
      return null;
    }
    if (armedAt !== null && now - armedAt <= timeoutMs) {
      armedAt = null;
      return targets[e.code] ?? null;
    }
    armedAt = e.code === 'KeyG' ? now : null;
    return null;
  };
}
