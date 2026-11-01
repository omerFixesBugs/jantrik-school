'use client';

import { useMutation } from '@tanstack/react-query';
import {
  DEVICE_IMPORT_MAX_BYTES,
  formatCount,
  type DeviceImportResult,
  type DeviceImportRow,
} from '@jantrik/shared';
import { ArrowRightIcon, UploadIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pill, type PillTone } from '@/components/kit/pill';
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
import { useAuth } from '@/lib/auth/auth-provider';
import { cn } from '@/lib/utils';
import { Ascii, refName, useDevicesError } from './kit';
import { useInvalidatePeople } from './people-list';

/** Preview rows drawn (errors first); the counts cover all of them. */
const ROWS_SHOWN = 300;

const STATUS_TONE: Record<DeviceImportRow['status'], PillTone> = {
  OK: 'success',
  UNCHANGED: 'neutral',
  ERROR: 'destructive',
};

/**
 * Upload a CSV of device IDs: the file is checked first (nothing written) and every row shown
 * with what it would do; apply then writes only the OK rows (the server checks again). Files
 * over 1 MB are refused before uploading.
 */
export function CsvImportDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('devices.people.import');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidatePeople();
  const { client } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DeviceImportResult | null>(null);
  const tooBig = file !== null && file.size > DEVICE_IMPORT_MAX_BYTES;
  const f = (n: number) => formatCount(n, locale);

  const send = (apply: boolean) => {
    const body = new FormData();
    body.append('file', file!);
    return client.api<DeviceImportResult>(
      `/attendance/device-people/import?apply=${apply ? 1 : 0}`,
      { method: 'POST', body },
    );
  };
  const check = useMutation({
    mutationFn: () => send(false),
    onSuccess: setPreview,
    onError: (e) => toast.error(message(e)),
  });
  const apply = useMutation({
    mutationFn: () => send(true),
    onSuccess: (r) => {
      invalidate();
      onClose();
      const n = { count: f(r.counts.ok), errors: f(r.counts.error) };
      toast.success(
        r.counts.ok === 0
          ? t('appliedNone')
          : r.counts.error > 0
            ? t('appliedSkipped', n)
            : t('applied', n),
      );
    },
    onError: (e) => toast.error(message(e)),
  });

  const rows = preview
    ? [
        ...preview.rows.filter((r) => r.status === 'ERROR'),
        ...preview.rows.filter((r) => r.status === 'OK'),
      ]
    : [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
        data-testid="csv-import"
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="flex flex-col gap-3">
            <label
              className={cn(
                'bg-canvas hover:border-primary/50 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center',
                'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-3',
              )}
            >
              <UploadIcon aria-hidden className="text-muted-foreground size-6" />
              <span className="font-medium break-all">{file ? file.name : t('choose')}</span>
              <span className="text-muted-foreground text-sm">{t('limits')}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                data-testid="csv-file"
              />
            </label>
            {tooBig && (
              <p className="text-destructive text-sm" role="alert">
                {t('tooBig')}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="csv-preview">
            <div className="flex flex-wrap gap-2" aria-live="polite">
              <Pill tone="success">{t('countOk', { count: f(preview.counts.ok) })}</Pill>
              <Pill tone="neutral">
                {t('countUnchanged', { count: f(preview.counts.unchanged) })}
              </Pill>
              <Pill tone={preview.counts.error > 0 ? 'destructive' : 'neutral'}>
                {t('countError', { count: f(preview.counts.error) })}
              </Pill>
            </div>
            {preview.counts.error > 0 && (
              <p className="text-muted-foreground text-sm">{t('errorsSkipped')}</p>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm" data-testid="csv-preview-table">
                  <caption className="sr-only">{t('title')}</caption>
                  <thead>
                    <tr className="text-muted-foreground border-b text-start">
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t('colRow')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t('colPerson')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t('colId')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t('colStatus')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, ROWS_SHOWN).map((r) => (
                      <tr key={r.row} className="border-b align-top last:border-0">
                        <td className="px-3 py-2">
                          <Ascii value={String(r.row)} />
                        </td>
                        <td className="px-3 py-2">
                          {r.person ? (
                            <>
                              {refName(r.person, locale)}
                              {r.person.studentCode && (
                                <span className="text-muted-foreground">
                                  {' ('}
                                  <Ascii
                                    value={r.person.studentCode}
                                    className="whitespace-nowrap"
                                  />
                                  {')'}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {r.previous ? (
                              <Ascii value={r.previous} className="text-muted-foreground" />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            <ArrowRightIcon aria-label={t('to')} className="size-3.5" />
                            {r.deviceUserId ? (
                              <Ascii value={r.deviceUserId} className="font-semibold" />
                            ) : r.status === 'ERROR' ? (
                              // No valid ID in the cell (an empty one clears only on an OK row).
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span>{t('cleared')}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col items-start gap-1">
                            <Pill tone={STATUS_TONE[r.status]}>{t(`status${r.status}`)}</Pill>
                            {r.error && (
                              <span className="text-destructive text-sm">
                                {t(`error.${r.error}`)}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > ROWS_SHOWN && (
              <p className="text-muted-foreground text-sm">
                {t('moreRows', { count: f(rows.length - ROWS_SHOWN) })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(null)}>
                {t('another')}
              </Button>
              <Button
                onClick={() => apply.mutate()}
                disabled={preview.counts.ok === 0 || apply.isPending}
                data-testid="csv-apply"
              >
                {t('apply', { count: f(preview.counts.ok) })}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button
                onClick={() => check.mutate()}
                disabled={!file || tooBig || check.isPending}
                data-testid="csv-check"
              >
                {t('check')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
