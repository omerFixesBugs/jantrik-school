import type { Metadata, Viewport } from 'next';
import { Anek_Bangla, Hind_Siliguri } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';
import { BOOT_WATCHDOG } from './boot-watchdog';
import { Providers } from './providers';
import './globals.css';

// Body in Hind Siliguri, headings in Anek Bangla; both cover Bangla and Latin
// (docs/design.md → Typography).
const body = Hind_Siliguri({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
});
const display = Anek_Bangla({
  subsets: ['bengali', 'latin'],
  axes: ['wdth'],
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
    <html lang={locale} className={cn('h-full antialiased', body.variable, display.variable)}>
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
