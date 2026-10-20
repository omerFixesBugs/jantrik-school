'use client';

import {
  formatCount,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupSection,
  type SetupShift,
} from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { InactiveBadge, SectionCard, SelectField } from '@/components/form-kit';
import { CodeNameDialog } from '@/components/setup/code-name-dialog';
import {
  ConfirmDialog,
  RowActions,
  SetupPage,
  useSetupMutation,
  useSetupQuery,
} from '@/components/setup/setup-kit';
import { SectionDialog } from '@/components/setup/section-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

type Dialog =
  | { kind: 'class'; item: SetupClassLevel | null }
  | { kind: 'section'; classLevel: SetupClassLevel; item: SetupSection | null }
  | { kind: 'delete-class'; item: SetupClassLevel }
  | { kind: 'delete-section'; item: SetupSection; name: string }
  | null;

/** Class levels, and their sections in the chosen academic year. */
export default function ClassesPage() {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const years = useSetupQuery<SetupAcademicYear[]>('/setup/academic-years');
  const classLevels = useSetupQuery<SetupClassLevel[]>('/setup/class-levels');
  const shifts = useSetupQuery<SetupShift[]>('/setup/shifts');
  const [yearId, setYearId] = useState<string | null>(null);
  const year =
    years.data?.find((y) => y.id === yearId) ??
    years.data?.find((y) => y.isCurrent) ??
    years.data?.[0];
  const sections = useSetupQuery<SetupSection[]>(
    year ? `/setup/sections?academicYearId=${year.id}` : null,
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');
  const sectionInText = label('section', 'Section', { inText: true });

  const toggleClass = useSetupMutation(
    (c: SetupClassLevel) =>
      client.api(`/setup/class-levels/${c.id}`, {
        method: 'PATCH',
        json: { isActive: !c.isActive },
      }),
    { success: t('saved') },
  );
  const toggleSection = useSetupMutation(
    (s: SetupSection) =>
      client.api(`/setup/sections/${s.id}`, { method: 'PATCH', json: { isActive: !s.isActive } }),
    { success: t('saved') },
  );
  const removeClass = useSetupMutation(
    (c: SetupClassLevel) => client.api(`/setup/class-levels/${c.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDialog(null) },
  );
  const removeSection = useSetupMutation(
    (s: SetupSection) => client.api(`/setup/sections/${s.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDialog(null) },
  );

  const shiftName = (id: string | null) => {
    const s = shifts.data?.find((x) => x.id === id);
    return s ? displayName(s.nameBn, s.nameEn, locale) : null;
  };
  const error = years.error ?? classLevels.error;

  return (
    <SetupPage tab="classes">
      <SectionCard
        id="setup-classes"
        title={t('tabClasses', { classLevel: classLabel, section: sectionInText })}
        hint={t('classesHint', { section: sectionInText })}
        actions={
          <Button onClick={() => setDialog({ kind: 'class', item: null })} data-testid="add-class">
            <PlusIcon aria-hidden />
            {t('addNamed', { name: classLabel })}
          </Button>
        }
      >
        {years.data && years.data.length > 1 && (
          <SelectField
            id="classes-year"
            label={label('academic_year', 'Academic Year')}
            className="sm:max-w-xs"
            value={year?.id ?? ''}
            onChange={setYearId}
            options={years.data.map((y) => ({
              value: y.id,
              label: y.isCurrent ? `${y.name} (${t('current')})` : y.name,
            }))}
          />
        )}
        {years.isPending || classLevels.isPending ? (
          <Skeleton className="h-48" />
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(error)}</AlertDescription>
          </Alert>
        ) : !year ? (
          <p className="text-muted-foreground text-sm">{t('noYearYet')}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="class-list">
            {classLevels.data!.map((c) => {
              const name = displayName(c.nameBn, c.nameEn, locale);
              const mine = (sections.data ?? []).filter((s) => s.classLevelId === c.id);
              return (
                <li
                  key={c.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border p-3',
                    !c.isActive && 'bg-muted/40',
                  )}
                  data-testid="class-row"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <span className="font-semibold break-words">{name}</span>
                      <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                        {c.code}
                      </span>
                      <InactiveBadge active={c.isActive} />
                    </span>
                    {c.isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ kind: 'section', classLevel: c, item: null })}
                      >
                        <PlusIcon aria-hidden />
                        {sectionLabel}
                      </Button>
                    )}
                    <RowActions
                      name={name}
                      active={c.isActive}
                      inUse={c.usage.sections + c.usage.subjects + c.usage.enrolments > 0}
                      onEdit={() => setDialog({ kind: 'class', item: c })}
                      onToggleActive={() => toggleClass.mutate(c)}
                      onDelete={() => setDialog({ kind: 'delete-class', item: c })}
                    />
                  </div>
                  {mine.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      {t('noSections', { section: sectionInText })}
                    </p>
                  ) : (
                    <ul className="flex flex-col divide-y rounded-md border">
                      {mine.map((s) => {
                        const shift = shiftName(s.shiftId);
                        const sectionName = `${name}, ${s.name}`;
                        return (
                          <li
                            key={s.id}
                            className="flex items-center gap-2 px-3 py-2"
                            data-testid="section-row"
                          >
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium break-words">{s.name}</span>
                                <InactiveBadge active={s.isActive} />
                              </span>
                              <span className="text-muted-foreground text-sm break-words">
                                {[
                                  t('studentsCount', {
                                    count: formatCount(s.usage.enrolments, locale),
                                    n: s.usage.enrolments,
                                  }),
                                  s.capacity !== null
                                    ? t('capacityOf', { count: formatCount(s.capacity, locale) })
                                    : null,
                                  shift,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <RowActions
                              name={sectionName}
                              active={s.isActive}
                              inUse={s.usage.enrolments + s.usage.attendance + s.usage.teachers > 0}
                              onEdit={() => setDialog({ kind: 'section', classLevel: c, item: s })}
                              onToggleActive={() => toggleSection.mutate(s)}
                              onDelete={() =>
                                setDialog({ kind: 'delete-section', item: s, name: sectionName })
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {dialog?.kind === 'class' && (
        <CodeNameDialog
          path="/setup/class-levels"
          item={dialog.item}
          title={
            dialog.item
              ? t('editTitle', {
                  name: displayName(dialog.item.nameBn, dialog.item.nameEn, locale),
                })
              : t('addNamed', { name: classLabel })
          }
          codeHint={t('codeHintClass')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'section' && year && (
        <SectionDialog
          yearId={year.id}
          classLevel={dialog.classLevel}
          item={dialog.item}
          shifts={(shifts.data ?? []).filter((s) => s.isActive || s.id === dialog.item?.shiftId)}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'delete-class'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'delete-class'
            ? t('deleteTitle', {
                name: displayName(dialog.item.nameBn, dialog.item.nameEn, locale),
              })
            : ''
        }
        confirmLabel={t('delete')}
        pending={removeClass.isPending}
        onConfirm={() => dialog?.kind === 'delete-class' && removeClass.mutate(dialog.item)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete-section'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.kind === 'delete-section' ? t('deleteTitle', { name: dialog.name }) : ''}
        confirmLabel={t('delete')}
        pending={removeSection.isPending}
        onConfirm={() => dialog?.kind === 'delete-section' && removeSection.mutate(dialog.item)}
      />
    </SetupPage>
  );
}
