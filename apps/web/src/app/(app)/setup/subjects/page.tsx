'use client';

import {
  toAsciiDigits,
  type SetupClassLevel,
  type SetupStudyGroup,
  type SetupSubject,
} from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  InactiveBadge,
  SectionCard,
  SelectField,
  TextField,
  ToggleField,
  useFieldErrors,
} from '@/components/form-kit';
import {
  ConfirmDialog,
  FormDialog,
  RowActions,
  SetupPage,
  useEditing,
  useSetupMutation,
  useSetupQuery,
} from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';

const PATH = '/setup/subjects';

/** Subjects of one class level, with an optional study group and "optional subject" flag. */
export default function SubjectsPage() {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const classLevels = useSetupQuery<SetupClassLevel[]>('/setup/class-levels');
  const groups = useSetupQuery<SetupStudyGroup[]>('/setup/study-groups');
  const [classLevelId, setClassLevelId] = useState<string | null>(null);
  const classLevel =
    classLevels.data?.find((c) => c.id === classLevelId) ??
    classLevels.data?.find((c) => c.isActive) ??
    classLevels.data?.[0];
  const subjects = useSetupQuery<SetupSubject[]>(
    classLevel ? `${PATH}?classLevelId=${classLevel.id}` : null,
  );
  const { editing, setEditing, close } = useEditing<SetupSubject>();
  const [deleting, setDeleting] = useState<SetupSubject | null>(null);
  const classLabel = label('class_level', 'Class');

  const toggle = useSetupMutation(
    (s: SetupSubject) =>
      client.api(`${PATH}/${s.id}`, { method: 'PATCH', json: { isActive: !s.isActive } }),
    { success: t('saved') },
  );
  const remove = useSetupMutation(
    (s: SetupSubject) => client.api(`${PATH}/${s.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDeleting(null) },
  );
  const groupName = (id: string | null) => {
    const g = groups.data?.find((x) => x.id === id);
    return g ? displayName(g.nameBn, g.nameEn, locale) : null;
  };

  return (
    <SetupPage tab="subjects">
      <SectionCard
        id="setup-subjects"
        title={t('tabSubjects')}
        hint={t('subjectsHint', { classLevel: label('class_level', 'Class', { inText: true }) })}
        actions={
          classLevel && (
            <Button onClick={() => setEditing('new')} data-testid="add-subject">
              <PlusIcon aria-hidden />
              {t('addSubject')}
            </Button>
          )
        }
      >
        {classLevels.data && (
          <SelectField
            id="subjects-class"
            label={classLabel}
            className="sm:max-w-xs"
            value={classLevel?.id ?? ''}
            onChange={setClassLevelId}
            options={classLevels.data.map((c) => ({
              value: c.id,
              label:
                displayName(c.nameBn, c.nameEn, locale) + (c.isActive ? '' : ` (${t('inactive')})`),
            }))}
          />
        )}
        {classLevels.isPending || (classLevel && subjects.isPending) ? (
          <Skeleton className="h-32" />
        ) : classLevels.isError || subjects.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(classLevels.error ?? subjects.error)}</AlertDescription>
          </Alert>
        ) : !subjects.data || subjects.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noSubjects')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="subject-list">
            {subjects.data.map((s) => {
              const name = displayName(s.nameBn, s.nameEn, locale);
              const group = groupName(s.studyGroupId);
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-words">{name}</span>
                      <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                        {s.code}
                      </span>
                      {s.isOptional && <Badge variant="soft">{t('optional')}</Badge>}
                      <InactiveBadge active={s.isActive} />
                    </span>
                    {group && <span className="text-muted-foreground text-sm">{group}</span>}
                  </span>
                  <RowActions
                    name={name}
                    active={s.isActive}
                    inUse={s.usage.attendance > 0}
                    onEdit={() => setEditing(s)}
                    onToggleActive={() => toggle.mutate(s)}
                    onDelete={() => setDeleting(s)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
      {editing !== null && classLevel && (
        <SubjectDialog
          key={editing === 'new' ? 'new' : editing.id}
          classLevelId={classLevel.id}
          item={editing === 'new' ? null : editing}
          groups={(groups.data ?? []).filter(
            (g) => g.isActive || (editing !== 'new' && g.id === editing.studyGroupId),
          )}
          onClose={close}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('deleteTitle', {
          name: deleting ? displayName(deleting.nameBn, deleting.nameEn, locale) : '',
        })}
        confirmLabel={t('delete')}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </SetupPage>
  );
}

function SubjectDialog({
  classLevelId,
  item,
  groups,
  onClose,
}: {
  classLevelId: string;
  item: SetupSubject | null;
  groups: SetupStudyGroup[];
  onClose: () => void;
}) {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const fieldErrors = useFieldErrors();
  const { client } = useAuth();
  const [code, setCode] = useState(item?.code ?? '');
  const [nameBn, setNameBn] = useState(item?.nameBn ?? '');
  const [nameEn, setNameEn] = useState(item?.nameEn ?? '');
  const [studyGroupId, setGroup] = useState(item?.studyGroupId ?? '');
  const [isOptional, setOptional] = useState(item?.isOptional ?? false);
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? 0));
  const save = useSetupMutation(
    () => {
      const json = {
        code,
        nameBn,
        nameEn,
        studyGroupId: studyGroupId || null,
        isOptional,
        sortOrder: Number(toAsciiDigits(sortOrder)) || 0,
      };
      return item
        ? client.api(`${PATH}/${item.id}`, { method: 'PATCH', json })
        : client.api(PATH, { method: 'POST', json: { ...json, classLevelId } });
    },
    { success: t('saved'), onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        item
          ? t('editTitle', { name: displayName(item.nameBn, item.nameEn, locale) })
          : t('addSubject')
      }
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="subject-dialog"
    >
      <TextField
        id="subject-bn"
        label={t('nameBn')}
        value={nameBn}
        onChange={setNameBn}
        required
        maxLength={80}
        lang="bn"
        error={errors['nameBn']}
      />
      <TextField
        id="subject-en"
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
          id="subject-code"
          label={t('code')}
          value={code}
          onChange={setCode}
          required
          maxLength={30}
          dir="ltr"
          hint={t('codeHintSubject')}
          error={errors['code']}
        />
        <SelectField
          id="subject-group"
          label={label('study_group', 'Group')}
          value={studyGroupId}
          onChange={setGroup}
          placeholder={t('allGroups')}
          options={groups.map((g) => ({
            value: g.id,
            label: displayName(g.nameBn, g.nameEn, locale),
          }))}
        />
      </div>
      <ToggleField
        id="subject-optional"
        checked={isOptional}
        onChange={setOptional}
        label={t('optionalSubject')}
        hint={t('optionalSubjectHint')}
      />
      <TextField
        id="subject-order"
        label={t('sortOrder')}
        value={sortOrder}
        onChange={setSortOrder}
        inputMode="numeric"
        className="sm:max-w-40"
      />
    </FormDialog>
  );
}
