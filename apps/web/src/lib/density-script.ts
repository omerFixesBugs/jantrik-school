/**
 * The density script for <head> (docs/design.md → Density). Kept apart from density.tsx (a client
 * module) so the server layout can inline the string.
 */

import { COMPACT_MIN_WIDTH } from '@jantrik/shared';

/** The last density shown in this browser, for the first paint of the next page load. */
export const DENSITY_LAST_KEY = 'jantrik.density.v1.last';

/**
 * Runs before the first paint, so the page never jumps between densities: the last density this
 * browser showed, else compact on a wide screen. Plain ES5 and a fixed string (no user input);
 * storage can be blocked (private mode), which falls back to the screen width.
 */
export const DENSITY_SCRIPT = `(function () {
  var m = null;
  try { m = localStorage.getItem('${DENSITY_LAST_KEY}'); } catch (e) {}
  if (m !== 'compact' && m !== 'comfortable') {
    m = window.matchMedia && window.matchMedia('(min-width: ${COMPACT_MIN_WIDTH}px)').matches ? 'compact' : 'comfortable';
  }
  document.documentElement.setAttribute('data-density', m);
})();`;
