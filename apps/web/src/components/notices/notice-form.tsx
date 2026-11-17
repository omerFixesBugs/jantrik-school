'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  NOTICE_AUDIENCES,
  NOTICE_LIMITS,
  type NoticeAudience,
  type NoticeInputBody,
  type NoticeManageItem,
  type SetupClassLevel,
  type SetupSection,
} from '@jantrik/shared';
import { PlusIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, SectionCard, SelectField, TextField, ToggleField } from '@/components/form-kit';
import { useNoticeError, useRefreshNotices } from '@/components/notices/notice-dialogs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { endOfDayInstant, expiryDay } from '@/lib/notices';
import { cn } from '@/lib/utils';

interface TargetRow {
  key: number;
  classLevelId: string;
  sectionId: string;
}

/** Write or edit a notice (OWNER/ADMIN). Publishing is a separate step on the list (P6-A). */
export function NoticeForm({ notice }: { notice?: NoticeManageItem }) {
  const t = useTranslations('notices.manage');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const refresh = useRefreshNotices();
  const explain = useNoticeError();
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

  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [audience, setAudience] = useState<NoticeAudience>(notice?.audience ?? 'ALL');
  const [targets, setTargets] = useState<TargetRow[]>(
    (notice?.targets ?? []).map((x, i) => ({
      key: i,
      classLevelId: x.classLevelId,
      sectionId: x.sectionId ?? '',
    })),
  );
  const [expires, setExpires] = useState(notice?.expiresAt ? expiryDay(notice.expiresAt) : '');
  const [pinned, setPinned] = useState(notice?.pinned ?? false);

  const save = useMutation({
    mutationFn: () => {
      const json: NoticeInputBody = {
        title,
        body,
        audience,
        targets:
          audience === 'STAFF'
            ? []
            : targets
                .filter((x) => x.classLevelId)
                .map((x) => ({ classLevelId: x.classLevelId, sectionId: x.sectionId || null })),
        expiresAt: expires ? endOfDayInstant(expires) : null,
        pinned,
      };
      return notice
        ? client.api<NoticeManageItem>(`/notices/${notice.id}`, { method: 'PUT', json })
        : client.api<NoticeManageItem>('/notices', { method: 'POST', json });
    },
    onSuccess: async () => {
      toast.success(t('form.saved'));
      await refresh();
      router.push('/notices/manage');
    },
  });

  const className = (c: SetupClassLevel) => (locale === 'bn' ? c.nameBn : c.nameEn);
  const activeClasses = (classes.data ?? []).filter((c) => c.isActive);
  const ready = title.trim().length > 0 && body.trim().length > 0 && !save.isPending;

  return (
    <SectionCard
      id="notice-form"
      title={notice ? t('form.editTitle') : t('form.newTitle')}
      hint={notice?.status === 'PUBLISHED' ? t('form.editedWarning') : undefined}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <TextField
          id="notice-title"
          label={t('form.titleLabel')}
          value={title}
          onChange={setTitle}
          maxLength={NOTICE_LIMITS.title}
          required
        />
        <Field id="notice-body" label={t('form.bodyLabel')} hint={t('form.bodyHint')} required>
          <textarea
            id="notice-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={NOTICE_LIMITS.body}
            rows={8}
            required
            className={cn(
              'border-input bg-card w-full min-w-0 rounded-md border px-2.5 py-2 text-(length:--input-fs) outline-none',
              'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
            )}
          />
        </Field>
        <SelectField
          id="notice-audience"
          label={t('form.audienceLabel')}
          value={audience}
          onChange={(v) => setAudience(v as NoticeAudience)}
          options={NOTICE_AUDIENCES.map((a) => ({ value: a, label: t(`audience.${a}`) }))}
        />
        {audience !== 'STAFF' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">{t('form.targetsLabel')}</legend>
            <p className="text-muted-foreground text-sm">{t('form.targetsHint')}</p>
            {targets.map((row) => {
              const classSections = (sections.data ?? []).filter(
                (s) => s.classLevelId === row.classLevelId && s.isActive,
              );
              const update = (patch: Partial<TargetRow>) =>
                setTargets((all) => all.map((x) => (x.key === row.key ? { ...x, ...patch } : x)));
              return (
                <div key={row.key} className="flex flex-wrap items-end gap-2">
                  <SelectField
                    id={`notice-target-class-${row.key}`}
                    label={t('form.classLabel')}
                    className="min-w-40 flex-1"
                    value={row.classLevelId}
                    placeholder=""
                    onChange={(v) => update({ classLevelId: v, sectionId: '' })}
                    options={activeClasses.map((c) => ({ value: c.id, label: className(c) }))}
                  />
                  <SelectField
                    id={`notice-target-section-${row.key}`}
                    label={t('form.sectionLabel')}
                    className="min-w-32 flex-1"
                    value={row.sectionId}
                    placeholder={t('form.wholeClass')}
                    onChange={(v) => update({ sectionId: v })}
                    options={classSections.map((s) => ({ value: s.id, label: s.name }))}
                    disabled={!row.classLevelId}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('form.removeTarget')}
                    onClick={() => setTargets((all) => all.filter((x) => x.key !== row.key))}
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
              onClick={() =>
                setTargets((all) => [
                  ...all,
                  {
                    key: Math.max(-1, ...all.map((x) => x.key)) + 1,
                    classLevelId: '',
                    sectionId: '',
                  },
                ])
              }
            >
              <PlusIcon aria-hidden />
              {t('form.addTarget')}
            </Button>
          </fieldset>
        )}
        <TextField
          id="notice-expires"
          type="date"
          label={t('form.expiresLabel')}
          hint={t('form.expiresHint')}
          value={expires}
          onChange={setExpires}
          min={context?.today}
        />
        <ToggleField
          id="notice-pinned"
          checked={pinned}
          onChange={setPinned}
          label={t('form.pinnedLabel')}
        />
        {save.error && (
          <Alert variant="destructive">
            <AlertDescription>{explain(save.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!ready} data-testid="notice-save">
            {t('form.save')}
          </Button>
          <ButtonLink variant="outline" href="/notices/manage">
            {t('form.cancel')}
          </ButtonLink>
        </div>
      </form>
    </SectionCard>
  );
}
