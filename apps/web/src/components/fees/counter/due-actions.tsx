'use client';

import { formatTaka, type FeeDueView } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChoiceChip } from '@/components/form-kit';
import { MoneyField } from '@/components/fees/money-field';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, usePeriodLabel } from '@/lib/fees';
import { useErrorMessage } from '@/lib/hooks';
import { ReasonDialog } from './reason-dialog';

/*
 * What an OWNER/ADMIN may do to one due from the counter (docs/fees.md → Dues, Fines): waive its
 * fine (all of it for good, or an amount) or cancel it (only while nothing is paid). Both need a
 * reason and are audited by the API. `onDone` refreshes the ledger and says what happened.
 */

export type DueAction = { kind: 'waive' | 'cancel'; due: FeeDueView };

function useDueErrorText() {
  const t = useTranslations('fees.counter.actions');
  const describe = useErrorMessage();
  return (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.code === 'ALREADY_CANCELLED') return t('alreadyCancelled');
      if (error.code === 'DUE_PAID') return t('duePaid');
    }
    return describe(error);
  };
}

export function DueActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: DueAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  return action.kind === 'waive' ? (
    <WaiveFineDialog due={action.due} onClose={onClose} onDone={onDone} />
  ) : (
    <CancelDueDialog due={action.due} onClose={onClose} onDone={onDone} />
  );
}

function WaiveFineDialog({
  due,
  onClose,
  onDone,
}: {
  due: FeeDueView;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations('fees.counter.actions');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const { client } = useAuth();
  const errorText = useDueErrorText();
  const [all, setAll] = useState(true);
  const [amount, setAmount] = useState<number | null>(null);
  const fine = due.balance.fine;
  const fineText = formatTaka(fine, locale);
  const tooMuch = amount !== null && amount > fine;
  const blocked = !all && (amount === null || amount < 1 || tooMuch);
  return (
    <ReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('waiveTitle', { head: pick(locale, due.head), period: period(due) })}
      description={t('waiveText', { fine: fineText })}
      confirmLabel={t('waiveConfirm')}
      blocked={blocked}
      errorText={errorText}
      testId="waive-dialog"
      reasonTestId="waive-reason"
      confirmTestId="waive-confirm"
      onConfirm={async (reason) => {
        await client.api(`/fees/dues/${due.id}/waive-fine`, {
          method: 'POST',
          json: { amountPaisa: all ? null : amount, reason },
        });
        onDone(t('waived'));
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t('waiveHow')}</legend>
        <div className="grid grid-cols-2 gap-2">
          <ChoiceChip type="radio" name="waive-how" checked={all} onChange={() => setAll(true)}>
            {t('waiveAll')}
          </ChoiceChip>
          <ChoiceChip type="radio" name="waive-how" checked={!all} onChange={() => setAll(false)}>
            {t('waivePart')}
          </ChoiceChip>
        </div>
        {all && <p className="text-muted-foreground text-sm">{t('waiveAllHint')}</p>}
      </fieldset>
      {!all && (
        <MoneyField
          id="waive-amount"
          label={t('waiveAmount')}
          valuePaisa={amount}
          onChange={setAmount}
          required
          error={tooMuch ? t('waiveTooMuch', { fine: fineText }) : null}
          testId="waive-amount"
        />
      )}
    </ReasonDialog>
  );
}

function CancelDueDialog({
  due,
  onClose,
  onDone,
}: {
  due: FeeDueView;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations('fees.counter.actions');
  const locale = useLocale() as Locale;
  const period = usePeriodLabel();
  const { client } = useAuth();
  const errorText = useDueErrorText();
  return (
    <ReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('cancelTitle', { head: pick(locale, due.head), period: period(due) })}
      description={t('cancelText')}
      confirmLabel={t('cancelConfirm')}
      errorText={errorText}
      testId="cancel-due-dialog"
      reasonTestId="cancel-due-reason"
      confirmTestId="cancel-due-confirm"
      onConfirm={async (reason) => {
        await client.api(`/fees/dues/${due.id}/cancel`, { method: 'POST', json: { reason } });
        onDone(t('cancelled'));
      }}
    />
  );
}
