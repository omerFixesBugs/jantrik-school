'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAFF_ROLE_VALUES, normalizeBdPhone, type StaffRole } from '@jantrik/shared';
import { InfoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { TextField } from '@/components/form-kit';
import { FormDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

// Staff pieces shared by the staff page and the setup wizard.

/** The staff API's errors in the institute's words. */
export function useStaffError() {
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
      if (e.status === 429) return t('errorRateLimit');
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 403) return t('errorOwnerOnly');
      if (e.status === 400) return t('errorCheckForm');
    }
    return describe(e);
  };
}

/** Roles a caller may hand out: OWNER only by an owner. */
const assignable = (callerIsOwner: boolean) =>
  STAFF_ROLE_VALUES.filter((r) => r !== 'OWNER' || callerIsOwner);

export function RoleChoices({
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
              'flex min-h-(--control-h) cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium',
              'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-3',
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

export function useStaffMutation<I>(
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

/** Add someone by phone with roles; they get an invitation (accepted after an OTP sign-in). */
export function AddStaffDialog({
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
