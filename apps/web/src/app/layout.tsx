import type { Metadata, Viewport } from 'next';
import { Anek_Bangla, Noto_Sans_Bengali } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { DENSITY_SCRIPT } from '@/lib/density-script';
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
// Display: Anek Bangla, for the wordmark and page titles only: one static weight (600), 55 KB,
// instead of the variable width × weight file (437 KB) v1 preloaded.
const display = Anek_Bangla({
  subsets: ['bengali'],
  weight: '600',
  display: 'swap',
  variable: '--font-display',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('tagline') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const locale = await getLocale();
  return (
    // data-density is set by DENSITY_SCRIPT before the first paint, so the server's <html> and the
    // browser's differ by that attribute on purpose.
    <html
      lang={locale}
      className={cn('h-full antialiased', body.variable, display.variable)}
      suppressHydrationWarning
    >
      <head>
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
