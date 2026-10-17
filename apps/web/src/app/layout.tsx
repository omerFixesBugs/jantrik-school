import type { Metadata, Viewport } from 'next';
import { Geist, Hind_Siliguri } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';
import { Providers } from './providers';
import './globals.css';

// Latin text in Geist; Bangla in Hind Siliguri (see --app-font-stack in globals.css).
const latin = Geist({ subsets: ['latin'], variable: '--font-latin' });
const bangla = Hind_Siliguri({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-bangla',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('tagline') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={cn('h-full antialiased', latin.variable, bangla.variable)}>
      <body className="bg-background text-foreground flex min-h-full flex-col font-sans">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
