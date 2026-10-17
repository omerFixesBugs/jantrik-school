'use client';

import { ArrowLeftIcon, HammerIcon, LockIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useMeContext } from '@/lib/hooks';
import { canSee, navItem, type NavKey } from '@/lib/navigation';

/** Centered message with an icon tile and a way back. The page title is in the top bar. */
function Notice({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  const t = useTranslations('comingSoon');
  return (
    <div className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center shadow-xs">
      <span className="bg-primary-soft text-primary flex size-14 items-center justify-center rounded-2xl">
        <Icon aria-hidden className="size-7" />
      </span>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground max-w-md">{text}</p>
      <Button
        variant="outline"
        className="mt-2"
        render={<Link href="/dashboard" />}
        nativeButton={false}
      >
        <ArrowLeftIcon aria-hidden />
        {t('back')}
      </Button>
    </div>
  );
}

/** Hides a page the institute hasn't enabled or the user may not use. The API enforces it too. */
export function PageGate({ page, children }: { page: NavKey; children: ReactNode }) {
  const t = useTranslations('notAvailable');
  const { data } = useMeContext();
  if (!data) return null;
  if (!canSee(navItem(page), data)) {
    return <Notice icon={LockIcon} title={t('title')} text={t('text')} />;
  }
  return <>{children}</>;
}

/** Placeholder for modules that are not built yet. */
export function ComingSoon({ title }: { title: string }) {
  const t = useTranslations();
  return (
    <Notice
      icon={HammerIcon}
      title={`${title}: ${t('common.comingSoon')}`}
      text={t('comingSoon.text')}
    />
  );
}
