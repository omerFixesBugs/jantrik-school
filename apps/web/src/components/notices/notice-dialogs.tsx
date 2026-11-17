'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NoticeManageItem } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, TextField } from '@/components/form-kit';
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
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useMeContext } from '@/lib/hooks';
import { dhakaInstant } from '@/lib/notices';

/** An API error as the manage pages say it: the notices' own codes, else the generic text. */
export function useNoticeError() {
  const t = useTranslations('notices.manage.errors');
  const describe = useErrorMessage();
  return (e: unknown): string => {
    if (e instanceof ApiError && e.code && t.has(e.code)) return t(e.code);
    return describe(e);
  };
}

/** Refreshes everything that shows notices after a change. */
export function useRefreshNotices() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return () => queryClient.invalidateQueries({ queryKey: ['notices', session?.tenant?.id] });
}

/** Publish now, or at a date and time (Asia/Dhaka) within 30 days (P6-A). */
export function PublishDialog({
  notice,
  onClose,
}: {
  notice: NoticeManageItem;
  onClose: () => void;
}) {
  const t = useTranslations('notices.manage.publishDialog');
  const tForm = useTranslations('notices.manage.form');
  const { client } = useAuth();
  const { data: context } = useMeContext();
  const refresh = useRefreshNotices();
  const explain = useNoticeError();
  const [later, setLater] = useState(false);
  const [day, setDay] = useState(context?.today ?? '');
  const [time, setTime] = useState('09:00');
  const publish = useMutation({
    mutationFn: () =>
      client.api<NoticeManageItem>(`/notices/${notice.id}/publish`, {
        method: 'POST',
        json: later ? { publishAt: dhakaInstant(day, time) } : {},
      }),
    onSuccess: async (n) => {
      toast.success(n.state === 'SCHEDULED' ? t('scheduled') : t('done'));
      await refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="notice-publish-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{notice.title}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2">
          <label className="flex min-h-(--control-h) items-center gap-2">
            <input
              type="radio"
              name="when"
              checked={!later}
              onChange={() => setLater(false)}
              className="accent-primary size-4"
            />
            {t('now')}
          </label>
          <label className="flex min-h-(--control-h) items-center gap-2">
            <input
              type="radio"
              name="when"
              checked={later}
              onChange={() => setLater(true)}
              className="accent-primary size-4"
              data-testid="notice-publish-later"
            />
            {t('later')}
          </label>
        </fieldset>
        {later && (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              id="notice-publish-day"
              type="date"
              label={t('date')}
              value={day}
              onChange={setDay}
            />
            <Field id="notice-publish-time" label={t('time')}>
              <Input
                id="notice-publish-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
            <p className="text-muted-foreground col-span-2 text-sm">{t('hint')}</p>
          </div>
        )}
        {publish.error && (
          <Alert variant="destructive">
            <AlertDescription>{explain(publish.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tForm('cancel')}
          </Button>
          <Button
            onClick={() => publish.mutate()}
            disabled={publish.isPending || (later && (!day || !time))}
            data-testid="notice-publish-confirm"
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Withdraw with a reason: off every board, kept on record, never edited again. */
export function WithdrawDialog({
  notice,
  onClose,
}: {
  notice: NoticeManageItem;
  onClose: () => void;
}) {
  const t = useTranslations('notices.manage.withdrawDialog');
  const tForm = useTranslations('notices.manage.form');
  const { client } = useAuth();
  const refresh = useRefreshNotices();
  const explain = useNoticeError();
  const [reason, setReason] = useState('');
  const withdraw = useMutation({
    mutationFn: () =>
      client.api<NoticeManageItem>(`/notices/${notice.id}/withdraw`, {
        method: 'POST',
        json: { reason },
      }),
    onSuccess: async () => {
      toast.success(t('done'));
      await refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="notice-withdraw-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('text')}</DialogDescription>
        </DialogHeader>
        <TextField
          id="notice-withdraw-reason"
          label={t('reason')}
          value={reason}
          onChange={setReason}
          maxLength={300}
          required
        />
        {withdraw.error && (
          <Alert variant="destructive">
            <AlertDescription>{explain(withdraw.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tForm('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => withdraw.mutate()}
            disabled={withdraw.isPending || reason.trim().length === 0}
            data-testid="notice-withdraw-confirm"
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
