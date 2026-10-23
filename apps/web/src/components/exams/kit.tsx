'use client';

import { formatDate, type ExamKind, type ExamStatus, type MarkSheetStatus } from '@jantrik/shared';
import { CheckIcon, LockIcon, PencilLineIcon, RotateCcwIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { FormEvent, ReactNode } from 'react';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Locale } from '@/i18n/config';
import { useExamError, useExamRoles } from '@/lib/exams/api';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/** The exams area's sections (setup is for OWNER/ADMIN); never printed. */
export function ExamsTabs() {
  const t = useTranslations('exams.common.tabs');
  const pathname = usePathname();
  const { isAdmin } = useExamRoles();
  const tabs = [
    { key: 'exams', href: '/exams', on: !pathname.startsWith('/exams/setup') },
    ...(isAdmin
      ? [{ key: 'setup', href: '/exams/setup', on: pathname.startsWith('/exams/setup') }]
      : []),
  ] as const;
  return (
    <nav
      aria-label={t('label')}
      className="-mx-1 overflow-x-auto px-1 print:hidden"
      data-testid="exams-tabs"
    >
      <ul className="flex w-max gap-2 py-1">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.on ? 'page' : undefined}
              data-testid={`exams-tab-${tab.key}`}
              className={cn(
                'inline-flex min-h-(--control-h) items-center rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors',
                'focus-visible:ring-ring focus-visible:ring-3 focus-visible:outline-none',
                tab.on
                  ? 'border-primary-ink bg-primary-soft text-accent-foreground'
                  : 'bg-card hover:bg-muted',
              )}
            >
              {t(tab.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A sheet's state in words with an icon (never colour alone). */
export function SheetStatusPill({ status }: { status: MarkSheetStatus }) {
  const t = useTranslations('exams.common.sheetStatus');
  if (status === 'LOCKED')
    return (
      <Pill tone="neutral">
        <LockIcon aria-hidden className="size-3.5" />
        {t('LOCKED')}
      </Pill>
    );
  if (status === 'SUBMITTED')
    return (
      <Pill tone="success">
        <CheckIcon aria-hidden className="size-3.5" />
        {t('SUBMITTED')}
      </Pill>
    );
  return (
    <Pill tone="warning">
      <PencilLineIcon aria-hidden className="size-3.5" />
      {t('DRAFT')}
    </Pill>
  );
}

export function ExamStatusPill({ status }: { status: ExamStatus }) {
  const t = useTranslations('exams.common.examStatus');
  return <Pill tone={status === 'OPEN' ? 'accent' : 'neutral'}>{t(status)}</Pill>;
}

/** "Half-yearly · 1–15 June 2026" */
export function useExamLine() {
  const t = useTranslations('exams.common.kind');
  const locale = useLocale() as Locale;
  return (e: { kind: ExamKind; startsOn: string; endsOn: string }) =>
    `${t(e.kind)} · ${formatDate(e.startsOn, locale)}${e.endsOn !== e.startsOn ? ` – ${formatDate(e.endsOn, locale)}` : ''}`;
}

export function useName() {
  const locale = useLocale() as Locale;
  return (x: { nameBn: string | null; nameEn: string | null }) =>
    displayName(x.nameBn, x.nameEn, locale);
}

/** A part that failed to load: what happened, and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('exams.common');
  const message = useExamError();
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message(error)}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcwIcon aria-hidden />
          {t('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** A dialog holding a form; scrolls inside itself on short phone screens. */
export function ExamDialog({
  onClose,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  children,
  testId,
  submitTestId,
  wide,
  destructive,
}: {
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending?: boolean;
  onSubmit: () => void;
  children?: ReactNode;
  testId?: string;
  submitTestId?: string;
  wide?: boolean;
  destructive?: boolean;
}) {
  const t = useTranslations('exams.common');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
        data-testid={testId}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={pending}
              data-testid={submitTestId}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
