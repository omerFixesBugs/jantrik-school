'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BROADCAST_LIMITS,
  BROADCAST_RECIPIENTS,
  broadcastProblems,
  formatCount,
  formatDate,
  formatTaka,
  formatTime,
  smsLength,
  type BroadcastInputBody,
  type BroadcastPreview,
  type BroadcastRecipients,
  type BroadcastView,
  type SetupClassLevel,
  type SetupSection,
} from '@jantrik/shared';
import { PlusIcon, SendIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useMeContext } from '@/lib/hooks';
import { dhakaInstant } from '@/lib/notices';
import { cn } from '@/lib/utils';

interface TargetRow {
  key: number;
  classLevelId: string;
  sectionId: string;
}

function useBroadcastError() {
  const t = useTranslations('notices.broadcasts.errors');
  const describe = useErrorMessage();
  return (e: unknown): string =>
    e instanceof ApiError && e.code && t.has(e.code) ? t(e.code) : describe(e);
}

/**
 * Compose an SMS broadcast, preview it (recipients after merging, without phone, segments, cost,
 * today's limit left), then send now or schedule (S18–S20). Any change needs a new preview, and
 * the server refuses a send whose recipient count changed meanwhile (409 PREVIEW_CHANGED).
 */
export function BroadcastComposer({
  broadcast,
  initialBody = '',
  noticeId = null,
}: {
  broadcast?: BroadcastView;
  initialBody?: string;
  noticeId?: string | null;
}) {
  const t = useTranslations('notices.broadcasts');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const explain = useBroadcastError();
  const tenantId = session?.tenant?.id;
  const yearId = context?.academicYear?.id;

  const classes = useQuery({
    queryKey: ['setup', tenantId, 'class-levels'],
    queryFn: () => client.api<SetupClassLevel[]>('/setup/class-levels'),
  });
  const sections = useQuery({
    queryKey: ['setup', tenantId, 'sections', yearId],
    queryFn: () => client.api<SetupSection[]>(`/setup/sections?academicYearId=${yearId}`),
    enabled: Boolean(yearId),
  });

  const [id, setId] = useState<string | null>(broadcast?.id ?? null);
  const [body, setBody] = useState(broadcast?.body ?? initialBody);
  const [recipients, setRecipients] = useState<BroadcastRecipients>(
    broadcast?.recipients ?? 'PRIMARY_GUARDIANS',
  );
  const [targets, setTargets] = useState<TargetRow[]>(
    (broadcast?.targets ?? []).map((x, i) => ({
      key: i,
      classLevelId: x.classLevelId,
      sectionId: x.sectionId ?? '',
    })),
  );
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [later, setLater] = useState(false);
  const [day, setDay] = useState(context?.today ?? '');
  const [time, setTime] = useState('10:00');

  const length = smsLength(body);
  const tooLong = broadcastProblems(body).includes('SMS_TOO_LONG');
  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPreview(null);
  };

  const input = (): BroadcastInputBody => ({
    body,
    recipients,
    noticeId: broadcast?.noticeId ?? noticeId,
    targets:
      recipients === 'STAFF'
        ? []
        : targets
            .filter((x) => x.classLevelId)
            .map((x) => ({ classLevelId: x.classLevelId, sectionId: x.sectionId || null })),
  });

  const doPreview = useMutation({
    mutationFn: async () => {
      const saved = id
        ? await client.api<BroadcastView>(`/broadcasts/${id}`, { method: 'PUT', json: input() })
        : await client.api<BroadcastView>('/broadcasts', { method: 'POST', json: input() });
      setId(saved.id);
      return client.api<BroadcastPreview>(`/broadcasts/${saved.id}/preview`, {
        method: 'POST',
        json: {},
      });
    },
    onSuccess: setPreview,
  });

  const go = useMutation({
    mutationFn: () =>
      later
        ? client.api<BroadcastView>(`/broadcasts/${id}/schedule`, {
            method: 'POST',
            json: { scheduledAt: dhakaInstant(day, time), expectedRecipients: preview!.recipients },
          })
        : client.api<BroadcastView>(`/broadcasts/${id}/send`, {
            method: 'POST',
            json: { expectedRecipients: preview!.recipients },
          }),
    onSuccess: async (b) => {
      toast.success(later ? t('preview.scheduled') : t('preview.sent'));
      await queryClient.invalidateQueries({ queryKey: ['broadcasts', tenantId] });
      router.push(`/broadcasts/${b.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PREVIEW_CHANGED') setPreview(null);
    },
  });

  const activeClasses = (classes.data ?? []).filter((c) => c.isActive);
  const error = doPreview.error ?? go.error;

  return (
    <SectionCard id="broadcast-compose" title={broadcast ? t('compose.editTitle') : t('compose.newTitle')}>
      <div className="flex flex-col gap-4">
        <Field
          id="broadcast-body"
          label={t('compose.bodyLabel')}
          hint={t('compose.bodyHint')}
          error={tooLong ? t('compose.tooLong') : null}
          required
        >
          <textarea
            id="broadcast-body"
            value={body}
            onChange={(e) => changed(setBody)(e.target.value)}
            maxLength={BROADCAST_LIMITS.bodyChars}
            rows={5}
            className={cn(
              'border-input bg-card w-full min-w-0 rounded-md border px-2.5 py-2 text-(length:--input-fs) outline-none',
              'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
              tooLong && 'border-destructive',
            )}
          />
        </Field>
        <p
          className={cn('text-sm', tooLong ? 'text-destructive' : 'text-muted-foreground')}
          data-testid="broadcast-counter"
          aria-live="polite"
        >
          {t('compose.counter', {
            chars: formatCount(length.length, locale),
            segments: formatCount(length.segments, locale),
            encoding: length.encoding === 'GSM7' ? 'GSM' : 'Unicode',
          })}
        </p>
        <SelectField
          id="broadcast-recipients"
          label={t('compose.recipientsLabel')}
          value={recipients}
          onChange={(v) => changed(setRecipients)(v as BroadcastRecipients)}
          options={BROADCAST_RECIPIENTS.map((r) => ({ value: r, label: t(`recipients.${r}`) }))}
        />
        {recipients !== 'STAFF' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">{t('compose.targetsLabel')}</legend>
            <p className="text-muted-foreground text-sm">{t('compose.targetsHint')}</p>
            {targets.map((row) => {
              const update = (patch: Partial<TargetRow>) => {
                setPreview(null);
                setTargets((all) => all.map((x) => (x.key === row.key ? { ...x, ...patch } : x)));
              };
              return (
                <div key={row.key} className="flex flex-wrap items-end gap-2">
                  <SelectField
                    id={`broadcast-target-class-${row.key}`}
                    label={t('compose.classLabel')}
                    className="min-w-40 flex-1"
                    value={row.classLevelId}
                    placeholder=""
                    onChange={(v) => update({ classLevelId: v, sectionId: '' })}
                    options={activeClasses.map((c) => ({
                      value: c.id,
                      label: locale === 'bn' ? c.nameBn : c.nameEn,
                    }))}
                  />
                  <SelectField
                    id={`broadcast-target-section-${row.key}`}
                    label={t('compose.sectionLabel')}
                    className="min-w-32 flex-1"
                    value={row.sectionId}
                    placeholder={t('compose.wholeClass')}
                    onChange={(v) => update({ sectionId: v })}
                    options={(sections.data ?? [])
                      .filter((s) => s.classLevelId === row.classLevelId && s.isActive)
                      .map((s) => ({ value: s.id, label: s.name }))}
                    disabled={!row.classLevelId}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('compose.removeTarget')}
                    onClick={() => {
                      setPreview(null);
                      setTargets((all) => all.filter((x) => x.key !== row.key));
                    }}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setPreview(null);
                setTargets((all) => [
                  ...all,
                  { key: Math.max(-1, ...all.map((x) => x.key)) + 1, classLevelId: '', sectionId: '' },
                ]);
              }}
            >
              <PlusIcon aria-hidden />
              {t('compose.addTarget')}
            </Button>
          </fieldset>
        )}
        <Button
          className="self-start"
          variant="outline"
          onClick={() => doPreview.mutate()}
          disabled={doPreview.isPending || tooLong || body.trim().length === 0}
          data-testid="broadcast-preview"
        >
          {t('compose.preview')}
        </Button>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{explain(error)}</AlertDescription>
          </Alert>
        )}

        {preview && (
          <section
            className="bg-muted/40 flex flex-col gap-3 rounded-xl border p-4"
            aria-labelledby="broadcast-preview-title"
            data-testid="broadcast-preview-panel"
          >
            <h3 id="broadcast-preview-title" className="font-semibold">
              {t('preview.title')}
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {(
                [
                  ['recipients', formatCount(preview.recipients, locale)],
                  ['withoutPhone', formatCount(preview.withoutPhone, locale)],
                  ['merged', formatCount(preview.mergedPhones, locale)],
                  ['segments', formatCount(preview.segments, locale)],
                  ['cost', formatTaka(preview.costPaisa, locale)],
                  ['capLeft', formatCount(preview.capLeftToday, locale)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="text-muted-foreground">{t(`preview.${k}`)}</dt>
                  <dd className="font-semibold tabular-nums" data-testid={`broadcast-preview-${k}`}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            {!preview.fits && (
              <Alert variant="destructive">
                <AlertDescription>{t('preview.notFits')}</AlertDescription>
              </Alert>
            )}
            {preview.quietNow && (
              <p className="text-warning text-sm">
                {t('preview.quiet', {
                  time: `${formatDate(preview.nextAllowedAt, locale)} ${formatTime(preview.nextAllowedAt, locale)}`,
                })}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <label className="flex min-h-(--control-h) items-center gap-2">
                <input
                  type="radio"
                  name="broadcast-when"
                  checked={!later}
                  onChange={() => setLater(false)}
                  className="accent-primary size-4"
                />
                {t('preview.sendNow')}
              </label>
              <label className="flex min-h-(--control-h) items-center gap-2">
                <input
                  type="radio"
                  name="broadcast-when"
                  checked={later}
                  onChange={() => setLater(true)}
                  className="accent-primary size-4"
                />
                {t('preview.schedule')}
              </label>
            </fieldset>
            {later && (
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  id="broadcast-day"
                  type="date"
                  label={t('preview.date')}
                  value={day}
                  onChange={setDay}
                  min={context?.today}
                />
                <Field id="broadcast-time" label={t('preview.time')}>
                  <Input
                    id="broadcast-time"
                    type="time"
                    value={time}
                    min="08:00"
                    max="20:59"
                    onChange={(e) => setTime(e.target.value)}
                  />
                </Field>
                <p className="text-muted-foreground col-span-2 text-sm">{t('preview.scheduleHint')}</p>
              </div>
            )}
            <Button
              className="self-start"
              onClick={() => go.mutate()}
              disabled={
                go.isPending ||
                preview.recipients === 0 ||
                (later ? !day || !time : !preview.fits || preview.quietNow)
              }
              data-testid="broadcast-go"
            >
              <SendIcon aria-hidden />
              {later ? t('preview.confirmSchedule') : t('preview.sendNow')}
            </Button>
          </section>
        )}
      </div>
    </SectionCard>
  );
}
