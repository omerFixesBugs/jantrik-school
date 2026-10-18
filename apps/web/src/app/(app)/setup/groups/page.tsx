'use client';

import { formatCount, type SetupStudyGroup } from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { InactiveBadge, SectionCard } from '@/components/form-kit';
import { CodeNameDialog } from '@/components/setup/code-name-dialog';
import {
  ConfirmDialog,
  RowActions,
  SetupPage,
  useEditing,
  useSetupMutation,
  useSetupQuery,
} from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';

const PATH = '/setup/study-groups';

/** Study groups (Science / Business / Humanities), used by subjects and enrolments. */
export default function StudyGroupsPage() {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const groups = useSetupQuery<SetupStudyGroup[]>(PATH);
  const { editing, setEditing, close } = useEditing<SetupStudyGroup>();
  const [deleting, setDeleting] = useState<SetupStudyGroup | null>(null);
  const groupLabel = label('study_group', 'Group');

  const toggle = useSetupMutation(
    (g: SetupStudyGroup) =>
      client.api(`${PATH}/${g.id}`, { method: 'PATCH', json: { isActive: !g.isActive } }),
    { success: t('saved') },
  );
  const remove = useSetupMutation(
    (g: SetupStudyGroup) => client.api(`${PATH}/${g.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDeleting(null) },
  );

  return (
    <SetupPage tab="groups">
      <SectionCard
        id="setup-groups"
        title={groupLabel}
        hint={t('groupsHint')}
        actions={
          <Button onClick={() => setEditing('new')} data-testid="add-group">
            <PlusIcon aria-hidden />
            {t('addNamed', { name: groupLabel })}
          </Button>
        }
      >
        {groups.isPending ? (
          <Skeleton className="h-24" />
        ) : groups.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(groups.error)}</AlertDescription>
          </Alert>
        ) : groups.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noGroups')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="group-list">
            {groups.data.map((g) => {
              const name = displayName(g.nameBn, g.nameEn, locale);
              return (
                <li key={g.id} className="flex items-center gap-3 px-3 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-words">{name}</span>
                      <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                        {g.code}
                      </span>
                      <InactiveBadge active={g.isActive} />
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {t('groupUsage', {
                        subjects: formatCount(g.usage.subjects, locale),
                        students: formatCount(g.usage.enrolments, locale),
                        ns: g.usage.subjects,
                        nst: g.usage.enrolments,
                      })}
                    </span>
                  </span>
                  <RowActions
                    name={name}
                    active={g.isActive}
                    inUse={g.usage.subjects + g.usage.enrolments > 0}
                    onEdit={() => setEditing(g)}
                    onToggleActive={() => toggle.mutate(g)}
                    onDelete={() => setDeleting(g)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
      {editing !== null && (
        <CodeNameDialog
          key={editing === 'new' ? 'new' : editing.id}
          path={PATH}
          item={editing === 'new' ? null : editing}
          title={
            editing === 'new'
              ? t('addNamed', { name: groupLabel })
              : t('editTitle', { name: displayName(editing.nameBn, editing.nameEn, locale) })
          }
          codeHint={t('codeHintGroup')}
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
