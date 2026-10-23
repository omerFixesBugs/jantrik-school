'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatBdPhone,
  formatDate,
  type SetupClassLevel,
  type SetupSection,
  type StaffMember,
  type StaffRole,
} from '@jantrik/shared';
import {
  BookOpenIcon,
  CircleMinusIcon,
  EllipsisVerticalIcon,
  HandCoinsIcon,
  PhoneIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  SendIcon,
  ShieldIcon,
  XCircleIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Field, SectionCard } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { ConfirmDialog, FormDialog } from '@/components/setup/setup-kit';
import { AddStaffDialog, RoleChoices, useStaffMutation } from '@/components/staff/staff-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  // Not `Dialog`: that name is this page's open-dialog state type.
  Dialog as UiDialog,
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
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
  | { kind: 'cancel'; member: StaffMember }
  | { kind: 'feeCollection'; member: StaffMember; give: boolean }
  | null;

/** Staff: who works here, with which roles; add by phone, change roles, deactivate. */
export default function StaffPage() {
  const t = useTranslations('staff');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const callerIsOwner = context?.roles.includes('OWNER') ?? false;
  // Fee collection is a role (ACCOUNTANT); offered in one step only when fees are switched on.
  const feesOn = context?.modules.includes('FEES') ?? false;
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
                onCancel={() => setDialog({ kind: 'cancel', member: m })}
                onFeeCollection={
                  feesOn
                    ? (give) => setDialog({ kind: 'feeCollection', member: m, give })
                    : undefined
                }
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
      {dialog?.kind === 'cancel' && <CancelDialog member={dialog.member} onClose={close} />}
      {dialog?.kind === 'feeCollection' && (
        <FeeCollectionDialog member={dialog.member} give={dialog.give} onClose={close} />
      )}
    </PageGate>
  );
}

function StaffCard({
  member: m,
  callerIsOwner,
  onRoles,
  onSections,
  onStatus,
  onCancel,
  onFeeCollection,
}: {
  member: StaffMember;
  callerIsOwner: boolean;
  onRoles: () => void;
  onSections: () => void;
  onStatus: () => void;
  onCancel: () => void;
  /** Give (true) or take away (false) fee collection; absent when fees are off. */
  onFeeCollection?: (give: boolean) => void;
}) {
  const t = useTranslations('staff');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = displayUserName(m, locale);
  const active = m.status === 'ACTIVE';
  const member = m.status === 'ACTIVE' || m.status === 'DISABLED';
  const pending = m.status === 'INVITED';
  const { client } = useAuth();
  const reinvite = useStaffMutation(
    () => client.api(`/staff/${m.userId}/reinvite`, { method: 'POST' }),
    () => {},
    t('added'),
  );
  // Owners are managed by owners only (the API enforces it too).
  const canManage = !m.isSelf && (callerIsOwner || !m.roles.includes('OWNER'));
  const teaches = m.roles.some((r) => TEACHING.includes(r));
  // OWNER and ADMIN collect fees already. Taking it away must leave another role.
  const collects = m.roles.includes('ACCOUNTANT');
  const feeCollection =
    onFeeCollection &&
    (member || pending) &&
    !m.roles.includes('OWNER') &&
    !m.roles.includes('ADMIN') &&
    (!collects || m.roles.length > 1)
      ? { give: !collects }
      : null;
  return (
    <li
      className={cn('flex min-w-0 gap-3 rounded-lg border p-3', !active && 'bg-muted/40')}
      data-testid="staff-card"
      data-user-id={m.userId}
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
                {feeCollection && (
                  <DropdownMenuItem
                    onClick={() => onFeeCollection?.(feeCollection.give)}
                    data-testid="staff-fee-collection"
                  >
                    {feeCollection.give ? (
                      <HandCoinsIcon aria-hidden />
                    ) : (
                      <CircleMinusIcon aria-hidden />
                    )}
                    {feeCollection.give ? t('feeCollectionGive') : t('feeCollectionRemove')}
                  </DropdownMenuItem>
                )}
                {!member && !pending && (
                  <DropdownMenuItem onClick={() => reinvite.mutate(undefined)}>
                    <SendIcon aria-hidden />
                    {t('reinvite')}
                  </DropdownMenuItem>
                )}
                {!member && (
                  <DropdownMenuItem onClick={onCancel} variant="destructive">
                    <XCircleIcon aria-hidden />
                    {t('cancelInvitation')}
                  </DropdownMenuItem>
                )}
                {teaches && active && (
                  <DropdownMenuItem onClick={onSections}>
                    <BookOpenIcon aria-hidden />
                    {t('assignSections', {
                      section: label('section', 'Section', { inText: true }),
                    })}
                  </DropdownMenuItem>
                )}
                {member && (
                  <DropdownMenuItem onClick={onStatus} variant={active ? 'destructive' : 'default'}>
                    {active ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}
                    {active ? t('deactivate') : t('activate')}
                  </DropdownMenuItem>
                )}
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
          {m.status === 'DISABLED' && <Badge variant="warning">{t('inactive')}</Badge>}
          {!member && (
            <Badge variant={pending ? 'soft' : 'warning'} data-testid="invite-status">
              {t(`status${m.status}`)}
            </Badge>
          )}
        </div>
        {pending && m.inviteExpiresAt && (
          <p className="text-muted-foreground text-sm">
            {t('inviteUntil', { date: formatDate(new Date(m.inviteExpiresAt), locale, 'long') })}
          </p>
        )}
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
        {member && (
          <p className="text-muted-foreground text-xs">
            {t('since', { date: formatDate(new Date(m.since), locale, 'medium') })}
          </p>
        )}
      </div>
    </li>
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

/**
 * "Give fee collection" (adds ACCOUNTANT, keeps every other role) or "remove fee collection",
 * confirmed in one step. The full set of roles goes to PUT /staff/:userId/roles.
 */
function FeeCollectionDialog({
  member,
  give,
  onClose,
}: {
  member: StaffMember;
  give: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('staff');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const name = displayUserName(member, locale);
  const roles: StaffRole[] = give
    ? [...member.roles.filter((r) => r !== 'ACCOUNTANT'), 'ACCOUNTANT']
    : member.roles.filter((r) => r !== 'ACCOUNTANT');
  const save = useStaffMutation(
    () => client.api(`/staff/${member.userId}/roles`, { method: 'PUT', json: { roles } }),
    onClose,
    give ? t('feeCollectionGiven', { name }) : t('feeCollectionRemoved', { name }),
  );
  return (
    <UiDialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="staff-fee-collection-dialog">
        <DialogHeader>
          <DialogTitle>
            {give ? t('feeCollectionGiveTitle', { name }) : t('feeCollectionRemoveTitle', { name })}
          </DialogTitle>
          <DialogDescription>
            {give ? t('feeCollectionGiveBody') : t('feeCollectionRemoveBody')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('feeCollectionCancel')}
          </Button>
          <Button
            variant={give ? 'default' : 'destructive'}
            onClick={() => save.mutate(undefined)}
            disabled={save.isPending}
            data-testid="staff-fee-collection-confirm"
          >
            {give ? t('feeCollectionGive') : t('feeCollectionRemove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </UiDialog>
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
                          'flex min-h-(--control-h) cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium',
                          chosen.includes(s.id) ? 'border-primary-ink bg-primary-soft' : 'bg-card',
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

function CancelDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const t = useTranslations('staff');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const save = useStaffMutation(
    () => client.api(`/staff/${member.userId}/cancel-invitation`, { method: 'POST' }),
    onClose,
    t('cancelled'),
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('cancelTitle', { name: displayUserName(member, locale) })}
      body={t('cancelBody')}
      confirmLabel={t('cancelInvitation')}
      pending={save.isPending}
      onConfirm={() => save.mutate(undefined)}
    />
  );
}
