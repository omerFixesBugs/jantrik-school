'use client';

import {
  formatCount,
  formatIdentifier,
  formatTaka,
  type FeeFamilyMember,
  type FeeSettingsView,
  type FeeSiblingsView,
  type FeeStudentHit,
} from '@jantrik/shared';
import {
  CheckIcon,
  PhoneIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  UsersRoundIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard, TextField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { cn } from '@/lib/utils';
import { RecalculateStudentsDialog } from './dues-actions';
import {
  EmptyState,
  FeeDialog,
  LoadError,
  localDigits,
  useFeeMutation,
  useFeeQuery,
  useOrdinal,
} from './kit';
import { StudentPicker } from './student-picker';

type Family = FeeSiblingsView['families'][number];
type Suggestion = FeeSiblingsView['suggestions'][number];
type Recalc = { studentIds: string[] } | null;

const nameOf = (
  locale: Locale,
  s: { nameBn: string | null; nameEn: string | null; studentCode: string },
) => pick(locale, s) || formatIdentifier(s.studentCode);

/**
 * Siblings: students who share a guardian phone are only suggested (guardians often give a
 * relative's phone); the discount applies to families an admin confirmed. After a change, offer
 * to recalculate those students' unpaid dues.
 */
export function SiblingsSection() {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const view = useFeeQuery<FeeSiblingsView>('/fees/siblings');
  const settings = useFeeQuery<FeeSettingsView>('/fees/settings');
  const ordinal = useOrdinal();
  const [recalc, setRecalc] = useState<Recalc>(null);
  const [building, setBuilding] = useState(false);
  const rule = settings.data?.sibling ?? null;
  const familyOf = (studentId: string) =>
    view.data?.families.find((f) => f.members.some((m) => m.id === studentId)) ?? null;
  /** The students whose dues a change touches: those named, and everyone in their family. */
  const touched = (ids: string[]) => {
    const all = new Set(ids);
    for (const id of ids) for (const m of familyOf(id)?.members ?? []) all.add(m.id);
    return [...all];
  };

  return (
    <>
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
        {settings.isSuccess && (
          <p className="text-sm" data-testid="fee-sibling-rule">
            {rule ? (
              <>
                <Pill tone="success">
                  <CheckIcon aria-hidden className="size-3.5" />
                  {t('ruleOn')}
                </Pill>{' '}
                {rule.type === 'PERCENT'
                  ? t('rulePercent', {
                      from: ordinal(rule.fromChild),
                      value: localDigits(String(rule.value), locale),
                    })
                  : t('ruleFixed', {
                      from: ordinal(rule.fromChild),
                      amount: formatTaka(rule.value, locale),
                    })}
              </>
            ) : (
              <>
                <Pill>
                  <XIcon aria-hidden className="size-3.5" />
                  {t('ruleOff')}
                </Pill>{' '}
                <Link href="/fees/setup" className="text-link underline-offset-4 hover:underline">
                  {t('ruleOffLink')}
                </Link>
              </>
            )}
          </p>
        )}
      </header>

      {view.isPending ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : view.isError ? (
        <LoadError error={view.error} onRetry={() => void view.refetch()} />
      ) : (
        <>
          <SectionCard
            id="fees-sibling-suggestions"
            title={t('suggestionsTitle', {
              count: view.data.suggestions.length,
              n: formatCount(view.data.suggestions.length, locale),
            })}
            hint={t('suggestionsHint')}
          >
            {view.data.suggestions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('suggestionsNone')}</p>
            ) : (
              <ul className="grid gap-3 xl:grid-cols-2">
                {view.data.suggestions.map((s, i) => (
                  <SuggestionCard
                    key={`${s.phoneMasked}-${i}`}
                    suggestion={s}
                    inFamily={(id) => familyOf(id) !== null}
                    onConfirmed={(ids) => setRecalc({ studentIds: touched(ids) })}
                  />
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            id="fees-sibling-families"
            title={t('familiesTitle', {
              count: view.data.families.length,
              n: formatCount(view.data.families.length, locale),
            })}
            hint={t('familiesHint')}
            actions={
              <Button
                variant="outline"
                onClick={() => setBuilding(true)}
                data-testid="sibling-new-family"
              >
                <UserPlusIcon aria-hidden />
                {t('newFamily')}
              </Button>
            }
          >
            {view.data.families.length === 0 ? (
              <EmptyState
                icon={UsersRoundIcon}
                title={t('familiesNone')}
                text={t('familiesNoneText')}
              />
            ) : (
              <ul className="grid gap-3 xl:grid-cols-2">
                {view.data.families.map((f) => (
                  <FamilyCard
                    key={f.groupId}
                    family={f}
                    fromChild={rule?.fromChild ?? null}
                    onChanged={(ids) => setRecalc({ studentIds: ids })}
                  />
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}

      {building && (
        <NewFamilyDialog
          onClose={() => setBuilding(false)}
          onDone={(ids) => {
            setBuilding(false);
            setRecalc({ studentIds: touched(ids) });
          }}
        />
      )}
      {recalc && (
        <RecalculateStudentsDialog
          studentIds={recalc.studentIds}
          title={t('recalcTitle', {
            count: recalc.studentIds.length,
            n: formatCount(recalc.studentIds.length, locale),
          })}
          onClose={() => setRecalc(null)}
        />
      )}
    </>
  );
}

function SuggestionCard({
  suggestion: s,
  inFamily,
  onConfirmed,
}: {
  suggestion: Suggestion;
  inFamily: (id: string) => boolean;
  onConfirmed: (ids: string[]) => void;
}) {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [chosen, setChosen] = useState<string[]>(s.students.map((x) => x.id));
  const confirm = useFeeMutation(
    () => client.api('/fees/siblings', { method: 'POST', json: { studentIds: chosen } }),
    { success: t('confirmed'), onSuccess: () => onConfirmed(chosen) },
  );
  return (
    <li
      className="bg-card flex min-w-0 flex-col gap-3 rounded-xl border border-dashed p-3"
      data-testid="sibling-suggestion"
    >
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium">{t('suggestionLabel')}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold wrap-break-word">
            {s.guardianName ?? t('guardianUnnamed')}
          </span>
          <span className="text-muted-foreground inline-flex items-center gap-1 text-sm" dir="ltr">
            <PhoneIcon aria-hidden className="size-3.5" />
            {s.phoneMasked}
          </span>
        </span>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="sr-only">{t('chooseSiblings')}</legend>
        {s.students.map((st) => {
          const on = chosen.includes(st.id);
          return (
            <label
              key={st.id}
              className={cn(
                'flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-lg border px-3 py-1.5',
                'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-3',
                on ? 'border-primary-ink bg-primary-soft' : 'bg-card',
              )}
            >
              <input
                type="checkbox"
                className="accent-primary size-4 shrink-0"
                checked={on}
                onChange={(e) =>
                  setChosen((x) =>
                    e.target.checked ? [...x, st.id] : x.filter((y) => y !== st.id),
                  )
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium wrap-break-word">{nameOf(locale, st)}</span>
                <span className="text-muted-foreground text-sm">
                  <span dir="ltr">{formatIdentifier(st.studentCode)}</span>
                  {st.classLevel && <> · {pick(locale, st.classLevel)}</>}
                </span>
              </span>
              {inFamily(st.id) && <Pill tone="info">{t('alreadyFamily')}</Pill>}
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => confirm.mutate(undefined)}
          disabled={chosen.length < 2 || confirm.isPending}
          data-testid="sibling-confirm"
        >
          <CheckIcon aria-hidden />
          {t('confirm')}
        </Button>
        {chosen.length < 2 && <span className="text-muted-foreground text-sm">{t('pickTwo')}</span>}
      </div>
    </li>
  );
}

function FamilyCard({
  family,
  fromChild,
  onChanged,
}: {
  family: Family;
  fromChild: number | null;
  onChanged: (studentIds: string[]) => void;
}) {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const ordinal = useOrdinal();
  const [removing, setRemoving] = useState<FeeFamilyMember | null>(null);
  const [adding, setAdding] = useState(false);
  const members = [...family.members].sort((a, b) => a.rank - b.rank);
  const ids = members.map((m) => m.id);
  return (
    <li
      className="bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-3"
      data-testid="sibling-family"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <UsersIcon aria-hidden className="text-primary-ink size-4" />
          {t('familyOf', { count: members.length, n: formatCount(members.length, locale) })}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          <UserPlusIcon aria-hidden />
          {t('addMember')}
        </Button>
      </div>
      <ol className="flex flex-col gap-1.5">
        {members.map((m) => {
          const discounted = fromChild !== null && m.rank >= fromChild;
          return (
            <li
              key={m.id}
              className="flex min-w-0 items-center gap-3 rounded-lg border px-3 py-1.5"
              data-testid="sibling-member"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium wrap-break-word">{nameOf(locale, m)}</span>
                <span className="text-muted-foreground text-sm">
                  <span dir="ltr">{formatIdentifier(m.studentCode)}</span>
                  {m.classLevel && <> · {pick(locale, m.classLevel)}</>}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  <Pill tone="accent">
                    {t('rank', { ordinal: ordinal(m.rank), n: formatCount(m.rank, locale) })}
                  </Pill>
                  {fromChild !== null &&
                    (discounted ? (
                      <Pill tone="success">{t('getsDiscount')}</Pill>
                    ) : (
                      <Pill>{t('paysFull')}</Pill>
                    ))}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('remove', { name: nameOf(locale, m) })}
                onClick={() => setRemoving(m)}
                data-testid="sibling-remove"
              >
                <UserMinusIcon aria-hidden />
              </Button>
            </li>
          );
        })}
      </ol>
      {removing && (
        <RemoveMemberDialog
          groupId={family.groupId}
          member={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            onChanged(ids);
          }}
        />
      )}
      {adding && (
        <AddMemberDialog
          family={family}
          onClose={() => setAdding(false)}
          onDone={(added) => {
            setAdding(false);
            onChanged([...ids, added]);
          }}
        />
      )}
    </li>
  );
}

function RemoveMemberDialog({
  groupId,
  member,
  onClose,
  onDone,
}: {
  groupId: string;
  member: FeeFamilyMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const error = reason.trim().length < 3 ? t('errorReason') : null;
  const remove = useFeeMutation(
    () =>
      client.api(`/fees/siblings/${groupId}/members/${member.id}/remove`, {
        method: 'POST',
        json: { reason: reason.trim() },
      }),
    { success: t('removed'), onSuccess: onDone },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('removeTitle', { name: nameOf(locale, member) })}
      description={t('removeHint')}
      submitLabel={t('removeSubmit')}
      destructive
      pending={remove.isPending}
      onSubmit={() => {
        setTried(true);
        if (!error) remove.mutate(undefined);
      }}
      testId="sibling-remove-dialog"
      submitTestId="sibling-remove-confirm"
    >
      <TextField
        id="sibling-remove-reason"
        label={t('reason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        required
        error={tried ? error : null}
      />
    </FeeDialog>
  );
}

/** Join one more student to a confirmed family (POST with a member of it). */
function AddMemberDialog({
  family,
  onClose,
  onDone,
}: {
  family: Family;
  onClose: () => void;
  onDone: (studentId: string) => void;
}) {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [student, setStudent] = useState<FeeStudentHit | null>(null);
  const inFamily = student ? family.members.some((m) => m.id === student.id) : false;
  const add = useFeeMutation(
    () =>
      client.api('/fees/siblings', {
        method: 'POST',
        json: { studentIds: [family.members[0]!.id, student!.id] },
      }),
    { success: t('confirmed'), onSuccess: () => onDone(student!.id) },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('addMemberTitle')}
      description={t('addMemberHint', {
        names: family.members.map((m) => nameOf(locale, m)).join(', '),
      })}
      submitLabel={t('addMemberSubmit')}
      pending={add.isPending || !student || inFamily}
      onSubmit={() => student && !inFamily && add.mutate(undefined)}
      testId="sibling-add-member-dialog"
      wide
    >
      <StudentPicker
        id="sibling-add-search"
        label={t('search')}
        chosen={student ? [student.id] : []}
        onPick={setStudent}
      />
      {inFamily && <p className="text-destructive text-sm">{t('alreadyInThis')}</p>}
    </FeeDialog>
  );
}

/** A family the phones did not suggest (guardians gave different numbers). */
function NewFamilyDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (ids: string[]) => void;
}) {
  const t = useTranslations('fees.setup.siblings');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [chosen, setChosen] = useState<FeeStudentHit[]>([]);
  const ids = chosen.map((s) => s.id);
  const save = useFeeMutation(
    () => client.api('/fees/siblings', { method: 'POST', json: { studentIds: ids } }),
    { success: t('confirmed'), onSuccess: () => onDone(ids) },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('newFamilyTitle')}
      description={t('newFamilyHint')}
      submitLabel={t('confirm')}
      pending={save.isPending || chosen.length < 2}
      onSubmit={() => chosen.length >= 2 && save.mutate(undefined)}
      testId="sibling-new-family-dialog"
      wide
    >
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('chosen')}>
          {chosen.map((s) => (
            <li key={s.id}>
              <span className="bg-primary-soft text-accent-foreground inline-flex min-h-(--control-h-sm) items-center gap-1 rounded-full ps-3 text-sm font-medium">
                {nameOf(locale, s)}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label={t('unchoose', { name: nameOf(locale, s) })}
                  onClick={() => setChosen((x) => x.filter((y) => y.id !== s.id))}
                >
                  <XIcon aria-hidden />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <StudentPicker
        id="sibling-new-search"
        label={t('search')}
        chosen={ids}
        onPick={(hit) =>
          setChosen((x) =>
            x.some((y) => y.id === hit.id)
              ? x.filter((y) => y.id !== hit.id)
              : x.length >= 10
                ? x
                : [...x, hit],
          )
        }
      />
      {chosen.length < 2 && <p className="text-muted-foreground text-sm">{t('pickTwo')}</p>}
    </FeeDialog>
  );
}
