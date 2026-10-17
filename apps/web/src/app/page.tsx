import { useTranslations } from 'next-intl';
import { HealthStatus } from '@/components/health-status';

export default function Home() {
  const t = useTranslations('app');
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 px-4 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('name')}</h1>
        <p className="text-muted-foreground">{t('tagline')}</p>
      </header>
      <HealthStatus />
    </main>
  );
}
