'use client';

import {
  accentOverrideVars,
  isColorScheme,
  themeSlug,
  type Appearance,
  type ColorScheme,
  type ThemeMode,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  ACCENT_STYLE_ID,
  THEME_CHOICE_KEY,
  THEME_LAST_KEY,
  accentCss,
  type ThemeLast,
} from '@/lib/theme-script';

/*
 * The institute's theme and the person's light/dark choice (docs/design.md → Themes). The head
 * script (theme-script.ts) paints the last look before React runs; this provider then applies
 * what the institute (GET /me/context) and the person (the session's colorScheme) say, follows the
 * device when the choice is SYSTEM, and remembers the look for the next first paint.
 */

interface ThemeValue {
  /** The person's choice. */
  scheme: ColorScheme;
  /** What is showing (SYSTEM resolved). */
  mode: ThemeMode;
  setScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const darkQuery = '(prefers-color-scheme: dark)';
const deviceDark = () => window.matchMedia(darkQuery).matches;
function useSystemDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(darkQuery);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    deviceDark,
    () => false,
  );
}

/**
 * A choice made on this page, until the next load brings it back in the session: the provider
 * remounts (switching institute and coming back, a retried context) without losing it.
 */
let pageChoice: { user: string; scheme: ColorScheme } | null = null;

/** Saves go one after another, so the account ends on the last choice made. */
let saving: Promise<unknown> = Promise.resolve();

function accentStyle(): HTMLStyleElement {
  let el = document.getElementById(ACCENT_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = ACCENT_STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

function applyLook(slug: string, mode: ThemeMode, accent: ThemeLast['a']) {
  const root = document.documentElement;
  root.setAttribute('data-theme', slug);
  root.setAttribute('data-mode', mode);
  // The whole accent sheet is rewritten, so one the head script laid from the cache (another
  // institute, another person, an accent since reset) never outlives this look.
  const css = accentCss(accent);
  if (css || document.getElementById(ACCENT_STYLE_ID)) accentStyle().textContent = css;
}

function remember(last: ThemeLast) {
  try {
    localStorage.setItem(THEME_LAST_KEY, JSON.stringify(last));
  } catch {
    // Private mode: the next page load paints the default first.
  }
}

/**
 * Signed out (here or in another tab, or the session ended): the next person on this browser
 * starts from the default look, School and their own device's light or dark.
 */
export function resetLook() {
  pageChoice = null;
  remember({ t: 'school', s: 'SYSTEM', a: null });
  applyLook('school', deviceDark() ? 'dark' : 'light', null);
}

export function ThemeProvider({
  appearance,
  children,
}: {
  appearance: Appearance;
  children: ReactNode;
}) {
  const t = useTranslations('shell');
  const { client, session } = useAuth();
  const user = session?.user.id ?? '';
  const [chosen, setChosen] = useState<ColorScheme | null>(() => {
    const c = pageChoice;
    return c && c.user === user ? c.scheme : null;
  });
  const scheme = chosen ?? session?.user.colorScheme ?? 'SYSTEM';
  const systemDark = useSystemDark();
  const mode: ThemeMode =
    scheme === 'DARK' || (scheme === 'SYSTEM' && systemDark) ? 'dark' : 'light';
  const slug = themeSlug(appearance.preset);
  const accent = useMemo(
    () => (appearance.accent ? accentOverrideVars(appearance.accent, appearance.preset) : null),
    [appearance.accent, appearance.preset],
  );

  useEffect(() => {
    applyLook(slug, mode, accent);
    remember({ t: slug, s: scheme, a: accent });
  }, [slug, mode, scheme, accent]);

  // The person chose in another tab of this browser (one session per browser: the same person).
  // Only a choice counts, never a tab merely remembering what it shows.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_CHOICE_KEY || !e.newValue) return;
      try {
        const s = (JSON.parse(e.newValue) as { s?: unknown }).s;
        if (isColorScheme(s)) {
          pageChoice = { user, scheme: s };
          setChosen(s);
        }
      } catch {
        // Not ours to read.
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [user]);

  const setScheme = useCallback(
    (next: ColorScheme) => {
      const before = scheme;
      pageChoice = { user, scheme: next };
      setChosen(next);
      try {
        localStorage.setItem(THEME_CHOICE_KEY, JSON.stringify({ s: next, at: Date.now() }));
      } catch {
        // Private mode: other tabs follow on their next load.
      }
      // Kept on the account, so the person's other devices follow (docs/design.md → Themes). If
      // that fails, and nothing newer was chosen since, the choice is put back: it would not
      // survive the next load.
      saving = saving.then(() =>
        client
          .api('/me/preferences', { method: 'PATCH', json: { colorScheme: next } })
          .catch(() => {
            if (pageChoice?.scheme !== next) return;
            pageChoice = { user, scheme: before };
            setChosen(before);
            toast.error(t('schemeSaveFailed'));
          }),
      );
    },
    [client, scheme, user, t],
  );

  const value = useMemo(() => ({ scheme, mode, setScheme }), [scheme, mode, setScheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme outside ThemeProvider');
  return value;
}

/**
 * The platform panel keeps its own look whatever an institute or a person chose: School, light,
 * with the slate board (data-board on its root), and no institute accent. Put back on leaving.
 */
export function usePlatformLook() {
  useEffect(() => {
    const root = document.documentElement;
    const before = { theme: root.getAttribute('data-theme'), mode: root.getAttribute('data-mode') };
    const sheet = document.getElementById(ACCENT_STYLE_ID) as HTMLStyleElement | null;
    root.setAttribute('data-theme', 'school');
    root.setAttribute('data-mode', 'light');
    if (sheet) sheet.media = 'not all';
    return () => {
      if (before.theme) root.setAttribute('data-theme', before.theme);
      if (before.mode) root.setAttribute('data-mode', before.mode);
      if (sheet) sheet.media = '';
    };
  }, []);
}
