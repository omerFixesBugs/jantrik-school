'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ExamsTabs } from '@/components/exams/kit';
import {
  GradingTab,
  RoomsTab,
  SubjectChoicesTab,
  SubjectMarksTab,
  SubjectTeachersTab,
} from '@/components/exams/setup-tabs';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { PageGate } from '@/components/page-gate';

const TABS = ['marks', 'teachers', 'choices', 'rooms', 'grading'] as const;
type Tab = (typeof TABS)[number];

/** Exams setup (OWNER/ADMIN): subject marks, subject teachers, 4th subjects, rooms, GPA rules. */
export default function ExamsSetupPage() {
  const t = useTranslations('exams.setup');
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'marks') as Tab;
  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <ExamsTabs />
        <div className="-mx-1 overflow-x-auto px-1">
          <SegmentedControl
            label={t('tabsLabel')}
            value={tab}
            onChange={(next) => router.replace(`/exams/setup?tab=${next}`, { scroll: false })}
            options={TABS.map((k) => ({ value: k, label: t(`tab.${k}`) }))}
            testId="exams-setup-tabs"
          />
        </div>
        {tab === 'marks' ? (
          <SubjectMarksTab />
        ) : tab === 'teachers' ? (
          <SubjectTeachersTab />
        ) : tab === 'choices' ? (
          <SubjectChoicesTab />
        ) : tab === 'rooms' ? (
          <RoomsTab />
        ) : (
          <GradingTab />
        )}
      </div>
    </PageGate>
  );
}
