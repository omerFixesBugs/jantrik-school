'use client';

import {
  FEE_MOBILE_ACCOUNT_KINDS,
  FEE_MOBILE_METHODS,
  formatBdPhone,
  normalizeBdPhone,
  type FeeMobileAccountView,
  type FeeMobileMethod,
} from '@jantrik/shared';
import {
  EllipsisVerticalIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChoiceChip, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { useFeeRoles } from '@/lib/fees';
import { cn } from '@/lib/utils';
import {
  EmptyState,
  FeeConfirmDialog,
  FeeDialog,
  fieldsFromError,
  LoadError,
  useFeeMutation,
  useFeeQuery,
} from './kit';

type AccountKind = (typeof FEE_MOBILE_ACCOUNT_KINDS)[number];
type Dialog =
  | { kind: 'add' }
  | { kind: 'label'; account: FeeMobileAccountView }
  | { kind: 'toggle'; account: FeeMobileAccountView }
  | null;

/**
 * The institute's own bKash/Nagad numbers, where guardians send money. Only the owner changes
 * them (where money goes); an admin sees them read-only.
 */
export function NumbersSection() {
  const t = useTranslations('fees.setup.numbers');
  const { isOwner } = useFeeRoles();
  const accounts = useFeeQuery<FeeMobileAccountView[]>('/fees/mobile-accounts');
  const [dialog, setDialog] = useState<Dialog>(null);
  const list = [...(accounts.data ?? [])].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.sortOrder - b.sortOrder,
  );
  return (
    <>
      <SectionCard
        id="fees-numbers"
        title={t('title')}
        hint={t('hint')}
        actions={
          isOwner ? (
            <Button onClick={() => setDialog({ kind: 'add' })} data-testid="fee-number-add">
              <PlusIcon aria-hidden />
              {t('add')}
            </Button>
          ) : undefined
        }
      >
        {!isOwner && (
          <p
            className="bg-muted flex gap-2 rounded-xl p-3 text-sm"
            data-testid="fee-numbers-owner-only"
          >
            <LockIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            {t('ownerOnly')}
          </p>
        )}
        {accounts.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : accounts.isError ? (
          <LoadError error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={SmartphoneIcon}
            title={t('emptyTitle')}
            text={isOwner ? t('emptyText') : t('emptyTextAdmin')}
            action={
              isOwner ? (
                <Button onClick={() => setDialog({ kind: 'add' })}>
                  <PlusIcon aria-hidden />
                  {t('add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid gap-2 lg:grid-cols-2" data-testid="fee-numbers">
            {list.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                canEdit={isOwner}
                onLabel={() => setDialog({ kind: 'label', account: a })}
                onToggle={() => setDialog({ kind: 'toggle', account: a })}
              />
            ))}
          </ul>
        )}
      </SectionCard>
      {dialog?.kind === 'add' && <AddAccountDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'label' && (
        <LabelDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'toggle' && (
        <ToggleDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function AccountRow({
  account: a,
  canEdit,
  onLabel,
  onToggle,
}: {
  account: FeeMobileAccountView;
  canEdit: boolean;
  onLabel: () => void;
  onToggle: () => void;
}) {
  const t = useTranslations('fees.setup.numbers');
  const tMethod = useTranslations('fees.common.method');
  const phone = formatBdPhone(a.phone);
  return (
    <li
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-xl border p-3',
        !a.isActive && 'bg-muted',
      )}
      data-testid="fee-number-row"
    >
      <span className="bg-primary-soft text-primary-ink flex size-10 shrink-0 items-center justify-center rounded-xl">
        <SmartphoneIcon aria-hidden className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{tMethod(a.method)}</span>
          <span className="font-numeric text-base font-semibold" dir="ltr">
            {phone}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill>{t(`kind.${a.kind}`)}</Pill>
          {a.isActive ? (
            <Pill tone="success">
              <PowerIcon aria-hidden className="size-3.5" />
              {t('active')}
            </Pill>
          ) : (
            <Pill tone="warning">
              <PowerOffIcon aria-hidden className="size-3.5" />
              {t('inactive')}
            </Pill>
          )}
        </span>
        {a.label && (
          <span className="text-muted-foreground text-sm wrap-break-word">{a.label}</span>
        )}
      </div>
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={t('actions', { phone })}>
                <EllipsisVerticalIcon aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={onLabel}>
              <PencilIcon aria-hidden />
              {t('editLabel')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggle} variant={a.isActive ? 'destructive' : 'default'}>
              {a.isActive ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}
              {a.isActive ? t('deactivate') : t('activate')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('fees.setup.numbers');
  const tMethod = useTranslations('fees.common.method');
  const { client } = useAuth();
  const [method, setMethod] = useState<FeeMobileMethod>('BKASH');
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<AccountKind>('PERSONAL');
  const [label, setLabel] = useState('');
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Set<string>>(new Set());
  const normalized = normalizeBdPhone(phone);
  const phoneError = server.has('phone')
    ? t('errorDuplicate')
    : !normalized
      ? t('errorPhone')
      : null;
  const save = useFeeMutation(
    () =>
      client.api<FeeMobileAccountView>('/fees/mobile-accounts', {
        method: 'POST',
        json: { method, phone: normalized, kind, label: label.trim() || null },
      }),
    { success: t('added'), onSuccess: onClose, onError: (e) => setServer(fieldsFromError(e)) },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('addTitle')}
      description={t('addHint')}
      submitLabel={t('addSubmit')}
      pending={save.isPending}
      onSubmit={() => {
        setTried(true);
        if (!phoneError) save.mutate(undefined);
      }}
      testId="fee-number-dialog"
      submitTestId="fee-number-save"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t('method')}</legend>
        <div className="flex flex-wrap gap-2">
          {FEE_MOBILE_METHODS.map((m) => (
            <ChoiceChip
              key={m}
              type="radio"
              name="fee-number-method"
              checked={method === m}
              onChange={() => setMethod(m)}
            >
              {tMethod(m)}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      <TextField
        id="fee-number-phone"
        label={t('phone')}
        hint={t('phoneHint')}
        value={phone}
        onChange={(v) => {
          setPhone(v);
          setServer(new Set());
        }}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        dir="ltr"
        required
        error={tried || server.size > 0 ? phoneError : null}
        data-testid="fee-number-phone"
      />
      <SelectField
        id="fee-number-kind"
        label={t('kindLabel')}
        hint={t(`kindHint.${kind}`)}
        value={kind}
        onChange={(v) => setKind(v as AccountKind)}
        options={FEE_MOBILE_ACCOUNT_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
      />
      <TextField
        id="fee-number-label"
        label={t('label')}
        hint={t('labelHint')}
        value={label}
        onChange={setLabel}
        maxLength={60}
      />
    </FeeDialog>
  );
}

function LabelDialog({ account, onClose }: { account: FeeMobileAccountView; onClose: () => void }) {
  const t = useTranslations('fees.setup.numbers');
  const { client } = useAuth();
  const [label, setLabel] = useState(account.label ?? '');
  const save = useFeeMutation(
    () =>
      client.api(`/fees/mobile-accounts/${account.id}`, {
        method: 'PATCH',
        json: { label: label.trim() || null },
      }),
    { success: t('saved'), onSuccess: onClose },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('labelTitle', { phone: formatBdPhone(account.phone) })}
      description={t('labelOnlyHint')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
    >
      <TextField
        id="fee-number-label-edit"
        label={t('label')}
        hint={t('labelHint')}
        value={label}
        onChange={setLabel}
        maxLength={60}
      />
    </FeeDialog>
  );
}

function ToggleDialog({
  account,
  onClose,
}: {
  account: FeeMobileAccountView;
  onClose: () => void;
}) {
  const t = useTranslations('fees.setup.numbers');
  const { client } = useAuth();
  const phone = formatBdPhone(account.phone);
  const save = useFeeMutation(
    () =>
      client.api(`/fees/mobile-accounts/${account.id}`, {
        method: 'PATCH',
        // The label goes along: the API's schema turns a missing label into null (clears it).
        json: { isActive: !account.isActive, label: account.label },
      }),
    { success: account.isActive ? t('deactivated') : t('activated'), onSuccess: onClose },
  );
  return (
    <FeeConfirmDialog
      title={account.isActive ? t('deactivateTitle', { phone }) : t('activateTitle', { phone })}
      body={account.isActive ? t('deactivateBody') : t('activateBody')}
      confirmLabel={account.isActive ? t('deactivate') : t('activate')}
      destructive={account.isActive}
      pending={save.isPending}
      onConfirm={() => save.mutate(undefined)}
      onClose={onClose}
      confirmTestId="fee-number-toggle-confirm"
    />
  );
}
