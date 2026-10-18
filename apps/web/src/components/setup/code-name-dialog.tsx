'use client';

import { toAsciiDigits } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { TextField, useFieldErrors } from '@/components/form-kit';
import { FormDialog, useSetupMutation } from '@/components/setup/setup-kit';
import { useAuth } from '@/lib/auth/auth-provider';

/** Create/edit a class level or study group (code + Bangla/English names + order). */
export function CodeNameDialog({
  path,
  item,
  title,
  codeHint,
  onClose,
}: {
  path: string;
  item: { id: string; code: string; nameBn: string; nameEn: string; sortOrder: number } | null;
  title: string;
  codeHint: string;
  onClose: () => void;
}) {
  const t = useTranslations('setup');
  const fieldErrors = useFieldErrors();
  const { client } = useAuth();
  const [code, setCode] = useState(item?.code ?? '');
  const [nameBn, setNameBn] = useState(item?.nameBn ?? '');
  const [nameEn, setNameEn] = useState(item?.nameEn ?? '');
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? 0));
  const save = useSetupMutation(
    () => {
      const json = { code, nameBn, nameEn, sortOrder: Number(toAsciiDigits(sortOrder)) || 0 };
      return item
        ? client.api(`${path}/${item.id}`, { method: 'PATCH', json })
        : client.api(path, { method: 'POST', json });
    },
    { success: t('saved'), onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="code-name-dialog"
    >
      <TextField
        id="cn-name-bn"
        label={t('nameBn')}
        value={nameBn}
        onChange={setNameBn}
        required
        maxLength={80}
        lang="bn"
        error={errors['nameBn']}
      />
      <TextField
        id="cn-name-en"
        label={t('nameEn')}
        value={nameEn}
        onChange={setNameEn}
        required
        maxLength={80}
        lang="en"
        error={errors['nameEn']}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="cn-code"
          label={t('code')}
          value={code}
          onChange={setCode}
          required
          maxLength={30}
          dir="ltr"
          hint={codeHint}
          error={errors['code']}
        />
        <TextField
          id="cn-order"
          label={t('sortOrder')}
          value={sortOrder}
          onChange={setSortOrder}
          inputMode="numeric"
          hint={t('sortOrderHint')}
          error={errors['sortOrder']}
        />
      </div>
    </FormDialog>
  );
}
