'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  INSTITUTE_PROFILE_LIMITS as L,
  INSTITUTE_PROFILE_PATTERNS as P,
  normalizeInstitutePhone,
  normalizeWebsite,
  toAsciiDigits,
  type FileRef,
  type InstituteImageSlot,
  type InstituteProfile,
  type InstituteProfileFields,
} from '@jantrik/shared';
import { Trash2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionCard, TextField } from '@/components/form-kit';
import { ChooseImageButton, imageForm } from '@/components/image-upload';
import { ConfirmDialog, SetupPage } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthedImage, useImageErrorMessage } from '@/lib/authed-image';
import { useErrorMessage } from '@/lib/hooks';

const BANGLA = /[ঀ-৿]/;

/** Settings → Institute profile (OWNER/ADMIN): names, contact, head, and three images. */
export default function InstituteProfilePage() {
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const profile = useQuery({
    queryKey: ['institute-profile', session?.tenant?.id],
    queryFn: () => client.api<InstituteProfile>('/institute/profile'),
  });
  return (
    <SetupPage tab="profile">
      {profile.isPending ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : profile.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(profile.error)}</AlertDescription>
        </Alert>
      ) : (
        <>
          <ProfileForm initial={profile.data} />
          <ImagesCard profile={profile.data} />
        </>
      )}
    </SetupPage>
  );
}

type Form = Record<keyof InstituteProfileFields, string>;

const KEYS: (keyof InstituteProfileFields)[] = [
  'nameBn',
  'nameEn',
  'shortName',
  'eiin',
  'addressBn',
  'addressEn',
  'phone',
  'email',
  'website',
  'headTitleBn',
  'headTitleEn',
  'headNameBn',
  'headNameEn',
  'establishedYear',
];

/** The form's starting values: the saved profile, or the registered name in its script. */
function initialForm(p: InstituteProfile): Form {
  const form = Object.fromEntries(KEYS.map((k) => [k, p[k] === null ? '' : String(p[k])])) as Form;
  if (!p.saved) form[BANGLA.test(p.registeredName) ? 'nameBn' : 'nameEn'] = p.registeredName;
  return form;
}

/** The same rules as the API (files-schema.ts), on the typed text; null when fine. */
function problems(f: Form): Partial<Record<keyof Form, string>> {
  const out: Partial<Record<keyof Form, string>> = {};
  if (!f.nameBn.trim() && !f.nameEn.trim()) out.nameBn = 'profileNameRequired';
  const eiin = toAsciiDigits(f.eiin).replace(/\s/g, '');
  if (eiin && !P.eiin.test(eiin)) out.eiin = 'eiinError';
  if (f.phone.trim() && !P.phone.test(normalizeInstitutePhone(f.phone))) out.phone = 'phoneError';
  if (f.email.trim() && !P.email.test(f.email.trim())) out.email = 'emailError';
  if (f.website.trim()) {
    const w = normalizeWebsite(f.website);
    if (w.length > L.website || !P.website.test(w)) out.website = 'websiteError';
  }
  const year = toAsciiDigits(f.establishedYear).trim();
  if (year && !(/^\d{4}$/.test(year) && +year >= L.yearMin && +year <= L.yearMax)) {
    out.establishedYear = 'yearError';
  }
  return out;
}

function ProfileForm({ initial }: { initial: InstituteProfile }) {
  const t = useTranslations('setup');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => initialForm(initial));
  const [tried, setTried] = useState(false);
  const errors = problems(form);
  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      client.api<InstituteProfile>('/institute/profile', {
        method: 'PUT',
        json: Object.fromEntries(KEYS.map((k) => [k, form[k].trim() || null])),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(['institute-profile', session?.tenant?.id], next);
      setForm(initialForm(next));
      setTried(false);
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(describe(e)),
  });
  const field = (
    k: keyof Form,
    opts: {
      max?: number;
      hint?: string;
      dir?: 'ltr';
      inputMode?: 'numeric' | 'tel' | 'email';
    } = {},
  ) => (
    <TextField
      id={`profile-${k}`}
      label={t(k)}
      value={form[k]}
      onChange={set(k)}
      maxLength={opts.max}
      hint={opts.hint}
      dir={opts.dir}
      inputMode={opts.inputMode}
      error={tried && errors[k] ? t(errors[k]) : null}
    />
  );
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(errors).length === 0) save.mutate();
      }}
      data-testid="institute-profile-form"
      className="flex flex-col gap-(--section-gap)"
    >
      <SectionCard
        id="profile-names"
        title={t('tabProfile')}
        hint={`${t('profileHint')} ${t('profileRegistered', { name: initial.registeredName })}`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {field('nameBn', { max: L.name })}
          {field('nameEn', { max: L.name })}
          {field('shortName', { max: L.shortName, hint: t('shortNameHint') })}
          {field('eiin', { max: 12, hint: t('eiinHint'), dir: 'ltr', inputMode: 'numeric' })}
          {field('establishedYear', { max: 4, inputMode: 'numeric' })}
        </div>
      </SectionCard>
      <SectionCard id="profile-contact" title={t('profileContact')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('addressBn', { max: L.address })}
          {field('addressEn', { max: L.address })}
          {field('phone', { max: 20, dir: 'ltr', inputMode: 'tel' })}
          {field('email', { max: L.email, dir: 'ltr', inputMode: 'email' })}
          {field('website', { max: L.website, dir: 'ltr' })}
        </div>
      </SectionCard>
      <SectionCard id="profile-head" title={t('profileHead')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('headTitleBn', { max: L.headTitle, hint: t('headTitleBnHint') })}
          {field('headTitleEn', { max: L.headTitle, hint: t('headTitleEnHint') })}
          {field('headNameBn', { max: L.headName })}
          {field('headNameEn', { max: L.headName })}
        </div>
        <Button
          type="submit"
          className="w-fit"
          disabled={save.isPending}
          data-testid="profile-save"
        >
          {t('save')}
        </Button>
      </SectionCard>
    </form>
  );
}

const SLOTS: { slot: InstituteImageSlot; key: 'logo' | 'signature' | 'seal' }[] = [
  { slot: 'logo', key: 'logo' },
  { slot: 'signature', key: 'signature' },
  { slot: 'seal', key: 'seal' },
];

const SLOT_TEXT = {
  logo: { name: 'imageLogo', hint: 'imageLogoHint' },
  signature: { name: 'imageSignature', hint: 'imageSignatureHint' },
  seal: { name: 'imageSeal', hint: 'imageSealHint' },
} as const;

function ImagesCard({ profile }: { profile: InstituteProfile }) {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const mb = (bytes: number) => formatCount(Math.round((bytes / 1024 / 1024) * 10) / 10, locale);
  return (
    <SectionCard id="profile-images" title={t('imagesTitle')} hint={t('imagesHint')}>
      <ul className="grid gap-3 sm:grid-cols-3">
        {SLOTS.map(({ slot, key }) => (
          <ImageSlot key={slot} slot={slot} file={profile[key]} />
        ))}
      </ul>
      <p className="text-muted-foreground text-sm" data-testid="storage-used">
        {t('storageUsed', {
          used: mb(profile.storage.bytesUsed),
          cap: mb(profile.storage.capBytes),
        })}
      </p>
    </SectionCard>
  );
}

function ImageSlot({ slot, file }: { slot: InstituteImageSlot; file: FileRef | null }) {
  const t = useTranslations('setup');
  const tErrors = useTranslations('errors');
  const describe = useImageErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const url = useAuthedImage(`/institute/profile/${slot}`, file?.id ?? null);
  const name = t(SLOT_TEXT[slot].name);
  const done = (next: InstituteProfile, message: string) => {
    queryClient.setQueryData(['institute-profile', session?.tenant?.id], next);
    toast.success(message);
  };
  const upload = useMutation({
    mutationFn: (f: File) =>
      client.api<InstituteProfile>(`/institute/profile/${slot}`, {
        method: 'PUT',
        body: imageForm(f),
      }),
    onSuccess: (next) => done(next, t('imageSaved')),
    onError: (e) => toast.error(describe(e)),
  });
  const remove = useMutation({
    mutationFn: () =>
      client.api<InstituteProfile>(`/institute/profile/${slot}`, { method: 'DELETE' }),
    onSuccess: (next) => {
      setConfirm(false);
      done(next, t('imageRemoved'));
    },
    onError: (e) => toast.error(describe(e)),
  });
  const pending = upload.isPending || remove.isPending;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3" data-testid={`image-${slot}`}>
      <span className="font-medium">{name}</span>
      <div className="bg-canvas flex h-32 items-center justify-center rounded-md border">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={name} className="max-h-28 max-w-full object-contain" />
        ) : (
          <span className="text-muted-foreground text-sm">{t('imageNone')}</span>
        )}
      </div>
      <span className="text-muted-foreground text-xs">{t(SLOT_TEXT[slot].hint)}</span>
      <div className="flex flex-wrap gap-2">
        <ChooseImageButton
          size="sm"
          disabled={pending}
          onChoose={(f) => upload.mutate(f)}
          onTooLarge={() => toast.error(tErrors('fileTooLarge'))}
          opaque={false}
          testId={`image-${slot}-choose`}
        >
          {file ? t('imageReplace') : t('imageUpload')}
        </ChooseImageButton>
        {file && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirm(true)}
            data-testid={`image-${slot}-remove`}
          >
            <Trash2Icon aria-hidden />
            {t('imageRemove')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('imageRemoveTitle', { name })}
        confirmLabel={t('imageRemove')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}
