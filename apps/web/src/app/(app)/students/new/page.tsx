'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  normalizeBdPhone,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupSection,
  type SetupStudyGroup,
  type StudentProfile,
  type StudentSettings,
} from '@jantrik/shared';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionCard, SelectField, TextField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import {
  BoardFields,
  GuardianFields,
  StudentFields,
  emptyStudent,
  guardianPayload,
  newGuardian,
  studentPayload,
  useGuardianProblems,
  useServerFieldErrors,
  useStudentProblems,
  type GuardianFormValues,
} from '@/components/students/student-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** One admission: the student, board registration fields, guardians and the enrolment. */
export default function AdmissionPage() {
  return (
    <PageGate page="students">
      <Admission />
    </PageGate>
  );
}

function useSetupList<T>(path: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['setup', session?.tenant?.id, path],
    queryFn: () => client.api<T>(path!),
    enabled: path !== null,
  });
}

function Admission() {
  const t = useTranslations('admission');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const router = useRouter();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { data: context } = useMeContext();
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;

  const years = useSetupList<SetupAcademicYear[]>(isAdmin ? '/setup/academic-years' : null);
  const classLevels = useSetupList<SetupClassLevel[]>(isAdmin ? '/setup/class-levels' : null);
  const groups = useSetupList<SetupStudyGroup[]>(isAdmin ? '/setup/study-groups' : null);
  const settings = useQuery({
    queryKey: ['student-settings', context?.tenant.id],
    queryFn: () => client.api<StudentSettings>('/students/settings'),
    enabled: isAdmin,
  });

  const [student, setStudent] = useState(emptyStudent);
  const [guardians, setGuardians] = useState<GuardianFormValues[]>(() => [newGuardian(true)]);
  const [yearId, setYearId] = useState('');
  const [classLevelId, setClassLevelId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [studyGroupId, setStudyGroupId] = useState('');
  const [roll, setRoll] = useState('');
  const [studentCode, setStudentCode] = useState('');
  const [touched, setTouched] = useState(false);
  const year = years.data?.find((y) => y.id === yearId) ?? years.data?.find((y) => y.isCurrent);
  const sections = useSetupList<SetupSection[]>(
    year ? `/setup/sections?academicYearId=${year.id}` : null,
  );
  const sectionOptions = (sections.data ?? []).filter(
    (s) => s.isActive && s.classLevelId === classLevelId,
  );

  const studentProblems = useStudentProblems();
  const guardianProblems = useGuardianProblems();
  const serverErrors = useServerFieldErrors();

  const admit = useMutation({
    mutationFn: () =>
      client.api<StudentProfile>('/students', {
        method: 'POST',
        json: {
          ...studentPayload(student),
          studentCode: studentCode.trim() || null,
          guardians: guardians.map(guardianPayload),
          enrolment: {
            academicYearId: year!.id,
            classLevelId,
            sectionId: sectionId || null,
            studyGroupId: studyGroupId || null,
            roll: roll.trim() || null,
          },
        },
      }),
    onSuccess: (p) => {
      for (const key of [
        'students',
        'students-total',
        'student-filters',
        'setup',
        'student-settings',
      ])
        void queryClient.invalidateQueries({ queryKey: [key] });
      toast.success(t('admitted', { code: p.studentCode }));
      router.push(`/students/${p.id}`);
    },
    onError: (e) => {
      if (!(e instanceof ApiError) || (e.status !== 400 && e.status !== 409 && e.status !== 422)) {
        toast.error(describe(e));
      } else toast.error(t('errorCheckForm'));
    },
  });

  if (context && !isAdmin) {
    return (
      <Alert>
        <AlertDescription>{t('adminOnly')}</AlertDescription>
      </Alert>
    );
  }
  if (years.isPending || classLevels.isPending) return <Skeleton className="h-96 rounded-xl" />;

  const server = serverErrors(admit.error);
  const local = touched ? studentProblems(student) : {};
  const studentErrors = { ...server, ...local };
  const guardianErrors: Record<string, Record<string, string>> = {};
  guardians.forEach((g, i) => {
    const fromServer: Record<string, string> = {};
    for (const [path, msg] of Object.entries(server)) {
      const m = /^guardians\.(\d+)\.(\w+)$/.exec(path);
      if (m && Number(m[1]) === i) fromServer[m[2]!] = msg;
    }
    // GUARDIAN_NAME_REQUIRED names the guardian by phone.
    if (server['guardians'] && admit.error instanceof ApiError) {
      const body = admit.error.body as { phone?: string } | null;
      if (body?.phone && body.phone === normalizeBdPhone(g.phone))
        fromServer['nameBn'] = server['guardians'];
    }
    guardianErrors[g.key] = { ...fromServer, ...(touched ? guardianProblems(g) : {}) };
  });
  const enrolmentErrors = {
    classLevelId:
      touched && !classLevelId
        ? t('errorRequired')
        : (server['enrolment.classLevelId'] ?? server['classLevelId']),
    sectionId: server['sectionId'] ?? server['enrolment.sectionId'],
    roll: server['roll'] ?? server['enrolment.roll'],
  };
  const blocked =
    Object.keys(studentProblems(student)).length > 0 ||
    guardians.some((g) => Object.keys(guardianProblems(g)).length > 0) ||
    !classLevelId ||
    !year;

  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');
  const studentLabel = label('student', 'Student', { inText: true });
  const activeClasses = (classLevels.data ?? []).filter((c) => c.isActive);
  const activeGroups = (groups.data ?? []).filter((g) => g.isActive);

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!blocked) admit.mutate();
        else toast.error(t('errorCheckForm'));
      }}
      data-testid="admission-form"
    >
      <h2 className="text-xl font-semibold sm:text-2xl">{t('title', { student: studentLabel })}</h2>

      <SectionCard
        id="admission-student"
        title={t('sectionStudent', { student: label('student', 'Student') })}
      >
        <StudentFields value={student} onChange={setStudent} errors={studentErrors} />
      </SectionCard>

      <SectionCard id="admission-enrolment" title={t('sectionEnrolment')} hint={t('enrolmentHint')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {years.data && years.data.length > 1 && (
            <SelectField
              id="enrol-year"
              label={label('academic_year', 'Academic Year')}
              value={year?.id ?? ''}
              onChange={(v) => {
                setYearId(v);
                setSectionId('');
              }}
              options={years.data.map((y) => ({
                value: y.id,
                label: y.isCurrent ? `${y.name} (${t('current')})` : y.name,
              }))}
            />
          )}
          <SelectField
            id="enrol-class"
            label={classLabel}
            value={classLevelId}
            required
            onChange={(v) => {
              setClassLevelId(v);
              setSectionId('');
            }}
            placeholder={t('choose')}
            options={activeClasses.map((c) => ({
              value: c.id,
              label: displayName(c.nameBn, c.nameEn, locale),
            }))}
            error={enrolmentErrors.classLevelId}
          />
          <SelectField
            id="enrol-section"
            label={sectionLabel}
            value={sectionId}
            onChange={setSectionId}
            disabled={!classLevelId}
            placeholder={sectionOptions.length === 0 ? t('noSections') : t('choose')}
            options={sectionOptions.map((s) => ({
              value: s.id,
              label:
                s.capacity !== null ? `${s.name} (${s.usage.enrolments}/${s.capacity})` : s.name,
            }))}
            error={enrolmentErrors.sectionId}
          />
          {activeGroups.length > 0 && (
            <SelectField
              id="enrol-group"
              label={label('study_group', 'Group')}
              value={studyGroupId}
              onChange={setStudyGroupId}
              placeholder={t('none')}
              options={activeGroups.map((g) => ({
                value: g.id,
                label: displayName(g.nameBn, g.nameEn, locale),
              }))}
            />
          )}
          <TextField
            id="enrol-roll"
            label={label('roll', 'Roll')}
            value={roll}
            onChange={setRoll}
            inputMode="numeric"
            dir="ltr"
            maxLength={6}
            hint={t('rollHint')}
            error={enrolmentErrors.roll}
          />
          <TextField
            id="student-code"
            label={t('studentCode')}
            value={studentCode}
            onChange={setStudentCode}
            dir="ltr"
            maxLength={30}
            placeholder={settings.data?.example}
            hint={
              settings.data ? t('studentCodeHint', { example: settings.data.example }) : undefined
            }
            error={server['studentCode']}
          />
        </div>
      </SectionCard>

      <SectionCard id="admission-guardians" title={t('sectionGuardians')}>
        <GuardianFields value={guardians} onChange={setGuardians} errors={guardianErrors} />
      </SectionCard>

      <SectionCard id="admission-board" title={t('sectionBoard')} hint={t('boardHint')}>
        <BoardFields value={student} onChange={setStudent} errors={studentErrors} />
      </SectionCard>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={admit.isPending} data-testid="admit">
          {t('submit')}
        </Button>
        <Button type="button" size="lg" variant="outline" onClick={() => router.push('/students')}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
