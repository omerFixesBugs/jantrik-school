'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { TextField } from '@/components/form-kit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** The API's reason rule (fees-api.ts `reasonSchema`): 3–500 characters once trimmed. */
const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * A change that needs a reason (void a receipt, cancel a due, waive a fine; OWNER/ADMIN). The
 * reason is checked here first; `onConfirm` does the request and throws on failure, and
 * `errorText` turns that into words shown inside the dialog (so it can be fixed and retried).
 * Extra fields go in `children`; `blocked` holds them back while they are not valid.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  errorText,
  blocked,
  children,
  testId,
  reasonTestId,
  confirmTestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  errorText: (error: unknown) => string;
  blocked?: boolean;
  children?: ReactNode;
  testId?: string;
  reasonTestId?: string;
  confirmTestId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid={testId}
      >
        {/* Mounted only while open: every opening starts with an empty reason. */}
        <ReasonForm
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          onConfirm={onConfirm}
          errorText={errorText}
          blocked={blocked}
          onCancel={() => onOpenChange(false)}
          reasonTestId={reasonTestId}
          confirmTestId={confirmTestId}
        >
          {children}
        </ReasonForm>
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  title,
  description,
  confirmLabel,
  onConfirm,
  errorText,
  blocked,
  onCancel,
  children,
  reasonTestId,
  confirmTestId,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  errorText: (error: unknown) => string;
  blocked?: boolean;
  onCancel: () => void;
  children?: ReactNode;
  reasonTestId?: string;
  confirmTestId?: string;
}) {
  const t = useTranslations('fees.counter.actions');
  const id = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const short = reason.trim().length < REASON_MIN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (short || blocked || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(reason.trim());
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader className="pe-8">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      <TextField
        id={`${id}-reason`}
        label={t('reason')}
        value={reason}
        onChange={setReason}
        hint={t('reasonHint')}
        error={tried && short ? t('reasonShort') : null}
        required
        maxLength={REASON_MAX}
        autoComplete="off"
        data-testid={reasonTestId}
      />
      {failure && (
        <p className="text-destructive text-sm" role="alert" data-testid="reason-dialog-error">
          {failure}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('back')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={busy}
          aria-busy={busy || undefined}
          data-testid={confirmTestId}
        >
          {busy ? t('working') : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
