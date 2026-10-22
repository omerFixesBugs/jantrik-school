'use client';

import { useSyncExternalStore } from 'react';

/*
 * Phones open the on-screen keyboard over the page: the layout viewport keeps its height and only
 * the visual viewport shrinks (iOS Safari, and Chrome on Android by default). A bottom sheet
 * pinned to the layout viewport's bottom would sit under the keyboard, so the sheet reads these
 * two numbers and lifts itself above it, no taller than what is visible.
 */

function subscribe(onChange: () => void) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  return () => {
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
  };
}

/** Pinch zoom also shrinks the visual viewport: only an unzoomed page means a keyboard. */
const unzoomed = (vv: VisualViewport) => Math.abs(vv.scale - 1) < 0.01;

/** How far the keyboard covers the bottom of the layout viewport, in px (0 when closed). */
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv || !unzoomed(vv)) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/** The height people can see, in px. */
function visibleHeight(): number {
  const vv = window.visualViewport;
  return Math.round(vv && unzoomed(vv) ? vv.height : window.innerHeight);
}

const none = () => () => {};
const zero = () => 0;

/** Both numbers while `active` (the sheet is open); zeros, and no listeners, otherwise. */
export function useVisualViewport(active: boolean): { keyboard: number; height: number } {
  const listen = active ? subscribe : none;
  const keyboard = useSyncExternalStore(listen, active ? keyboardInset : zero, zero);
  const height = useSyncExternalStore(listen, active ? visibleHeight : zero, zero);
  return { keyboard, height };
}
