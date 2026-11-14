import type { Metadata, Viewport } from 'next';
import { Noto_Naskh_Arabic, Plus_Jakarta_Sans } from 'next/font/google';
import localFont from 'next/font/local';
import { themeCss } from '@jantrik/shared';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { pickMessages, ROUTE_MESSAGES } from '@/i18n/route-messages';
import { DENSITY_SCRIPT } from '@/lib/density-script';
import { THEME_SCRIPT } from '@/lib/theme-script';
import { cn } from '@/lib/utils';
import { BOOT_WATCHDOG } from './boot-watchdog';
import { Providers } from './providers';
import './globals.css';

// The two Bangla faces carry only their Bangla subset (decision P2, docs/decisions-pending.md):
// Latin letters, ASCII digits and punctuation on a Bangla page fall to Plus Jakarta Sans. The
// files are Google Fonts' own Bengali subsets, kept in src/fonts with their OFL licences, because
// next/font/google would emit (and the browser download) the Latin faces too. The range is
// Google's Bengali range plus the space and no-break space (both in the files), so spaces between
// Bangla words stay in Noto and Noto stays the first available font (line metrics) on Bangla
// pages. No metric-adjusted fallback face: next/font's is local("Arial") with no unicode-range,
// so it would draw the Latin text before Jakarta was reached (Arial has no Bangla anyway).
// next/font reads its options as literals, so the two calls repeat the same range. The CSS family
// is next/font's own (from the const's name): a `font-family` declaration would rename the
// @font-face but not the CSS variable under Turbopack, and the face would never be used.
// Body: Noto Sans Bengali, a variable font (one file for every weight) whose Bangla digits are
// drawn correctly and are all one width (docs/design.md → Typography). Preloaded: it is the first
// paint. `swap`: text shows at once in the fallback on a slow network.
const notoSansBengali = localFont({
  src: [{ path: '../fonts/noto-sans-bengali/NotoSansBengali-bengali.woff2', weight: '100 900' }],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0020, U+00A0, U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1, U+11DF0-11DF1',
    },
  ],
  display: 'swap',
  adjustFontFallback: false,
  variable: '--font-body',
});
// Display: Anek Bangla, for the wordmark, page titles and the greeting only: one static weight
// (600), 56 KB. Not preloaded: on a slow phone it would share the link with the app's JavaScript;
// titles show in the body face for a moment and swap (design v2.1 performance budget).
const anekBangla = localFont({
  src: [{ path: '../fonts/anek-bangla/AnekBangla-SemiBold-bengali.woff2', weight: '600' }],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0020, U+00A0, U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1, U+11DF0-11DF1',
    },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-display',
});
// Latin text (English UI, IDs, phone numbers, Latin digits): Plus Jakarta Sans, first in the
// stack on English pages (Bangla falls through to Noto by unicode-range) and after the Bangla
// faces on Bangla pages. Not preloaded: Bangla is the first paint.
const latin = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-latin',
});
// Arabic (a madrasa's Arabic text): Noto Naskh Arabic, downloaded only if Arabic text appears.
const arabic = Noto_Naskh_Arabic({
  subsets: ['arabic'],
  display: 'swap',
  preload: false,
  variable: '--font-arabic',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('tagline') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Every theme's colours, generated from packages/shared/src/themes.ts (docs/design.md → Themes).
const THEMES_CSS = themeCss();

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const locale = await getLocale();
  // Only the texts every page needs; each area's layout adds its own (src/i18n/route-messages.ts).
  const messages = pickMessages(await getMessages(), ROUTE_MESSAGES.root);
  return (
    // data-density, data-theme and data-mode (and an owner's accent) are set by the head scripts
    // before the first paint, so the server's <html> and the browser's differ there on purpose.
    <html
      lang={locale}
      className={cn(
        'h-full antialiased',
        notoSansBengali.variable,
        anekBangla.variable,
        latin.variable,
        arabic.variable,
      )}
      suppressHydrationWarning
    >
      <head>
        <style id="themes" dangerouslySetInnerHTML={{ __html: THEMES_CSS }} />
        <script id="theme" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script id="density" dangerouslySetInnerHTML={{ __html: DENSITY_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground flex min-h-full flex-col font-sans">
        {/* A plain inline script, executed by the browser while it parses the HTML, so it runs
            even if the app's JavaScript never loads (next/script would queue it for Next's own
            runtime instead). See boot-watchdog.ts. */}
        <script id="boot-watchdog" dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG }} />
        <NextIntlClientProvider messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
