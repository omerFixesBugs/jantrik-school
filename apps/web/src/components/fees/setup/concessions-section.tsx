'use client';

import {
  FEE_CONCESSION_CATEGORIES,
  formatDate,
  formatIdentifier,
  formatTaka,
  type FeeAmountType,
  type FeeConcessionCategory,
  type FeeConcessionInput,
  type FeeConcessionView,
  type FeeHeadView,
  type FeeStudentHit,
} from '@jantrik/shared';
import {
  BadgePercentIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  ClockIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChoiceChip, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { MoneyField } from '@/components/fees/money-field';
import { Pill } from '@/components/kit/pill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { RecalculateStudentsDialog } from './dues-actions';
import {
  EmptyState,
  FeeDialog,
  fieldsFromError,
  LoadError,
  localDigits,
  parseWhole,
  useFeeMutation,
  useFeeQuery,
} from './kit';
import { StudentPicker, useStudentPlace } from './student-picker';

const REASON_MAX = 500;

/** "৫০%" or "৳৫০০". */
export function useConcessionValue() {
  const locale = useLocale() as Locale;
  return (c: { type: FeeAmountType; value: number }) =>
    c.type === 'PERCENT' ? `${localDigits(String(c.value), locale)}%` : formatTaka(c.value, locale);
}

type Recalc = { studentIds: string[]; name: string } | null;

/** Concessions: find a student, give one (per head, from a date), end one with a reason. */
export function ConcessionsSection() {
  const t = useTranslations('fees.setup.concessions');
  const { data: context } = useMeContext();
  const yearId = context?.academicYear?.id ?? null;
  const [student, setStudent] = useState<FeeStudentHit | null>(null);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<FeeConcessionView | null>(null);
  const [recalc, setRecalc] = useState<Recalc>(null);
  const locale = useLocale() as Locale;
  const place = useStudentPlace();
  const concessions = useFeeQuery<FeeConcessionView[]>(
    yearId
      ? `/fees/concessions?academicYearId=${yearId}${student ? `&studentId=${student.id}` : ''}`
      : null,
  );
  const today = context?.today ?? '';
  const list = [...(concessions.data ?? [])].sort(
    (a, b) =>
      Number(a.endedOn !== null) - Number(b.endedOn !== null) ||
      b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <>
      <SectionCard id="fees-concessions-find" title={t('findTitle')} hint={t('findHint')}>
        {student ? (
          <div
            className="bg-primary-soft flex flex-wrap items-center gap-3 rounded-xl p-3"
            data-testid="fee-concession-student"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold wrap-break-word">
                {pick(locale, student) || formatIdentifier(student.studentCode)}
              </span>
              <span className="text-muted-foreground text-sm">
                <span dir="ltr">{formatIdentifier(student.studentCode)}</span> · {place(student)}
              </span>
            </div>
            <Button onClick={() => setAdding(true)} data-testid="fee-concession-add">
              <PlusIcon aria-hidden />
              {t('add')}
            </Button>
            <Button variant="outline" onClick={() => setStudent(null)}>
              <XIcon aria-hidden />
              {t('otherStudent')}
            </Button>
          </div>
        ) : (
          <StudentPicker id="fees-concession-search" label={t('search')} onPick={setStudent} />
        )}
      </SectionCard>

      <SectionCard
        id="fees-concessions"
        title={
          student
            ? t('studentListTitle', { name: pick(locale, student) || student.studentCode })
            : t('listTitle', { year: context?.academicYear?.name ?? '' })
        }
        hint={student ? undefined : t('listHint')}
      >
        {!yearId ? (
          <p className="text-muted-foreground text-sm">{t('noYear')}</p>
        ) : concessions.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : concessions.isError ? (
          <LoadError error={concessions.error} onRetry={() => void concessions.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={BadgePercentIcon}
            title={student ? t('emptyStudent') : t('emptyTitle')}
            text={student ? undefined : t('emptyText')}
            action={
              student ? (
                <Button onClick={() => setAdding(true)}>
                  <PlusIcon aria-hidden />
                  {t('add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="fee-concessions">
            {list.map((c) => (
              <ConcessionRow
                key={c.id}
                concession={c}
                today={today}
                showStudent={!student}
                onEnd={() => setEnding(c)}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {adding && student && (
        <AddConcessionDialog
          student={student}
          today={today}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            setRecalc({
              studentIds: [student.id],
              name: pick(locale, student) || student.studentCode,
            });
          }}
        />
      )}
      {ending && (
        <EndConcessionDialog
          concession={ending}
          today={today}
          onClose={() => setEnding(null)}
          onDone={() => {
            setEnding(null);
            setRecalc({
              studentIds: [ending.student.id],
              name: pick(locale, ending.student) || ending.student.studentCode,
            });
          }}
        />
      )}
      {recalc && (
        <RecalculateStudentsDialog
          studentIds={recalc.studentIds}
          title={t('recalcTitle', { name: recalc.name })}
          onClose={() => setRecalc(null)}
        />
      )}
    </>
  );
}

function ConcessionRow({
  concession: c,
  today,
  showStudent,
  onEnd,
}: {
  concession: FeeConcessionView;
  today: string;
  showStudent: boolean;
  onEnd: () => void;
}) {
  const t = useTranslations('fees.setup.concessions');
  const locale = useLocale() as Locale;
  const value = useConcessionValue();
  const ended = c.endedOn !== null;
  const upcoming = !ended && today !== '' && c.validFrom > today;
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-start',
        ended && 'bg-muted',
      )}
      data-testid="fee-concession-row"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {showStudent && (
          <span className="font-semibold wrap-break-word">
            {pick(locale, c.student) || formatIdentifier(c.student.studentCode)}{' '}
            <span className="text-muted-foreground text-sm font-normal" dir="ltr">
              {formatIdentifier(c.student.studentCode)}
            </span>
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(!showStudent && 'font-semibold')}>{pick(locale, c.feeHead)}</span>
          <span className="font-numeric font-semibold">{value(c)}</span>
          <Pill tone="accent">{t(`category.${c.category}`)}</Pill>
          {ended ? (
            <Pill>
              <CircleSlashIcon aria-hidden className="size-3.5" />
              {t('statusEnded')}
            </Pill>
          ) : upcoming ? (
            <Pill tone="info">
              <ClockIcon aria-hidden className="size-3.5" />
              {t('statusUpcoming')}
            </Pill>
          ) : (
            <Pill tone="success">
              <CircleCheckIcon aria-hidden className="size-3.5" />
              {t('statusActive')}
            </Pill>
          )}
        </span>
        <span className="text-muted-foreground text-sm">
          {ended
            ? t('period', {
                from: formatDate(c.validFrom, locale),
                to: formatDate(c.endedOn!, locale),
              })
            : t('from', { date: formatDate(c.validFrom, locale) })}
          {c.reason && <> · {c.reason}</>}
        </span>
        {ended && c.endedReason && (
          <span className="text-muted-foreground text-sm">
            {t('endedReason', { reason: c.endedReason })}
          </span>
        )}
      </div>
      {!ended && (
        <Button
          variant="outline"
          onClick={onEnd}
          className="self-start"
          data-testid="fee-concession-end"
        >
          {t('end')}
        </Button>
      )}
    </li>
  );
}

function AddConcessionDialog({
  student,
  today,
  onClose,
  onDone,
}: {
  student: FeeStudentHit;
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('fees.setup.concessions');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const heads = useFeeQuery<FeeHeadView[]>('/fees/heads');
  const active = (heads.data ?? []).filter((h) => h.isActive);
  const [headId, setHeadId] = useState('');
  const [category, setCategory] = useState<FeeConcessionCategory>('GENERAL');
  const [type, setType] = useState<FeeAmountType>('PERCENT');
  const [percentText, setPercentText] = useState('');
  const [fixed, setFixed] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Set<string>>(new Set());
  const free = category === 'FREE_FULL' || category === 'FREE_HALF';
  const percent = parseWhole(percentText);

  const errors: Partial<Record<string, string>> = {};
  if (!headId) errors.feeHeadId = t('errorHead');
  if (!free && type === 'PERCENT' && (percent === null || percent < 1 || percent > 100))
    errors.value = t('errorPercent');
  if (!free && type === 'FIXED' && (fixed ?? 0) < 1) errors.value = t('errorFixed');
  if (category === 'SCHOLARSHIP' && reason.trim().length < 3) errors.reason = t('errorReason');
  if (reason.trim().length > REASON_MAX) errors.reason = t('errorReasonLong');
  if (!validFrom) errors.validFrom = t('errorDate');
  for (const f of server) errors[f] ??= t('errorField');
  const shown = (k: string) => (tried ? (errors[k] ?? null) : null);

  const save = useFeeMutation(
    (body: FeeConcessionInput) =>
      client.api<FeeConcessionView>('/fees/concessions', { method: 'POST', json: body }),
    { success: t('added'), onSuccess: onDone, onError: (e) => setServer(fieldsFromError(e)) },
  );

  return (
    <FeeDialog
      onClose={onClose}
      title={t('addTitle', { name: pick(locale, student) || student.studentCode })}
      description={t('addHint')}
      submitLabel={t('addSubmit')}
      pending={save.isPending}
      onSubmit={() => {
        setTried(true);
        if (Object.keys(errors).length > 0) return;
        save.mutate({
          studentId: student.id,
          feeHeadId: headId,
          category,
          ...(free ? {} : { type, value: type === 'PERCENT' ? percent! : fixed! }),
          reason: reason.trim() || null,
          validFrom,
        });
      }}
      testId="fee-concession-dialog"
      submitTestId="fee-concession-save"
      wide
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <SelectField
          id="concession-head"
          label={t('head')}
          value={headId}
          onChange={(v) => {
            setHeadId(v);
            setServer(new Set());
          }}
          placeholder={heads.isPending ? t('loadingHeads') : t('chooseHead')}
          options={active.map((h) => ({ value: h.id, label: pick(locale, h) }))}
          required
          error={shown('feeHeadId')}
        />
        <TextField
          id="concession-from"
          type="date"
          label={t('validFrom')}
          hint={t('validFromHint')}
          value={validFrom}
          onChange={setValidFrom}
          required
          error={shown('validFrom')}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t('categoryLabel')}</legend>
        <div className="flex flex-wrap gap-2">
          {FEE_CONCESSION_CATEGORIES.map((c) => (
            <ChoiceChip
              key={c}
              type="radio"
              name="concession-category"
              checked={category === c}
              onChange={() => setCategory(c)}
            >
              {t(`category.${c}`)}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      {free ? (
        <p className="bg-muted rounded-xl p-3 text-sm">
          {category === 'FREE_FULL' ? t('freeFullNote') : t('freeHalfNote')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t('typeLabel')}</legend>
            <div className="flex flex-wrap gap-2">
              <ChoiceChip
                type="radio"
                name="concession-type"
                checked={type === 'PERCENT'}
                onChange={() => setType('PERCENT')}
              >
                {t('typePercent')}
              </ChoiceChip>
              <ChoiceChip
                type="radio"
                name="concession-type"
                checked={type === 'FIXED'}
                onChange={() => setType('FIXED')}
              >
                {t('typeFixed')}
              </ChoiceChip>
            </div>
          </fieldset>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {type === 'PERCENT' ? (
              <TextField
                id="concession-percent"
                label={t('percentLabel')}
                value={percentText}
                onChange={setPercentText}
                inputMode="numeric"
                autoComplete="off"
                className="tabular-nums"
                error={shown('value')}
                data-testid="fee-concession-percent"
              />
            ) : (
              <MoneyField
                id="concession-fixed"
                label={t('fixedLabel')}
                hint={t('fixedHint')}
                valuePaisa={fixed}
                onChange={setFixed}
                error={shown('value')}
                testId="fee-concession-fixed"
              />
            )}
          </div>
        </div>
      )}
      <TextField
        id="concession-reason"
        label={category === 'SCHOLARSHIP' ? t('reasonScholarship') : t('reason')}
        hint={category === 'SCHOLARSHIP' ? t('reasonScholarshipHint') : t('reasonHint')}
        value={reason}
        onChange={setReason}
        maxLength={REASON_MAX + 20}
        required={category === 'SCHOLARSHIP'}
        error={shown('reason')}
      />
    </FeeDialog>
  );
}

function EndConcessionDialog({
  concession: c,
  today,
  onClose,
  onDone,
}: {
  concession: FeeConcessionView;
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('fees.setup.concessions');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const value = useConcessionValue();
  const [endedOn, setEndedOn] = useState(today < c.validFrom ? c.validFrom : today);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const errors: Partial<Record<string, string>> = {};
  if (!endedOn) errors.endedOn = t('errorDate');
  else if (endedOn < c.validFrom) errors.endedOn = t('errorEndBeforeStart');
  if (reason.trim().length < 3) errors.reason = t('errorReason');
  const shown = (k: string) => (tried ? (errors[k] ?? null) : null);
  const save = useFeeMutation(
    () =>
      client.api<FeeConcessionView>(`/fees/concessions/${c.id}/end`, {
        method: 'POST',
        json: { endedOn, reason: reason.trim() },
      }),
    { success: t('ended'), onSuccess: onDone },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('endTitle', {
        name: pick(locale, c.student) || c.student.studentCode,
        head: pick(locale, c.feeHead),
      })}
      description={t('endHint', { value: value(c) })}
      submitLabel={t('end')}
      destructive
      pending={save.isPending}
      onSubmit={() => {
        setTried(true);
        if (Object.keys(errors).length === 0) save.mutate(undefined);
      }}
      testId="fee-concession-end-dialog"
      submitTestId="fee-concession-end-confirm"
    >
      <TextField
        id="concession-ended-on"
        type="date"
        label={t('endedOn')}
        hint={t('endedOnHint')}
        value={endedOn}
        onChange={setEndedOn}
        min={c.validFrom}
        required
        error={shown('endedOn')}
      />
      <TextField
        id="concession-end-reason"
        label={t('endReason')}
        value={reason}
        onChange={setReason}
        maxLength={REASON_MAX}
        required
        error={shown('reason')}
      />
    </FeeDialog>
  );
}
