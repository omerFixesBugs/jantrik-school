'use client';

import { formatCount } from '@jantrik/shared';
import { InfoIcon, PlayIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { FeeConfirmDialog, useFeeMutation } from './kit';

/*
 * Dues jobs (OWNER/ADMIN). Both change money, so both are confirmed first and say what they
 * touch. The whole institute runs in the background (202); a few students run at once.
 */

/** "Generate dues now" or "recalculate unpaid dues" for the whole institute, with its confirm. */
export function DuesJobButton({
  kind,
  disabled,
  variant = 'outline',
}: {
  kind: 'generate' | 'recalculate';
  disabled?: boolean;
  variant?: 'outline' | 'default';
}) {
  const t = useTranslations('fees.setup.dues');
  const { client } = useAuth();
  const [open, setOpen] = useState(false);
  const run = useFeeMutation(
    () =>
      kind === 'generate'
        ? client.api('/fees/dues/generate', { method: 'POST' })
        : client.api('/fees/dues/recalculate', { method: 'POST', json: {} }),
    {
      success: kind === 'generate' ? t('generateStarted') : t('recalculateStarted'),
      onSuccess: () => setOpen(false),
    },
  );
  const Icon = kind === 'generate' ? PlayIcon : RefreshCwIcon;
  return (
    <>
      <Button
        variant={variant}
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid={`fees-${kind}-dues`}
      >
        <Icon aria-hidden />
        {kind === 'generate' ? t('generate') : t('recalculate')}
      </Button>
      {open && (
        <FeeConfirmDialog
          title={kind === 'generate' ? t('generateTitle') : t('recalculateTitle')}
          body={kind === 'generate' ? t('generateBody') : t('recalculateBody')}
          confirmLabel={kind === 'generate' ? t('generateConfirm') : t('recalculateConfirm')}
          pending={run.isPending}
          onConfirm={() => run.mutate(undefined)}
          onClose={() => setOpen(false)}
          confirmTestId="fees-dues-confirm"
        />
      )}
    </>
  );
}

/**
 * After a change that affects only some students (a family confirmed or changed, a concession):
 * offer to rewrite their unpaid dues now. The dialog is the confirmation.
 */
export function RecalculateStudentsDialog({
  studentIds,
  title,
  onClose,
}: {
  studentIds: string[];
  title: string;
  onClose: () => void;
}) {
  const t = useTranslations('fees.setup.dues');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const run = useFeeMutation(
    () =>
      client.api<{ updated: number }>('/fees/dues/recalculate', {
        method: 'POST',
        json: { studentIds: studentIds.slice(0, 50) },
      }),
    {
      success: (out) =>
        out.updated > 0
          ? t('studentsUpdated', { count: out.updated, n: formatCount(out.updated, locale) })
          : t('studentsUnchanged'),
      onSuccess: onClose,
    },
  );
  return (
    <FeeConfirmDialog
      title={title}
      body={t('studentsBody')}
      confirmLabel={t('studentsConfirm')}
      pending={run.isPending}
      onConfirm={() => run.mutate(undefined)}
      onClose={onClose}
      confirmTestId="fees-recalculate-students-confirm"
    />
  );
}

/** A calm note after a setup change: earlier dues keep their amounts until recalculated. */
export function RecalculateNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const t = useTranslations('fees.setup.dues');
  return (
    <div
      role="status"
      className="bg-info-soft text-foreground flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
      data-testid="fees-recalculate-notice"
    >
      <InfoIcon aria-hidden className="text-info size-5 shrink-0" />
      <p className="min-w-0 flex-1 text-sm">{text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <DuesJobButton kind="recalculate" />
        <Button variant="ghost" size="icon" onClick={onDismiss} aria-label={t('dismiss')}>
          <XIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
