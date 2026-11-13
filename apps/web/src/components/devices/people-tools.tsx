'use client';

import { useMutation } from '@tanstack/react-query';
import {
  formatCount,
  type DefaultIdConflictReason,
  type DeviceDefaultsResult,
  type DeviceSyncResult,
  type DeviceView,
} from '@jantrik/shared';
import {
  DownloadIcon,
  FileSpreadsheetIcon,
  SendIcon,
  UploadIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { downloadFile } from '@/components/fees/reports/kit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { CsvImportDialog } from './csv-import';
import { Ascii, refName, useDevicesError } from './kit';
import { useInvalidatePeople } from './people-list';

/** Assignments listed in the dialog before "and N more". */
const SHOWN = 8;

/**
 * "Assign default IDs": a dry run first, shown as who will get which ID and who cannot (and why),
 * then the same for real. Everyone without an ID, students and staff.
 */
export function DefaultIdsButton() {
  const t = useTranslations('devices.people.defaults');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidatePeople();
  const { client } = useAuth();
  const [preview, setPreview] = useState<DeviceDefaultsResult | null>(null);
  const run = (dryRun: boolean) =>
    client.api<DeviceDefaultsResult>('/attendance/device-people/defaults', {
      method: 'POST',
      json: { kind: 'ALL', dryRun },
    });
  const dry = useMutation({
    mutationFn: () => run(true),
    onSuccess: setPreview,
    onError: (e) => toast.error(message(e)),
  });
  const apply = useMutation({
    mutationFn: () => run(false),
    onSuccess: (r) => {
      setPreview(null);
      invalidate();
      const n = r.assigned.length;
      toast.success(
        n === 0
          ? t('appliedNone')
          : r.queued > 0
            ? t('appliedSent', { count: formatCount(n, locale) })
            : t('applied', { count: formatCount(n, locale) }),
      );
    },
    onError: (e) => toast.error(message(e)),
  });
  /** Why someone gets no default: TAKEN and a device still having the ID name who has it. */
  const reason = (r: DefaultIdConflictReason, id: string | null, holder: string | null) => {
    const values = { id: id ?? '', name: holder ?? '' };
    if (r === 'NO_DEFAULT' || r === 'SHARED') return t(`conflict${r}`, values);
    return t(holder ? `conflict${r}` : `conflict${r}_UNKNOWN`, values);
  };

  const assigned = preview?.assigned ?? [];
  const conflicts = preview?.conflicts ?? [];
  const students = assigned.filter((a) => a.person.kind === 'STUDENT').length;
  const f = (n: number) => formatCount(n, locale);
  return (
    <>
      <Button
        variant="outline"
        onClick={() => dry.mutate()}
        disabled={dry.isPending}
        data-testid="defaults-open"
      >
        <WandSparklesIcon aria-hidden />
        {t('button')}
      </Button>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
          data-testid="defaults-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <p className="font-medium" data-testid="defaults-count">
            {assigned.length === 0
              ? t('nobody')
              : t('willGet', {
                  count: f(assigned.length),
                  students: f(students),
                  staff: f(assigned.length - students),
                })}
          </p>
          {assigned.length > 0 && (
            <ul className="flex flex-col divide-y rounded-lg border text-sm">
              {assigned.slice(0, SHOWN).map((a) => (
                <li key={`${a.person.kind}:${a.person.id}`} className="flex gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{refName(a.person, locale)}</span>
                  <Ascii value={a.deviceUserId} className="font-semibold" />
                </li>
              ))}
              {assigned.length > SHOWN && (
                <li className="text-muted-foreground px-3 py-1.5">
                  {t('andMore', { count: f(assigned.length - SHOWN) })}
                </li>
              )}
            </ul>
          )}
          {conflicts.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="defaults-conflicts">
              <p className="font-medium">{t('conflicts', { count: f(conflicts.length) })}</p>
              <ul className="bg-warning-soft flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg px-3 py-2 text-sm">
                {conflicts.map((c) => (
                  <li key={`${c.person.kind}:${c.person.id}`}>
                    <span className="font-medium">{refName(c.person, locale)}</span>
                    {c.person.studentCode && (
                      <span className="text-muted-foreground">
                        {' ('}
                        <Ascii value={c.person.studentCode} className="whitespace-nowrap" />
                        {')'}
                      </span>
                    )}
                    {': '}
                    {reason(c.reason, c.deviceUserId, c.heldBy ? refName(c.heldBy, locale) : null)}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-sm">{t('conflictsHint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => apply.mutate()}
              disabled={assigned.length === 0 || apply.isPending}
              data-testid="defaults-apply"
            >
              {t('apply', { count: f(assigned.length) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Sync every active device; one toast with the totals. */
export function SendToDevicesButton({ devices }: { devices: DeviceView[] }) {
  const t = useTranslations('devices.people.send');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidatePeople();
  const { client } = useAuth();
  const active = devices.filter((d) => d.isActive);
  const send = useMutation({
    mutationFn: async () => {
      const results = await Promise.all(
        active.map((d) =>
          client.api<DeviceSyncResult>(`/attendance/devices/${d.id}/sync`, { method: 'POST' }),
        ),
      );
      return results.reduce(
        (a, r) => ({ queued: a.queued + r.queued, skipped: a.skipped + r.skipped }),
        {
          queued: 0,
          skipped: 0,
        },
      );
    },
    onSuccess: (r) => {
      invalidate();
      const n = {
        devices: formatCount(active.length, locale),
        queued: formatCount(r.queued, locale),
        skipped: formatCount(r.skipped, locale),
      };
      toast.success(
        r.queued === 0 && r.skipped === 0
          ? t('nobody')
          : r.skipped > 0
            ? t('doneSkipped', n)
            : t('done', n),
      );
    },
    onError: (e) => {
      invalidate();
      toast.error(message(e));
    },
  });
  return (
    <Button
      variant="outline"
      onClick={() => send.mutate()}
      disabled={active.length === 0 || send.isPending}
      title={active.length === 0 ? t('noDevices') : undefined}
      data-testid="people-send"
    >
      <SendIcon aria-hidden />
      {t('button')}
    </Button>
  );
}

/** CSV: download (names in Bangla or English) and upload (preview, then apply). */
export function CsvMenu() {
  const t = useTranslations('devices.people.csv');
  const message = useDevicesError();
  const { client } = useAuth();
  const [importing, setImporting] = useState(false);
  const download = async (locale: Locale) => {
    try {
      await downloadFile(
        client,
        `/attendance/device-people/csv?locale=${locale}`,
        `device-people-${locale}.csv`,
      );
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" data-testid="people-csv">
              <FileSpreadsheetIcon aria-hidden />
              {t('button')}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={() => void download('bn')} data-testid="csv-download-bn">
            <DownloadIcon aria-hidden />
            {t('downloadBn')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void download('en')} data-testid="csv-download-en">
            <DownloadIcon aria-hidden />
            {t('downloadEn')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setImporting(true)} data-testid="csv-upload">
            <UploadIcon aria-hidden />
            {t('upload')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {importing && <CsvImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
