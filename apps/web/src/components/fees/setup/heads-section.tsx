'use client';

import { formatDate, formatTaka, type FeeHeadView } from '@jantrik/shared';
import {
  EllipsisVerticalIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  TagsIcon,
  UsersIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { cn } from '@/lib/utils';
import { RecalculateNotice } from './dues-actions';
import { HeadDialog } from './head-dialog';
import {
  EmptyState,
  FeeConfirmDialog,
  LoadError,
  localDigits,
  useFeeMutation,
  useFeeQuery,
} from './kit';

/** When a head falls due, in words. */
export function useDueRule() {
  const t = useTranslations('fees.setup.heads');
  const locale = useLocale() as Locale;
  const n = (v: number) => localDigits(String(v), locale);
  return (h: FeeHeadView): string => {
    switch (h.frequency) {
      case 'MONTHLY':
        return t('ruleMonthly', { day: n(h.dueDay ?? 1) });
      case 'PER_TERM':
        return t('rulePerTerm');
      case 'YEARLY':
        return h.dueOffsetDays === 0
          ? t('ruleYearlyStart')
          : t('ruleYearly', { days: n(h.dueOffsetDays) });
      case 'ONE_TIME': {
        const when =
          h.dueOffsetDays === 0
            ? t('ruleOnceAdmission')
            : t('ruleOnce', { days: n(h.dueOffsetDays) });
        const who = h.oneTimeFrom
          ? t('ruleOnceFrom', { date: formatDate(h.oneTimeFrom, locale) })
          : t('ruleOnceNobody');
        return `${when} ${who}`;
      }
    }
  };
}

/** The late fine, in words. */
export function useFineRule() {
  const t = useTranslations('fees.setup.heads');
  const locale = useLocale() as Locale;
  return (h: FeeHeadView): string =>
    h.fine.type === 'NONE'
      ? t('fineNone')
      : h.fine.type === 'FLAT'
        ? t('fineFlatRule', { amount: formatTaka(h.fine.amountPaisa, locale) })
        : t('finePerDayRule', {
            amount: formatTaka(h.fine.amountPaisa, locale),
            cap: formatTaka(h.fine.capPaisa ?? 0, locale),
          });
}

type Dialog =
  { kind: 'edit'; head: FeeHeadView | null } | { kind: 'toggle'; head: FeeHeadView } | null;

/** Fee heads: what money is collected for, how often, when it falls due, the late fine. */
export function HeadsSection() {
  const t = useTranslations('fees.setup.heads');
  const heads = useFeeQuery<FeeHeadView[]>('/fees/heads');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<'created' | 'changed' | null>(null);
  const list = [...(heads.data ?? [])].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.sortOrder - b.sortOrder,
  );
  const nextSort = Math.min(9999, Math.max(0, ...list.map((h) => h.sortOrder)) + 10);
  return (
    <>
      <SectionCard
        id="fees-heads"
        title={t('title')}
        hint={t('hint')}
        actions={
          <Button
            onClick={() => setDialog({ kind: 'edit', head: null })}
            data-testid="fee-head-add"
          >
            <PlusIcon aria-hidden />
            {t('add')}
          </Button>
        }
      >
        {notice === 'changed' && (
          <RecalculateNotice text={t('changedNotice')} onDismiss={() => setNotice(null)} />
        )}
        {notice === 'created' && (
          <div
            role="status"
            className="bg-info-soft flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
          >
            <p className="min-w-0 flex-1 text-sm">{t('createdNotice')}</p>
            <ButtonLink href="/fees/setup/amounts" variant="outline">
              {t('goToAmounts')}
            </ButtonLink>
          </div>
        )}
        {heads.isPending ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : heads.isError ? (
          <LoadError error={heads.error} onRetry={() => void heads.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={TagsIcon}
            title={t('emptyTitle')}
            text={t('emptyText')}
            action={
              <Button onClick={() => setDialog({ kind: 'edit', head: null })}>
                <PlusIcon aria-hidden />
                {t('add')}
              </Button>
            }
            testId="fee-heads-empty"
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="fee-heads">
            {list.map((h) => (
              <HeadRow
                key={h.id}
                head={h}
                onEdit={() => setDialog({ kind: 'edit', head: h })}
                onToggle={() => setDialog({ kind: 'toggle', head: h })}
              />
            ))}
          </ul>
        )}
      </SectionCard>
      {dialog?.kind === 'edit' && (
        <HeadDialog
          head={dialog.head}
          nextSort={nextSort}
          onClose={() => setDialog(null)}
          onSaved={(_, created) => {
            setDialog(null);
            setNotice(created ? 'created' : 'changed');
          }}
        />
      )}
      {dialog?.kind === 'toggle' && (
        <ToggleHeadDialog
          head={dialog.head}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNotice('changed');
          }}
        />
      )}
    </>
  );
}

function HeadRow({
  head: h,
  onEdit,
  onToggle,
}: {
  head: FeeHeadView;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const t = useTranslations('fees.setup.heads');
  const tCommon = useTranslations('fees.common');
  const locale = useLocale() as Locale;
  const dueRule = useDueRule();
  const fineRule = useFineRule();
  const name = pick(locale, h);
  return (
    <li
      className={cn(
        'grid min-w-0 gap-x-4 gap-y-1.5 rounded-xl border p-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_auto] md:items-center',
        !h.isActive && 'bg-muted',
      )}
      data-testid="fee-head-row"
      data-head-id={h.id}
    >
      <div className="flex min-w-0 items-start justify-between gap-2 md:contents">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-semibold wrap-break-word">{name}</span>
          <span className="flex flex-wrap gap-1.5">
            <Pill tone="accent">{tCommon(`frequency.${h.frequency}`)}</Pill>
            <Pill>{tCommon(`kind.${h.kind}`)}</Pill>
            {h.siblingEligible && (
              <Pill tone="info">
                <UsersIcon aria-hidden className="size-3.5" />
                {t('siblingPill')}
              </Pill>
            )}
            {!h.isActive && (
              <Pill tone="warning">
                <PowerOffIcon aria-hidden className="size-3.5" />
                {t('inactive')}
              </Pill>
            )}
          </span>
        </div>
        <div className="md:order-last">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('actions', { name })}
                  data-testid="fee-head-actions"
                >
                  <EllipsisVerticalIcon aria-hidden />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={onEdit} data-testid="fee-head-edit">
                <PencilIcon aria-hidden />
                {t('edit')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onToggle}
                variant={h.isActive ? 'destructive' : 'default'}
                data-testid="fee-head-toggle"
              >
                {h.isActive ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}
                {h.isActive ? t('deactivate') : t('activate')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">{t('dueLabel')} </span>
        {dueRule(h)}
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">{t('fineLabel')} </span>
        <span className="font-numeric">{fineRule(h)}</span>
      </p>
    </li>
  );
}

/** Deactivating stops new dues (earlier ones stay); reactivating starts them again. */
function ToggleHeadDialog({
  head,
  onClose,
  onDone,
}: {
  head: FeeHeadView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('fees.setup.heads');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const name = pick(locale, head);
  const save = useFeeMutation(
    () =>
      client.api<FeeHeadView>(`/fees/heads/${head.id}`, {
        method: 'PATCH',
        json: { isActive: !head.isActive },
      }),
    { success: head.isActive ? t('deactivated') : t('activated'), onSuccess: onDone },
  );
  return (
    <FeeConfirmDialog
      title={head.isActive ? t('deactivateTitle', { name }) : t('activateTitle', { name })}
      body={head.isActive ? t('deactivateBody') : t('activateBody')}
      confirmLabel={head.isActive ? t('deactivate') : t('activate')}
      destructive={head.isActive}
      pending={save.isPending}
      onConfirm={() => save.mutate(undefined)}
      onClose={onClose}
      confirmTestId="fee-head-toggle-confirm"
    />
  );
}
