import { THEME_PRESETS, themeSlug } from '@jantrik/shared';

export { accentCss } from '@jantrik/shared';

/**
 * The theme script for <head> (docs/design.md → Themes). Kept apart from theme.tsx (a client
 * module) so the server layout can inline the string.
 */

/** What the last page showed in this browser, for the first paint of the next page load. */
export const THEME_LAST_KEY = 'jantrik.theme.v1.last';

/** The <style> that lays an owner's accent over the preset (theme.tsx keeps it current). */
export const ACCENT_STYLE_ID = 'theme-accent';

/** A light/dark choice just made in this browser, which its other tabs follow. */
export const THEME_CHOICE_KEY = 'jantrik.theme.v1.choice';

/** The cached look: preset slug, the person's colour scheme, and an owner's accent variables. */
export interface ThemeLast {
  t: string;
  s: 'LIGHT' | 'DARK' | 'SYSTEM';
  a: { light: Record<string, string>; dark: Record<string, string> } | null;
}

const SLUGS = THEME_PRESETS.map(themeSlug).join('|');

/**
 * Runs before the first paint, so the page never flashes another theme: the last preset, mode and
 * accent this browser showed (School and the device's light/dark otherwise). Plain ES5 and a fixed
 * string (no user input); storage can be blocked (private mode), which falls back to the default.
 */
export const THEME_SCRIPT = `(function () {
  var d = document.documentElement, v = null;
  try { v = JSON.parse(localStorage.getItem('${THEME_LAST_KEY}') || 'null'); } catch (e) {}
  // The platform panel keeps its own look (School, light) whatever this browser last showed.
  if (location.pathname.indexOf('/platform') === 0) v = { t: 'school', s: 'LIGHT', a: null };
  var s = v && (v.s === 'LIGHT' || v.s === 'DARK') ? v.s : 'SYSTEM';
  var dark = s === 'DARK' || (s === 'SYSTEM' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  d.setAttribute('data-theme', v && /^(${SLUGS})$/.test(v.t) ? v.t : 'school');
  d.setAttribute('data-mode', dark ? 'dark' : 'light');
  function block(sel, vars) {
    var out = '';
    for (var k in vars || {}) if (/^[a-z0-9-]+$/.test(k) && /^#[0-9a-f]{6}$/.test(String(vars[k]))) out += '--' + k + ':' + vars[k] + ';';
    return out ? sel + '{' + out + '}' : '';
  }
  var a = v && v.a, css = '';
  if (a) {
    var p = block('html[data-theme][data-mode="dark"]', a.light);
    var dk = block('html[data-theme][data-mode="dark"]', a.dark);
    // As accentCss in @jantrik/shared: dark on screens only, the light look on paper.
    css = block('html[data-theme][data-mode="light"]', a.light) + (dk ? '@media not print{' + dk + '}' : '') + (p ? '@media print{' + p + '}' : '');
  }
  if (css) {
    var st = document.createElement('style');
    st.id = '${ACCENT_STYLE_ID}';
    st.textContent = css;
    document.head.appendChild(st);
  }
})();`;
