'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STAFF_ROLE_VALUES,
  formatBdPhone,
  formatDate,
  normalizeBdPhone,
  type SetupClassLevel,
  type SetupSection,
  type StaffMember,
  type StaffRole,
} from '@jantrik/shared';
import {
  BookOpenIcon,
  EllipsisVerticalIcon,
  InfoIcon,
  PhoneIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, SectionCard, TextField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { ConfirmDialog, FormDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName, displayUserName } from '@/lib/names';
import { cn } from '@/lib/utils';

const TEACHING: StaffRole[] = ['OWNER', 'ADMIN', 'TEACHER'];

type Dialog =
  | { kind: 'add' }
  | { kind: 'roles'; member: StaffMember }
  | { kind: 'sections'; member: StaffMember }
  | { kind: 'status'; member: StaffMember }
  | null;

function useStaffError() {
  const t = useTranslations('staff');
  const describe = useErrorMessage();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      const known: Record<string, string> = {
        ALREADY_STAFF: t('errorAlreadyStaff'),
        LAST_OWNER: t('errorLastOwner'),
        SELF_CHANGE: t('errorSelf'),
        NOT_TEACHING: t('errorNotTeaching'),
        INVALID_SECTIONS: t('errorSections'),
        NO_CURRENT_YEAR: t('errorNoYear'),
      };
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 403) return t('errorOwnerOnly');
      if (e.status === 400) return t('errorCheckForm');
    }
    return describe(e);
  };
}

/** Staff: who works here, with which roles; add by phone, change roles, deactivate. */
export default function StaffPage() {
  const t = useTranslations('staff');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const callerIsOwner = context?.roles.includes('OWNER') ?? false;
  const staff = useQuery({
    queryKey: ['staff', session?.tenant?.id],
    queryFn: () => client.api<StaffMember[]>('/staff'),
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  return (
    <PageGate page="staff">
      <SectionCard
        id="staff"
        title={t('title')}
        hint={t('hint')}
        actions={
          <Button onClick={() => setDialog({ kind: 'add' })} data-testid="add-staff">
            <PlusIcon aria-hidden />
            {t('add')}
          </Button>
        }
      >
        {staff.isPending ? (
          <Skeleton className="h-48" />
        ) : staff.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(staff.error)}</AlertDescription>
          </Alert>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="staff-list">
            {staff.data.map((m) => (
              <StaffCard
                key={m.userId}
                member={m}
                callerIsOwner={callerIsOwner}
                onRoles={() => setDialog({ kind: 'roles', member: m })}
                onSections={() => setDialog({ kind: 'sections', member: m })}
                onStatus={() => setDialog({ kind: 'status', member: m })}
              />
            ))}
          </ul>
        )}
      </SectionCard>
      {dialog?.kind === 'add' && <AddStaffDialog callerIsOwner={callerIsOwner} onClose={close} />}
      {dialog?.kind === 'roles' && (
        <RolesDialog member={dialog.member} callerIsOwner={callerIsOwner} onClose={close} />
      )}
      {dialog?.kind === 'sections' && <SectionsDialog member={dialog.member} onClose={close} />}
      {dialog?.kind === 'status' && <StatusDialog member={dialog.member} onClose={close} />}
    </PageGate>
  );
}

function StaffCard({
  member: m,
  callerIsOwner,
  onRoles,
  onSections,
  onStatus,
}: {
  member: StaffMember;
  callerIsOwner: boolean;
  onRoles: () => void;
  onSections: () => void;
  onStatus: () => void;
}) {
  const t = useTranslations('staff');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = displayUserName(m, locale);
  const active = m.status === 'ACTIVE';
  // Owners are managed by owners only (the API enforces it too).
  const canManage = !m.isSelf && (callerIsOwner || !m.roles.includes('OWNER'));
  const teaches = m.roles.some((r) => TEACHING.includes(r));
  return (
    <li
      className={cn('flex min-w-0 gap-3 rounded-lg border p-3', !active && 'bg-muted/40')}
      data-testid="staff-card"
    >
      <PersonAvatar name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold break-words">
              {name}
              {m.isSelf && <span className="text-muted-foreground font-normal"> ({t('you')})</span>}
            </span>
            <a
              href={`tel:${m.phone}`}
              className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
              dir="ltr"
            >
              <PhoneIcon aria-hidden className="size-3.5" />
              {formatBdPhone(m.phone)}
            </a>
          </div>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={t('actions', { name })}>
                    <EllipsisVerticalIcon aria-hidden />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={onRoles}>
                  <ShieldIcon aria-hidden />
                  {t('changeRoles')}
                </DropdownMenuItem>
                {teaches && active && (
                  <DropdownMenuItem onClick={onSections}>
                    <BookOpenIcon aria-hidden />
                    {t('assignSections', {
                      section: label('section', 'Section', { inText: true }),
                    })}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onStatus} variant={active ? 'destructive' : 'default'}>
                  {active ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}
                  {active ? t('deactivate') : t('activate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {m.roles.map((r) => (
            <Badge key={r} variant={r === 'OWNER' ? 'warm' : 'soft'}>
              {tRoles(r)}
            </Badge>
          ))}
          {!active && <Badge variant="warning">{t('inactive')}</Badge>}
        </div>
        {m.sections.length > 0 && (
          <p className="text-muted-foreground text-sm break-words">
            {m.sections
              .map(
                (s) =>
                  `${displayName(s.classLevel.nameBn, s.classLevel.nameEn, locale)} ${s.name}${s.isClassTeacher ? ` (${t('classTeacher')})` : ''}`,
              )
              .join(', ')}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {t('since', { date: formatDate(new Date(m.since), locale, 'medium') })}
        </p>
      </div>
    </li>
  );
}

/** Roles a caller may hand out: OWNER only by an owner. */
const assignable = (callerIsOwner: boolean) =>
  STAFF_ROLE_VALUES.filter((r) => r !== 'OWNER' || callerIsOwner);

function RoleChoices({
  value,
  onChange,
  callerIsOwner,
}: {
  value: StaffRole[];
  onChange: (roles: StaffRole[]) => void;
  callerIsOwner: boolean;
}) {
  const t = useTranslations('staff');
  const tRoles = useTranslations('roles');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('roles')}</legend>
      <div className="flex flex-wrap gap-2">
        {assignable(callerIsOwner).map((r) => (
          <label
            key={r}
            className={cn(
              'flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium',
              'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-3',
              value.includes(r)
                ? 'border-primary bg-primary-soft text-accent-foreground'
                : 'bg-card',
            )}
          >
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={value.includes(r)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))
              }
            />
            {tRoles(r)}
          </label>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">{t('rolesHint')}</p>
    </fieldset>
  );
}

function useStaffMutation<I>(
  fn: (input: I) => Promise<unknown>,
  done: () => void,
  success: string,
) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const message = useStaffError();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff', session?.tenant?.id] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-staff'] });
      void queryClient.invalidateQueries({ queryKey: ['section-teachers'] });
      toast.success(success);
      done();
    },
    onError: (e) => toast.error(message(e)),
  });
}

function AddStaffDialog({
  callerIsOwner,
  onClose,
}: {
  callerIsOwner: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('staff');
  const { client } = useAuth();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [nameBn, setNameBn] = useState('');
  const [roles, setRoles] = useState<StaffRole[]>(['TEACHER']);
  const [touched, setTouched] = useState(false);
  const phoneOk = normalizeBdPhone(phone) !== null;
  const save = useStaffMutation(
    () =>
      client.api('/staff', {
        method: 'POST',
        json: { phone, name, nameBn: nameBn || null, roles },
      }),
    onClose,
    t('added'),
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('add')}
      submitLabel={t('addSubmit')}
      pending={save.isPending}
      onSubmit={() => {
        setTouched(true);
        if (phoneOk && roles.length > 0) save.mutate(undefined);
      }}
      testId="add-staff-dialog"
    >
      <TextField
        id="staff-phone"
        label={t('phone')}
        value={phone}
        onChange={setPhone}
        required
        inputMode="tel"
        autoComplete="off"
        placeholder="01XXXXXXXXX"
        dir="ltr"
        hint={t('phoneHint')}
        error={touched && !phoneOk ? t('errorPhone') : null}
      />
      <TextField
        id="staff-name"
        label={t('nameEn')}
        value={name}
        onChange={setName}
        required
        maxLength={100}
        lang="en"
      />
      <TextField
        id="staff-name-bn"
        label={t('nameBn')}
        value={nameBn}
        onChange={setNameBn}
        maxLength={100}
        lang="bn"
        hint={t('nameBnHint')}
      />
      <RoleChoices value={roles} onChange={setRoles} callerIsOwner={callerIsOwner} />
      {touched && roles.length === 0 && (
        <p className="text-destructive text-sm" role="alert">
          {t('errorNoRole')}
        </p>
      )}
      <Alert>
        <InfoIcon aria-hidden />
        <AlertDescription data-testid="otp-note">{t('otpNote')}</AlertDescription>
      </Alert>
    </FormDialog>
  );
}

function RolesDialog({
  member,
  callerIsOwner,
  onClose,
}: {
  member: StaffMember;
  callerIsOwner: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('staff');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [roles, setRoles] = useState<StaffRole[]>(member.roles);
  const save = useStaffMutation(
    () => client.api(`/staff/${member.userId}/roles`, { method: 'PUT', json: { roles } }),
    onClose,
    t('saved'),
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('rolesTitle', { name: displayUserName(member, locale) })}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => roles.length > 0 && save.mutate(undefined)}
      testId="roles-dialog"
    >
      <RoleChoices value={roles} onChange={setRoles} callerIsOwner={callerIsOwner} />
      {roles.length === 0 && (
        <p className="text-destructive text-sm" role="alert">
          {t('errorNoRole')}
        </p>
      )}
    </FormDialog>
  );
}

function SectionsDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const t = useTranslations('staff');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const yearId = context?.academicYear?.id;
  const sections = useQuery({
    queryKey: ['setup', session?.tenant?.id, `/setup/sections?academicYearId=${yearId}`],
    queryFn: () => client.api<SetupSection[]>(`/setup/sections?academicYearId=${yearId}`),
    enabled: Boolean(yearId),
  });
  const classLevels = useQuery({
    queryKey: ['setup', session?.tenant?.id, '/setup/class-levels'],
    queryFn: () => client.api<SetupClassLevel[]>('/setup/class-levels'),
  });
  const [chosen, setChosen] = useState<string[]>(member.sections.map((s) => s.id));
  const save = useStaffMutation(
    () =>
      client.api(`/staff/${member.userId}/sections`, {
        method: 'PUT',
        json: { sectionIds: chosen },
      }),
    onClose,
    t('saved'),
  );
  const section = label('section', 'Section', { inText: true });
  const active = (sections.data ?? []).filter((s) => s.isActive);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('sectionsTitle', { name: displayUserName(member, locale), section })}
      description={t('sectionsHint')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="sections-dialog"
    >
      {!yearId ? (
        <p className="text-muted-foreground text-sm">{t('errorNoYear')}</p>
      ) : sections.isPending || classLevels.isPending ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="flex flex-col gap-3">
          {(classLevels.data ?? [])
            .filter((c) => active.some((s) => s.classLevelId === c.id))
            .map((c) => (
              <Field
                key={c.id}
                id={`sections-${c.id}`}
                label={displayName(c.nameBn, c.nameEn, locale)}
              >
                <div className="flex flex-wrap gap-2" id={`sections-${c.id}`} role="group">
                  {active
                    .filter((s) => s.classLevelId === c.id)
                    .map((s) => (
                      <label
                        key={s.id}
                        className={cn(
                          'flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium',
                          chosen.includes(s.id) ? 'border-primary bg-primary-soft' : 'bg-card',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary size-4"
                          checked={chosen.includes(s.id)}
                          aria-label={`${displayName(c.nameBn, c.nameEn, locale)} ${s.name}`}
                          onChange={(e) =>
                            setChosen((x) =>
                              e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id),
                            )
                          }
                        />
                        {s.name}
                      </label>
                    ))}
                </div>
              </Field>
            ))}
        </div>
      )}
    </FormDialog>
  );
}

function StatusDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const t = useTranslations('staff');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const active = member.status === 'ACTIVE';
  const name = displayUserName(member, locale);
  const save = useStaffMutation(
    () =>
      client.api(`/staff/${member.userId}/${active ? 'deactivate' : 'activate'}`, {
        method: 'POST',
      }),
    onClose,
    t('saved'),
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={active ? t('deactivateTitle', { name }) : t('activateTitle', { name })}
      body={active ? t('deactivateBody') : t('activateBody')}
      confirmLabel={active ? t('deactivate') : t('activate')}
      destructive={active}
      pending={save.isPending}
      onConfirm={() => save.mutate(undefined)}
    />
  );
}
