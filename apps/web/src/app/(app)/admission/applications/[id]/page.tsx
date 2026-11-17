'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLOOD_GROUP_LABEL,
  formatBdPhone,
  formatCount,
  formatDate,
  formatIdentifier,
  type AdmissionApplicationDetail,
  type AdmissionSectionOption,
  type GuardianMatch,
} from '@jantrik/shared';
import { ArrowLeftIcon, CheckIcon, PencilIcon, UserRoundIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { APPLICATION_TONE, errorCode } from '@/components/admission/admission-kit';
import {
  ApplicationFields,
  applicationPayload,
  serverProblems,
  valuesFrom,
  type ApplicationValues,
} from '@/components/admission/application-form';
import { ChoiceChip, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { ChooseImageButton, imageForm } from '@/components/image-upload';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { FormDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthedImage, useImageErrorMessage } from '@/lib/authed-image';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** One application: details, edits, status, photo and approval into a student. */
export default function ApplicationPage() {
  return (
    <PageGate page="admission">
      <Application />
    </PageGate>
  );
}

function Application() {
  const t = useTranslations('admissions.staff');
  const td = useTranslations('admissions.staff.detail');
  const tt = useTranslations('admissions.staff.test');
  const ta = useTranslations('admission');
  const te = useTranslations('enums');
  const locale = useLocale() as Locale;
  const { id } = useParams<{ id: string }>();
  const describe = useErrorMessage();
  const imageError = useImageErrorMessage();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const key = ['admission-application', session?.tenant?.id, id];
  const app = useQuery({
    queryKey: key,
    queryFn: () => client.api<AdmissionApplicationDetail>(`/admission/applications/${id}`),
  });
  const [editing, setEditing] = useState<ApplicationValues | null>(null);
  const [statusDialog, setStatusDialog] = useState<'REJECTED' | 'WITHDRAWN' | null>(null);
  const [reason, setReason] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);
  const photo = useAuthedImage(
    app.data?.hasPhoto ? `/admission/applications/${id}/photo` : null,
    app.data?.photoVersion ?? null,
  );

  const changed = (a: AdmissionApplicationDetail) => {
    queryClient.setQueryData(key, a);
    void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
    void queryClient.invalidateQueries({ queryKey: ['admission-cycles'] });
  };
  const failed = (e: unknown) => {
    const code = errorCode(e);
    if (code === 'APPLICATION_ADMITTED') toast.error(td('admittedNoEdit'));
    else if (code === 'ADMISSION_DUPLICATE') {
      const body = (e as ApiError).body as { applicationNo?: string } | null;
      toast.error(td('duplicate', { no: formatIdentifier(body?.applicationNo ?? '') }));
    } else if (code === 'ADMISSION_PHONE_CAP') toast.error(td('phoneCap'));
    else if (code === 'ADMISSION_FIELDS_REQUIRED') toast.error(td('fieldsRequired'));
    else if (code === 'SELECTED_BY_TEST') toast.error(td('notApprovable'));
    else if (code === 'TEST_RESULT_PUBLISHED') toast.error(tt('resultPublishedStatus'));
    else if (e instanceof ApiError && (e.status === 400 || e.status === 422))
      toast.error(td('checkForm'));
    else toast.error(describe(e));
  };
  const save = useMutation({
    mutationFn: (v: ApplicationValues) =>
      client.api<AdmissionApplicationDetail>(`/admission/applications/${id}`, {
        method: 'PATCH',
        json: applicationPayload(v),
      }),
    onSuccess: (a) => {
      changed(a);
      setEditing(null);
      toast.success(td('saved'));
    },
    onError: failed,
  });
  const setStatus = useMutation({
    mutationFn: (body: { status: string; reason?: string | null }) =>
      client.api<AdmissionApplicationDetail>(`/admission/applications/${id}/status`, {
        method: 'POST',
        json: body,
      }),
    onSuccess: (a) => {
      changed(a);
      setStatusDialog(null);
      setReason('');
      toast.success(td('statusChanged'));
    },
    onError: failed,
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      client.api<AdmissionApplicationDetail>(`/admission/applications/${id}/photo`, {
        method: 'PUT',
        body: imageForm(file),
      }),
    onSuccess: changed,
    onError: (e) => toast.error(imageError(e)),
  });

  if (app.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (!app.data)
    return (
      <Alert>
        <AlertDescription>{describe(app.error)}</AlertDescription>
      </Alert>
    );
  const a = app.data;
  const admitted = a.status === 'ADMITTED';
  const name = displayName(a.nameBn, a.nameEn, locale);
  const row = (label: string, value: string | null | undefined) =>
    value ? (
      <div className="flex flex-col">
        <dt className="text-muted-foreground text-sm">{label}</dt>
        <dd className="break-words">{value}</dd>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink variant="ghost" size="sm" href="/admission/applications">
          <ArrowLeftIcon aria-hidden />
          {td('back')}
        </ButtonLink>
        <h2 className="text-lg font-semibold">
          {td('applicationNo', { no: formatIdentifier(a.applicationNo) })} · {name}
        </h2>
        <Pill tone={APPLICATION_TONE[a.status]}>{t(`appStatus.${a.status}`)}</Pill>
        <span className="text-muted-foreground text-sm">{t(`source.${a.source}`)}</span>
      </div>

      {a.approvalProblem && !admitted && (
        <Alert>
          <AlertDescription>{t(`problem.${a.approvalProblem}`)}</AlertDescription>
        </Alert>
      )}
      {a.possibleDuplicates.length > 0 && !admitted && (
        <Alert>
          <AlertDescription>
            {td('duplicates')}{' '}
            {a.possibleDuplicates.map((s) => (
              <a key={s.id} href={`/students/${s.id}`} className="me-2 underline">
                {formatIdentifier(s.studentCode)} {displayName(s.nameBn, s.nameEn, locale)}
              </a>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {!admitted && !editing && (
        <div className="flex flex-wrap gap-2">
          {a.approvable && (
            <Button onClick={() => setApproveOpen(true)} data-testid="approve-open">
              <CheckIcon aria-hidden />
              {td('approve')}
            </Button>
          )}
          {a.status !== 'SHORTLISTED' && a.status !== 'SELECTED' && (
            <Button
              variant="outline"
              onClick={() => setStatus.mutate({ status: 'SHORTLISTED' })}
              data-testid="shortlist"
            >
              {td('shortlist')}
            </Button>
          )}
          {!a.requiresTest && a.status !== 'SELECTED' && (
            <Button
              variant="outline"
              onClick={() => setStatus.mutate({ status: 'SELECTED' })}
              data-testid="select"
            >
              {td('select')}
            </Button>
          )}
          {a.status !== 'SUBMITTED' && (
            <Button variant="outline" onClick={() => setStatus.mutate({ status: 'SUBMITTED' })}>
              {td('backToSubmitted')}
            </Button>
          )}
          <Button variant="outline" onClick={() => setStatusDialog('REJECTED')}>
            {td('reject')}
          </Button>
          <Button variant="ghost" onClick={() => setStatusDialog('WITHDRAWN')}>
            {td('withdraw')}
          </Button>
          <Button variant="ghost" onClick={() => setEditing(valuesFrom(a))}>
            <PencilIcon aria-hidden />
            {td('edit')}
          </Button>
        </div>
      )}
      {admitted && a.student && (
        <div className="flex flex-wrap items-center gap-3">
          <ButtonLink href={`/students/${a.student.id}`}>
            <UserRoundIcon aria-hidden />
            {td('openStudent')}
          </ButtonLink>
          <span className="text-muted-foreground font-mono text-sm">
            {formatIdentifier(a.student.studentCode)}
          </span>
        </div>
      )}

      {editing ? (
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <ApplicationFields
            values={editing}
            onChange={setEditing}
            errors={serverProblems(save.error, ta('errorInvalid'), ta('errorRequired'))}
            settings={null}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              {td('cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {td('save')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
          <SectionCard id="application-details" title={name}>
            <dl className="grid gap-3 sm:grid-cols-2">
              {row(
                t('cycle.classLevel'),
                displayName(a.cycleClass.classLevel.nameBn, a.cycleClass.classLevel.nameEn, locale),
              )}
              {row(ta('dateOfBirth'), formatDate(a.dateOfBirth, locale))}
              {row(ta('gender'), te(`gender_${a.gender}`))}
              {row(ta('birthReg'), a.birthRegistrationNo)}
              {row(ta('religion'), a.religion ? te(`religion_${a.religion}`) : null)}
              {row(ta('bloodGroup'), a.bloodGroup ? BLOOD_GROUP_LABEL[a.bloodGroup] : null)}
              {row(td('previousInstitute'), a.previousInstitute)}
              {row(ta('fatherNameBn'), displayName(a.fatherNameBn, a.fatherNameEn, locale) || null)}
              {row(ta('motherNameBn'), displayName(a.motherNameBn, a.motherNameEn, locale) || null)}
              {row(ta('presentAddress'), a.presentAddress)}
              {row(ta('permanentAddress'), a.permanentAddress)}
              {row(
                t('list.guardian'),
                `${displayName(a.guardianNameBn, a.guardianNameEn, locale)} (${te(`relation_${a.guardianRelation}`)})`,
              )}
              {row(ta('phone'), formatBdPhone(a.phone))}
              {row(ta('occupation'), a.guardianOccupation)}
              {row(td('staffNote'), a.staffNote)}
              {row(td('reason'), a.statusReason)}
              {row(t('list.submitted'), formatDate(a.submittedAt, locale))}
            </dl>
          </SectionCard>
          <SectionCard id="application-photo" title={td('photo')}>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- an authenticated blob URL
              <img src={photo} alt={name} className="aspect-[3/4] w-full rounded-lg object-cover" />
            ) : (
              <p className="text-muted-foreground text-sm">{td('noPhoto')}</p>
            )}
            {!admitted && (
              <ChooseImageButton
                opaque
                onChoose={(f) => upload.mutate(f)}
                onTooLarge={() =>
                  toast.error(imageError(new ApiError(413, undefined, 'Too large')))
                }
                disabled={upload.isPending}
                testId="application-photo"
              >
                {a.hasPhoto ? td('replacePhoto') : td('addPhoto')}
              </ChooseImageButton>
            )}
          </SectionCard>
        </div>
      )}

      <FormDialog
        open={statusDialog !== null}
        onOpenChange={(o) => !o && setStatusDialog(null)}
        title={statusDialog === 'REJECTED' ? td('reject') : td('withdraw')}
        submitLabel={td('confirm')}
        pending={setStatus.isPending}
        onSubmit={() => {
          if (statusDialog && reason.trim())
            setStatus.mutate({ status: statusDialog, reason: reason.trim() });
        }}
        testId="status-dialog"
      >
        <TextField
          id="status-reason"
          label={td('reason')}
          hint={td('reasonHint')}
          value={reason}
          onChange={setReason}
          maxLength={500}
          required
        />
      </FormDialog>

      {approveOpen && (
        <ApproveDialog
          application={a}
          onClose={() => setApproveOpen(false)}
          onDone={(next) => {
            changed(next);
            setApproveOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ApproveDialog({
  application: a,
  onClose,
  onDone,
}: {
  application: AdmissionApplicationDetail;
  onClose: () => void;
  onDone: (a: AdmissionApplicationDetail) => void;
}) {
  const td = useTranslations('admissions.staff.detail');
  const ta = useTranslations('admission');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const [sectionId, setSectionId] = useState('');
  const [roll, setRoll] = useState('');
  const [studentCode, setStudentCode] = useState('');
  const [choice, setChoice] = useState<string | 'NEW' | null>(null);
  const [needsChoice, setNeedsChoice] = useState(false);
  const sections = useQuery({
    queryKey: ['admission-sections', session?.tenant?.id, a.cycleClass.id],
    queryFn: () =>
      client.api<AdmissionSectionOption[]>(`/admission/cycle-classes/${a.cycleClass.id}/sections`),
  });
  const matches = useQuery({
    queryKey: ['guardian-matches', session?.tenant?.id, a.phone],
    queryFn: () => client.api<GuardianMatch[]>(`/guardians?phone=${encodeURIComponent(a.phone)}`),
    enabled: needsChoice,
  });
  const approve = useMutation({
    mutationFn: () =>
      client.api<{
        studentCode: string;
        photo: 'MOVED' | 'NONE' | 'STORAGE_FULL';
        application: AdmissionApplicationDetail;
      }>(`/admission/applications/${a.id}/approve`, {
        method: 'POST',
        json: {
          sectionId: sectionId || null,
          roll: roll.trim() || null,
          studentCode: studentCode.trim() || null,
          guardianId: choice && choice !== 'NEW' ? choice : null,
          createNew: choice === 'NEW',
        },
      }),
    onSuccess: (r) => {
      const code = formatIdentifier(r.studentCode);
      if (r.photo === 'STORAGE_FULL') toast.warning(td('approvedNoPhoto', { code }));
      else toast.success(td('approved', { code }));
      onDone(r.application);
    },
    onError: (e) => {
      const code = errorCode(e);
      if (code === 'GUARDIAN_CHOICE_REQUIRED') setNeedsChoice(true);
      else if (code === 'SECTION_FULL') toast.error(td('sectionFull'));
      else if (code === 'STUDENT_LIMIT') toast.error(td('studentLimit'));
      else if (code === 'ROLL_TAKEN') toast.error(td('rollTaken'));
      else if (code === 'APPLICATION_NOT_APPROVABLE') toast.error(td('notApprovable'));
      else if (code === 'ALREADY_ADMITTED') toast.error(td('alreadyAdmitted'));
      else if (code === 'DUPLICATE') toast.error(ta('errorBirthRegTaken'));
      else toast.error(describe(e));
    },
  });

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={td('approveTitle')}
      description={td('approveHint', { year: a.academicYear.name })}
      submitLabel={td('approve')}
      pending={approve.isPending}
      onSubmit={() => {
        if (needsChoice && !choice) return;
        approve.mutate();
      }}
      testId="approve-dialog"
      noValidate
    >
      <SelectField
        id="approve-section"
        label={td('section')}
        value={sectionId}
        onChange={setSectionId}
        placeholder={td('noSection')}
        options={(sections.data ?? []).map((s) => ({
          value: s.id,
          label:
            s.capacity !== null
              ? `${s.name} (${formatCount(s.enrolled, locale)}/${formatCount(s.capacity, locale)})`
              : s.name,
        }))}
      />
      <TextField
        id="approve-roll"
        label={td('roll')}
        value={roll}
        onChange={setRoll}
        inputMode="numeric"
        disabled={!sectionId}
      />
      <TextField
        id="approve-code"
        label={td('studentCode')}
        hint={td('studentCodeHint')}
        value={studentCode}
        onChange={setStudentCode}
      />
      {needsChoice && (
        <fieldset className="flex flex-col gap-2" data-testid="guardian-choice">
          <legend className="mb-1 text-sm font-medium">{td('guardianChoice')}</legend>
          {(matches.data ?? []).map((m) => (
            <ChoiceChip
              key={m.id}
              type="radio"
              name="guardian"
              checked={choice === m.id}
              onChange={() => setChoice(m.id)}
            >
              {displayName(m.nameBn, m.nameEn, locale)}
              {m.children.length > 0 &&
                ` — ${m.children.map((c) => displayName(c.nameBn, c.nameEn, locale)).join(', ')}`}
            </ChoiceChip>
          ))}
          <ChoiceChip
            type="radio"
            name="guardian"
            checked={choice === 'NEW'}
            onChange={() => setChoice('NEW')}
          >
            {td('newGuardian')}
          </ChoiceChip>
        </fieldset>
      )}
    </FormDialog>
  );
}
