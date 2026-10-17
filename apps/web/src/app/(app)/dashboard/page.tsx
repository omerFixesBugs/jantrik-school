'use client';

import type { ModuleKey } from '@jantrik/shared';
import { BookOpenCheckIcon, CalendarCheckIcon, WalletIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';

const MODULE_CARDS: {
  module: ModuleKey;
  key: 'attendance' | 'fees' | 'exams';
  icon: LucideIcon;
}[] = [
  { module: 'ATTENDANCE', key: 'attendance', icon: CalendarCheckIcon },
  { module: 'FEES', key: 'fees', icon: WalletIcon },
  { module: 'EXAMS', key: 'exams', icon: BookOpenCheckIcon },
];

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const { session } = useAuth();
  const { data: context } = useMeContext();
  if (!context) return null;

  const cards = MODULE_CARDS.filter((c) => context.modules.includes(c.module));
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          {t('welcome', { name: session?.user.name ?? '' })}
        </h1>
        <p className="text-muted-foreground">{t('subtitle', { institute: context.tenant.name })}</p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(({ key, icon: Icon }) => (
          <li key={key}>
            <Card className="h-full" data-testid={`module-card-${key}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <Icon aria-hidden className="text-muted-foreground size-5" />
                  <Badge variant="secondary">{tCommon('comingSoon')}</Badge>
                </div>
                <CardTitle>
                  <h2>{t(key)}</h2>
                </CardTitle>
                <CardDescription>{t(`${key}Text`)}</CardDescription>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
