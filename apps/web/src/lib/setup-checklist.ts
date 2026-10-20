'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AttendanceSettings,
  AttendanceTodaySummary,
  MeContext,
  Onboarding,
  StudentFilters,
  StudentsPage,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';

/** GET /onboarding: the new owner's setup wizard (OWNER/ADMIN). */
export function useOnboarding(enabled = true) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['onboarding', session?.tenant?.id],
    queryFn: () => client.api<Onboarding>('/onboarding'),
    enabled: enabled && Boolean(session?.tenant),
  });
}

/** Where "Continue setup" goes: the wizard at its next open step. */
export const wizardHref = (o: Onboarding): string =>
  o.nextStep ? `/setup/welcome?step=${o.nextStep}` : '/setup/welcome';

export interface ChecklistStep {
  key: 'institute' | 'year' | 'sections' | 'students' | 'attendance' | 'sms';
  done: boolean;
  title: string;
  text: string;
  href?: string;
}

/**
 * The dashboard's "Getting started" list for owners and admins, worked out from what exists
 * (an academic year, sections, students, attendance taken, absent SMS on), plus the setup wizard
 * while it is unfinished. The queries share their keys with the dashboard's cards.
 */
export function useSetupChecklist(context: MeContext) {
  const t = useTranslations('dashboard');
  const label = useLabel();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const attendance = context.modules.includes('ATTENDANCE');

  const students = useQuery({
    queryKey: ['students-total', tenantId],
    queryFn: () => client.api<StudentsPage>('/students?pageSize=1'),
  });
  const filters = useQuery({
    queryKey: ['student-filters', tenantId],
    queryFn: () => client.api<StudentFilters>('/students/filters'),
  });
  const summary = useQuery({
    queryKey: ['attendance-summary', tenantId],
    queryFn: () => client.api<AttendanceTodaySummary>('/attendance/summary/today'),
    enabled: attendance,
  });
  const settings = useQuery({
    queryKey: ['attendance-settings', tenantId],
    queryFn: () => client.api<AttendanceSettings>('/attendance/settings'),
    enabled: attendance,
  });
  const onboarding = useOnboarding();

  const student = label('student', 'Student', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  const section = label('section', 'Section', { inText: true });
  const steps: ChecklistStep[] = [
    { key: 'institute', done: true, title: t('stepInstitute'), text: t('stepInstituteText') },
    {
      key: 'year',
      done: Boolean(context.academicYear),
      title: t('stepYear', { label: label('academic_year', 'Academic Year', { inText: true }) }),
      text: t('stepYearText'),
      href: '/setup',
    },
    {
      key: 'sections',
      done: Boolean(filters.data?.classLevels.some((c) => c.sections.length > 0)),
      title: t('stepSections', { classLevel, section }),
      text: t('stepSectionsText', { classLevel, section }),
      href: '/setup/classes',
    },
    {
      key: 'students',
      done: (students.data?.total ?? 0) > 0,
      title: t('stepStudents', { student }),
      text: t('stepStudentsText'),
      href: '/students',
    },
    ...(attendance
      ? [
          {
            key: 'attendance' as const,
            done: summary.data?.everTaken ?? false,
            title: t('stepAttendance'),
            text: t('stepAttendanceText'),
            href: '/attendance',
          },
          {
            key: 'sms' as const,
            done: settings.data?.absentSmsEnabled ?? false,
            title: t('stepSms'),
            text: t('stepSmsText'),
            href: '/attendance/settings#settings-sms',
          },
        ]
      : []),
  ];
  const wizard = onboarding.data?.wizard && !onboarding.data.completedAt ? onboarding.data : null;
  return {
    steps,
    done: steps.filter((s) => s.done).length,
    /** The unfinished setup wizard, if this institute has one. */
    wizard,
    loading:
      students.isPending ||
      filters.isPending ||
      onboarding.isPending ||
      (attendance && (summary.isPending || settings.isPending)),
  };
}
