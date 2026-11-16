'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLOOD_GROUP_LABEL,
  dateToDb,
  formatBdPhone,
  formatDate,
  formatIdentifier,
  LEAVE_STATUSES,
  type LeaveStatus,
  type SetupClassLevel,
  type SetupSection,
  type SetupStudyGroup,
  type StudentProfile,
} from '@jantrik/shared';
import {
  ArrowLeftRightIcon,
  CalendarCheckIcon,
  CameraIcon,
  DoorOpenIcon,
  KeyRoundIcon,
  LockIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  PowerOffIcon,
  RotateCcwIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SectionCard, SelectField, TextField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { StudentAvatar } from '@/components/student-photo';
import { PhotoDialog } from '@/components/students/photo-dialog';
import { ConfirmDialog, FormDialog } from '@/components/setup/setup-kit';
import {
  BoardFields,
  GuardianFields,
  StudentFields,
  guardianPayload,
  newGuardian,
  studentFromProfile,
  studentPayload,
  useGuardianProblems,
  useServerFieldErrors,
  useStudentProblems,
  type GuardianFormValues,
} from '@/components/students/student-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';

type Dialog =
  | 'edit'
  | 'transfer'
  | 'guardian'
  | 'deactivate'
  | 'leave'
  | 'return'
  | { placement: string }
  | 'photo'
  | { removeLink: string; name: string }
  | null;

export default function StudentProfilePage() {
  return (
    <PageGate page="students">
      <Profile />
    </PageGate>
  );
}

function useStudentMutation<I>(
  id: string,
  fn: (input: I) => Promise<StudentProfile>,
  done?: () => void,
) {
  const t = useTranslations('profile');
  const describe = useErrorMessage();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (p) => {
      queryClient.setQueryData(['student', session?.tenant?.id, id], p);
      for (const key of ['students', 'students-total', 'students-summary', 'setup'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      toast.success(t('saved'));
      done?.();
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const known: Record<string, string> = {
          PRIMARY_REQUIRED: t('errorPrimaryRequired'),
          GUARDIAN_REQUIRED: t('errorGuardianRequired'),
          DEACTIVATED: t('errorDeactivated'),
          NOT_ENROLLED: t('errorNotEnrolled'),
          ALREADY_LEFT: t('errorAlreadyLeft'),
          NOT_LEFT: t('errorNotLeft'),
          STUDENT_LIMIT: t('errorStudentLimit'),
          NOT_A_NEW_YEAR: t('errorNotANewYear'),
          ENROLMENT_IN_USE: t('errorEnrolmentInUse'),
        };
        if (e.code && known[e.code]) return void toast.error(known[e.code]!);
        if ([400, 409, 422].includes(e.status)) return void toast.error(t('errorCheckForm'));
      }
      toast.error(describe(e));
    },
  });
}

function Profile() {
  const t = useTranslations('profile');
  const tEnum = useTranslations('enums');
  const tStatus = useTranslations('studentStatus');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const profile = useQuery({
    queryKey: ['student', session?.tenant?.id, id],
    queryFn: () => client.api<StudentProfile>(`/students/${id}`),
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const makePrimary = useStudentMutation(id, (linkId: string) =>
    client.api<StudentProfile>(`/students/${id}/guardians/${linkId}`, {
      method: 'PATCH',
      json: { isPrimary: true },
    }),
  );
  const removeGuardian = useStudentMutation(
    id,
    (linkId: string) =>
      client.api<StudentProfile>(`/students/${id}/guardians/${linkId}`, { method: 'DELETE' }),
    close,
  );
  const deactivate = useStudentMutation(
    id,
    () => client.api<StudentProfile>(`/students/${id}/deactivate`, { method: 'POST' }),
    close,
  );
  const returnStudent = useStudentMutation(
    id,
    () => client.api<StudentProfile>(`/students/${id}/return`, { method: 'POST' }),
    close,
  );

  if (profile.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (profile.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(profile.error)}</AlertDescription>
      </Alert>
    );
  const p = profile.data;
  const name = displayName(p.nameBn, p.nameEn, locale);
  const other = locale === 'bn' ? p.nameEn : p.nameBn;
  const current = p.enrolments.find((e) => e.academicYear.isCurrent) ?? p.enrolments[0] ?? null;
  const writable = isAdmin && !p.deletedAt;
  const both = (bn: string | null, en: string | null) =>
    [bn, en].filter(Boolean).join(' / ') || null;

  return (
    <div className="flex flex-col gap-5" data-testid="student-profile">
      {p.access === 'basic' && (
        <Alert data-testid="basic-access">
          <LockIcon aria-hidden />
          <AlertDescription>
            {t('basicAccess', { section: label('section', 'Section', { inText: true }) })}
          </AlertDescription>
        </Alert>
      )}
      {p.deletedAt && (
        <Alert>
          <PowerOffIcon aria-hidden />
          <AlertDescription>
            {t('deactivatedOn', { date: formatDate(new Date(p.deletedAt), locale, 'long') })}
          </AlertDescription>
        </Alert>
      )}
      {!p.deletedAt && p.status !== 'ACTIVE' && (
        <Alert data-testid="left-notice">
          <DoorOpenIcon aria-hidden />
          <AlertDescription>
            {p.leftOn
              ? t('leftOn', {
                  status: tStatus(p.status),
                  date: formatDate(new Date(p.leftOn + 'T00:00:00Z'), locale, 'long'),
                })
              : tStatus(p.status)}
            {p.leaveReason ? ' — ' + p.leaveReason : ''}
          </AlertDescription>
        </Alert>
      )}
      <section className="bg-card flex flex-col gap-4 rounded-xl border p-4 shadow-xs sm:flex-row sm:items-center sm:p-5">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <StudentAvatar studentId={p.id} photoId={p.photoId} name={name} size="xl" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-semibold break-words sm:text-2xl">{name}</h2>
            {other && <span className="text-muted-foreground break-words">{other}</span>}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className="bg-muted rounded-md px-2 py-0.5 tabular-nums"
                dir="ltr"
                data-testid="student-code"
              >
                {formatIdentifier(p.studentCode)}
              </span>
              <Badge variant={p.status === 'ACTIVE' ? 'success' : 'secondary'}>
                {tStatus(p.status)}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {context?.modules.includes('ATTENDANCE') && (
            <ButtonLink variant="outline" href={`/attendance/students/${p.id}`}>
              <CalendarCheckIcon aria-hidden />
              {t('attendance')}
            </ButtonLink>
          )}
          {writable && (
            <>
              <Button
                variant="outline"
                onClick={() => setDialog('photo')}
                data-testid="student-photo-button"
              >
                <CameraIcon aria-hidden />
                {p.photoId ? t('changePhoto') : t('addPhoto')}
              </Button>
              <Button
                variant="outline"
                onClick={() => setDialog('edit')}
                data-testid="edit-student"
              >
                <PencilIcon aria-hidden />
                {t('edit')}
              </Button>
              {current?.academicYear.isCurrent && (
                <Button
                  variant="outline"
                  onClick={() => setDialog('transfer')}
                  data-testid="transfer"
                >
                  <ArrowLeftRightIcon aria-hidden />
                  {t('transfer', { section: label('section', 'Section', { inText: true }) })}
                </Button>
              )}
              {p.status === 'ACTIVE' ? (
                <Button
                  variant="outline"
                  onClick={() => setDialog('leave')}
                  data-testid="leave-student"
                >
                  <DoorOpenIcon aria-hidden />
                  {t('leave')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setDialog('return')}
                  data-testid="return-student"
                >
                  <RotateCcwIcon aria-hidden />
                  {t('return')}
                </Button>
              )}
              <Button
                variant="destructive"
                onClick={() => setDialog('deactivate')}
                data-testid="deactivate"
              >
                <PowerOffIcon aria-hidden />
                {t('deactivate')}
              </Button>
            </>
          )}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard id="profile-enrolment" title={t('enrolment')}>
          {p.enrolments.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('notEnrolled')}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {p.enrolments.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-1 px-3 py-2.5"
                  data-testid="enrolment-row"
                >
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {e.academicYear.name}
                    {e.academicYear.isCurrent && <Badge variant="soft">{t('current')}</Badge>}
                    {/* A year after the current one (listed above it): its placement can be
                        corrected, e.g. a promotion applied by mistake (P5-L). */}
                    {writable &&
                      !e.academicYear.isCurrent &&
                      p.enrolments.findIndex((x) => x.academicYear.isCurrent) >
                        p.enrolments.indexOf(e) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ placement: e.id })}
                          data-testid="change-placement"
                        >
                          <PencilIcon aria-hidden />
                          {t('changePlacement')}
                        </Button>
                      )}
                  </span>
                  <span className="text-sm break-words">
                    {[
                      displayName(e.classLevel.nameBn, e.classLevel.nameEn, locale),
                      e.section ? `${label('section', 'Section')}: ${e.section.name}` : null,
                      e.roll !== null
                        ? `${label('roll', 'Roll')}: ${formatIdentifier(e.roll)}`
                        : null,
                      e.studyGroup
                        ? displayName(e.studyGroup.nameBn, e.studyGroup.nameEn, locale)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {p.access === 'full' && (
          <SectionCard
            id="profile-guardians"
            title={t('guardians')}
            actions={
              writable && p.guardians.length < 4 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog('guardian')}
                  data-testid="add-guardian-profile"
                >
                  <PlusIcon aria-hidden />
                  {t('addGuardian')}
                </Button>
              ) : undefined
            }
          >
            <ul
              className="flex flex-col divide-y rounded-lg border"
              data-testid="profile-guardians-list"
            >
              {p.guardians.map((g) => {
                const gName = displayName(g.nameBn, g.nameEn, locale);
                return (
                  <li key={g.linkId} className="flex flex-col gap-2 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-words">{gName}</span>
                      <span className="text-muted-foreground text-sm">
                        ({tEnum(`relation_${g.relation}`)})
                      </span>
                      {g.isPrimary && (
                        <Badge variant="warm">
                          <StarIcon aria-hidden />
                          {t('primary')}
                        </Badge>
                      )}
                      {g.canLogIn && (
                        <Badge variant="soft">
                          <KeyRoundIcon aria-hidden />
                          {t('canLogIn')}
                        </Badge>
                      )}
                    </div>
                    <a
                      href={`tel:${g.phone}`}
                      className="text-primary-ink inline-flex w-fit items-center gap-1 text-sm tabular-nums"
                      dir="ltr"
                    >
                      <PhoneIcon aria-hidden className="size-3.5" />
                      {formatBdPhone(g.phone)}
                    </a>
                    {writable && (
                      <div className="flex flex-wrap gap-2">
                        {!g.isPrimary && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => makePrimary.mutate(g.linkId)}
                            disabled={makePrimary.isPending}
                          >
                            <StarIcon aria-hidden />
                            {t('makePrimary')}
                          </Button>
                        )}
                        {!g.isPrimary && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ removeLink: g.linkId, name: gName })}
                          >
                            <Trash2Icon aria-hidden />
                            {t('removeGuardian')}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground text-sm">{t('primaryHint')}</p>
          </SectionCard>
        )}
      </div>

      {p.access === 'full' && (
        <SectionCard id="profile-details" title={t('details')}>
          <dl
            className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="profile-details-list"
          >
            <Item label={t('dateOfBirth')}>
              {p.dateOfBirth ? formatDate(dateToDb(p.dateOfBirth), locale, 'long') : null}
            </Item>
            <Item label={t('gender')}>{p.gender ? tEnum(`gender_${p.gender}`) : null}</Item>
            <Item label={t('religion')}>{p.religion ? tEnum(`religion_${p.religion}`) : null}</Item>
            <Item label={t('bloodGroup')}>
              {p.bloodGroup ? BLOOD_GROUP_LABEL[p.bloodGroup] : null}
            </Item>
            <Item label={t('birthReg')} ltr>
              {p.birthRegistrationNo ? formatIdentifier(p.birthRegistrationNo) : null}
            </Item>
            <Item label={t('father')}>{both(p.fatherNameBn, p.fatherNameEn)}</Item>
            <Item label={t('mother')}>{both(p.motherNameBn, p.motherNameEn)}</Item>
            <Item label={t('presentAddress')}>{p.presentAddress}</Item>
            <Item label={t('permanentAddress')}>{p.permanentAddress}</Item>
            <Item label={t('admitted')}>{formatDate(new Date(p.createdAt), locale, 'long')}</Item>
          </dl>
        </SectionCard>
      )}

      {dialog === 'edit' && <EditDialog profile={p} onClose={close} />}
      {dialog === 'photo' && <PhotoDialog profile={p} name={name} onClose={close} />}
      {dialog === 'transfer' && current && <TransferDialog profile={p} onClose={close} />}
      {dialog === 'guardian' && <AddGuardianDialog profile={p} onClose={close} />}
      {dialog === 'leave' && <LeaveDialog profile={p} name={name} onClose={close} />}
      {dialog !== null && typeof dialog === 'object' && 'placement' in dialog && (
        <PlacementDialog profile={p} enrolmentId={dialog.placement} onClose={close} />
      )}
      <ConfirmDialog
        open={dialog === 'return'}
        onOpenChange={(o) => !o && close()}
        title={t('returnTitle', { name })}
        body={t('returnBody')}
        confirmLabel={t('return')}
        pending={returnStudent.isPending}
        onConfirm={() => returnStudent.mutate(undefined)}
      />
      <ConfirmDialog
        open={dialog === 'deactivate'}
        onOpenChange={(o) => !o && close()}
        title={t('deactivateTitle', { name })}
        body={t('deactivateBody')}
        confirmLabel={t('deactivate')}
        pending={deactivate.isPending}
        onConfirm={() => deactivate.mutate(undefined)}
      />
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog !== null && 'removeLink' in dialog}
        onOpenChange={(o) => !o && close()}
        title={
          typeof dialog === 'object' && dialog && 'removeLink' in dialog
            ? t('removeGuardianTitle', { name: dialog.name })
            : ''
        }
        confirmLabel={t('removeGuardian')}
        pending={removeGuardian.isPending}
        onConfirm={() =>
          typeof dialog === 'object' &&
          dialog &&
          'removeLink' in dialog &&
          removeGuardian.mutate(dialog.removeLink)
        }
      />
    </div>
  );
}

function Item({ label, children, ltr }: { label: string; children: ReactNode; ltr?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="break-words" dir={ltr ? 'ltr' : undefined}>
        {children ?? <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

function EditDialog({ profile, onClose }: { profile: StudentProfile; onClose: () => void }) {
  const t = useTranslations('profile');
  const { client } = useAuth();
  const [value, setValue] = useState(() => studentFromProfile(profile));
  const [code, setCode] = useState(profile.studentCode);
  const [touched, setTouched] = useState(false);
  const problems = useStudentProblems();
  const serverErrors = useServerFieldErrors();
  const save = useStudentMutation(
    profile.id,
    () =>
      client.api<StudentProfile>(`/students/${profile.id}`, {
        method: 'PATCH',
        json: { ...studentPayload(value), studentCode: code },
      }),
    onClose,
  );
  const errors = { ...serverErrors(save.error), ...(touched ? problems(value) : {}) };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('editTitle')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => {
        setTouched(true);
        if (Object.keys(problems(value)).length === 0) save.mutate(undefined);
      }}
      testId="edit-student-dialog"
    >
      <StudentFields value={value} onChange={setValue} errors={errors} idPrefix="edit" />
      <TextField
        id="edit-code"
        label={t('studentCode')}
        value={code}
        onChange={setCode}
        required
        dir="ltr"
        maxLength={30}
        error={errors['studentCode']}
      />
      <BoardFields value={value} onChange={setValue} errors={errors} idPrefix="edit" />
    </FormDialog>
  );
}

function TransferDialog({ profile, onClose }: { profile: StudentProfile; onClose: () => void }) {
  const t = useTranslations('profile');
  const label = useLabel();
  const { client, session } = useAuth();
  const current = profile.enrolments.find((e) => e.academicYear.isCurrent)!;
  const sections = useQuery({
    queryKey: [
      'setup',
      session?.tenant?.id,
      `/setup/sections?academicYearId=${current.academicYear.id}`,
    ],
    queryFn: () =>
      client.api<SetupSection[]>(`/setup/sections?academicYearId=${current.academicYear.id}`),
  });
  const options = (sections.data ?? []).filter(
    (s) => s.isActive && s.classLevelId === current.classLevel.id && s.id !== current.section?.id,
  );
  const [sectionId, setSectionId] = useState('');
  const [roll, setRoll] = useState('');
  const serverErrors = useServerFieldErrors();
  const save = useStudentMutation(
    profile.id,
    () =>
      client.api<StudentProfile>(`/students/${profile.id}/transfer`, {
        method: 'POST',
        json: { sectionId, roll: roll.trim() || null },
      }),
    onClose,
  );
  const errors = serverErrors(save.error);
  const section = label('section', 'Section');
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('transferTitle', { section: label('section', 'Section', { inText: true }) })}
      description={t('transferHint')}
      submitLabel={t('transferSubmit')}
      pending={save.isPending}
      onSubmit={() => sectionId && save.mutate(undefined)}
      testId="transfer-dialog"
    >
      <SelectField
        id="transfer-section"
        label={section}
        value={sectionId}
        onChange={setSectionId}
        required
        placeholder={options.length === 0 ? t('noOtherSection') : t('choose')}
        options={options.map((s) => ({ value: s.id, label: s.name }))}
        error={errors['sectionId']}
      />
      <TextField
        id="transfer-roll"
        label={label('roll', 'Roll')}
        value={roll}
        onChange={setRoll}
        inputMode="numeric"
        dir="ltr"
        maxLength={6}
        error={errors['roll']}
      />
    </FormDialog>
  );
}

/**
 * Corrects a placement in a year that is not current yet (P5-L): class, section and group; the
 * roll is cleared (numbered again). Refused once that year has records for the student.
 */
function PlacementDialog({
  profile,
  enrolmentId,
  onClose,
}: {
  profile: StudentProfile;
  enrolmentId: string;
  onClose: () => void;
}) {
  const t = useTranslations('profile');
  const label = useLabel();
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const e = profile.enrolments.find((x) => x.id === enrolmentId)!;
  const classes = useQuery({
    queryKey: ['setup', session?.tenant?.id, '/setup/class-levels'],
    queryFn: () => client.api<SetupClassLevel[]>('/setup/class-levels'),
  });
  const sections = useQuery({
    queryKey: ['setup', session?.tenant?.id, `/setup/sections?academicYearId=${e.academicYear.id}`],
    queryFn: () =>
      client.api<SetupSection[]>(`/setup/sections?academicYearId=${e.academicYear.id}`),
  });
  const groups = useQuery({
    queryKey: ['setup', session?.tenant?.id, '/setup/study-groups'],
    queryFn: () => client.api<SetupStudyGroup[]>('/setup/study-groups'),
  });
  const [classLevelId, setClassLevelId] = useState(e.classLevel.id);
  const [sectionId, setSectionId] = useState(e.section?.id ?? '');
  const [studyGroupId, setStudyGroupId] = useState(e.studyGroup?.id ?? '');
  const serverErrors = useServerFieldErrors();
  const save = useStudentMutation(
    profile.id,
    () =>
      client.api<StudentProfile>(`/students/${profile.id}/enrolments/${enrolmentId}`, {
        method: 'PATCH',
        json: {
          classLevelId,
          sectionId: sectionId || null,
          studyGroupId: studyGroupId || null,
        },
      }),
    onClose,
  );
  const errors = serverErrors(save.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('placementTitle', { year: e.academicYear.name })}
      description={t('placementHint')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="placement-dialog"
    >
      <SelectField
        id="placement-class"
        label={label('class_level', 'Class')}
        value={classLevelId}
        onChange={(v) => {
          setClassLevelId(v);
          setSectionId('');
        }}
        required
        options={(classes.data ?? [])
          .filter((c) => c.isActive)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((c) => ({ value: c.id, label: displayName(c.nameBn, c.nameEn, locale) }))}
        error={errors['classLevelId']}
      />
      <SelectField
        id="placement-section"
        label={label('section', 'Section')}
        value={sectionId}
        onChange={setSectionId}
        placeholder={t('choose')}
        options={(sections.data ?? [])
          .filter((s) => s.isActive && s.classLevelId === classLevelId)
          .map((s) => ({ value: s.id, label: s.name }))}
        error={errors['sectionId']}
      />
      <SelectField
        id="placement-group"
        label={label('study_group', 'Group')}
        value={studyGroupId}
        onChange={setStudyGroupId}
        placeholder={t('choose')}
        options={(groups.data ?? [])
          .filter((g) => g.isActive)
          .map((g) => ({ value: g.id, label: displayName(g.nameBn, g.nameEn, locale) }))}
        error={errors['studyGroupId']}
      />
    </FormDialog>
  );
}

/** The student leaves (S14): a status, a date and an optional reason; nothing is deleted. */
function LeaveDialog({
  profile,
  name,
  onClose,
}: {
  profile: StudentProfile;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('profile');
  const tStatus = useTranslations('studentStatus');
  const { client } = useAuth();
  const { data: context } = useMeContext();
  const [status, setStatus] = useState<LeaveStatus>('TRANSFERRED');
  const [leftOn, setLeftOn] = useState(context?.today ?? '');
  const [reason, setReason] = useState('');
  const serverErrors = useServerFieldErrors();
  const save = useStudentMutation(
    profile.id,
    () =>
      client.api<StudentProfile>('/students/' + profile.id + '/leave', {
        method: 'POST',
        json: { status, leftOn, reason: reason.trim() || null },
      }),
    onClose,
  );
  const errors = serverErrors(save.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('leaveTitle', { name })}
      description={t('leaveHint')}
      submitLabel={t('leave')}
      pending={save.isPending}
      onSubmit={() => leftOn && save.mutate(undefined)}
      testId="leave-dialog"
    >
      <SelectField
        id="leave-status"
        label={t('leaveStatus')}
        value={status}
        onChange={(v) => setStatus(v as LeaveStatus)}
        required
        options={LEAVE_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
        error={errors['status']}
      />
      <TextField
        id="leave-date"
        type="date"
        label={t('leaveDate')}
        value={leftOn}
        onChange={setLeftOn}
        required
        error={errors['leftOn']}
      />
      <TextField
        id="leave-reason"
        label={t('leaveReason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        error={errors['reason']}
      />
    </FormDialog>
  );
}

function AddGuardianDialog({ profile, onClose }: { profile: StudentProfile; onClose: () => void }) {
  const t = useTranslations('profile');
  const { client } = useAuth();
  const [value, setValue] = useState<GuardianFormValues[]>(() => [newGuardian(false, 'MOTHER')]);
  const [touched, setTouched] = useState(false);
  const problems = useGuardianProblems();
  const serverErrors = useServerFieldErrors();
  const save = useStudentMutation(
    profile.id,
    () =>
      client.api<StudentProfile>(`/students/${profile.id}/guardians`, {
        method: 'POST',
        json: guardianPayload(value[0]!),
      }),
    onClose,
  );
  const queryClient = useQueryClient();
  // Someone may have added a guardian on the same phone meanwhile: show the choices again.
  useEffect(() => {
    if (save.isError) void queryClient.invalidateQueries({ queryKey: ['guardian-matches'] });
  }, [save.isError, queryClient]);
  const g = value[0]!;
  const server = serverErrors(save.error);
  const errors = {
    [g.key]: {
      ...(server['phone'] ? { phone: server['phone'] } : {}),
      ...(server['guardians'] ? { nameBn: server['guardians'] } : {}),
      ...(server['guardianChoice'] ? { choice: server['guardianChoice'] } : {}),
      ...(touched ? problems(g) : {}),
    },
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('addGuardian')}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => {
        setTouched(true);
        if (Object.keys(problems(g)).length === 0) save.mutate(undefined);
      }}
      testId="add-guardian-dialog"
    >
      <GuardianFields value={value} onChange={setValue} errors={errors} single />
    </FormDialog>
  );
}
