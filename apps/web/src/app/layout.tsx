import type { Metadata, Viewport } from 'next';
import {
  Anek_Bangla,
  Noto_Naskh_Arabic,
  Noto_Sans_Bengali,
  Plus_Jakarta_Sans,
} from 'next/font/google';
import { themeCss } from '@jantrik/shared';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { DENSITY_SCRIPT } from '@/lib/density-script';
import { THEME_SCRIPT } from '@/lib/theme-script';
import { cn } from '@/lib/utils';
import { BOOT_WATCHDOG } from './boot-watchdog';
import { Providers } from './providers';
import './globals.css';

// Body: Noto Sans Bengali, a variable font (one file per script for every weight) whose Bangla
// digits are drawn correctly and are all one width (docs/design.md → Typography). Self-hosted by
// next/font and split by unicode-range; only the Bangla file is preloaded, the Latin one loads
// when Latin text appears. `swap`: text shows at once in the fallback on a slow network.
const body = Noto_Sans_Bengali({
  subsets: ['bengali'],
  display: 'swap',
  variable: '--font-body',
});
// Display: Anek Bangla, for the wordmark, page titles and the greeting only: one static weight
// (600), 55 KB. Not preloaded: on a slow phone it would share the link with the app's JavaScript;
// titles show in the body face for a moment and swap (design v2.1 performance budget).
const display = Anek_Bangla({
  subsets: ['bengali'],
  weight: '600',
  display: 'swap',
  preload: false,
  variable: '--font-display',
});
// Latin text (English UI, IDs, phone numbers, Latin digits): Plus Jakarta Sans, first in the
// stack; Bangla falls through to Noto by unicode-range. Not preloaded: Bangla is the first paint.
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
  return (
    // data-density, data-theme and data-mode (and an owner's accent) are set by the head scripts
    // before the first paint, so the server's <html> and the browser's differ there on purpose.
    <html
      lang={locale}
      className={cn(
        'h-full antialiased',
        body.variable,
        display.variable,
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
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
