'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMeContext } from '@/lib/hooks';
import { canSee, navItem, type NavKey } from '@/lib/navigation';

/** Hides a page the institute hasn't enabled or the user may not use. The API enforces it too. */
export function PageGate({ page, children }: { page: NavKey; children: ReactNode }) {
  const t = useTranslations('notAvailable');
  const { data } = useMeContext();
  if (!data) return null;
  if (!canSee(navItem(page), data)) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1>{t('title')}</h1>
          </CardTitle>
          <CardDescription>{t('text')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <>{children}</>;
}

/** Placeholder for modules that are not built yet. */
export function ComingSoon({ title }: { title: string }) {
  const t = useTranslations();
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>
          <h1>{title}</h1>
        </CardTitle>
        <CardDescription>{t('comingSoon.text')}</CardDescription>
      </CardHeader>
    </Card>
  );
}
