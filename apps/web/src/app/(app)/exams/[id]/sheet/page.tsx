'use client';

import { ChevronLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { MarkEntry } from '@/components/exams/mark-entry';
import { SheetAdminActions } from '@/components/exams/sheet-admin-actions';
import { PageGate } from '@/components/page-gate';
import { useExamRoles } from '@/lib/exams/api';

/** Entering one subject's marks for one section (phone-first); admins also return, lock, correct. */
export default function SheetPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const t = useTranslations('exams.marks');
  const { isAdmin } = useExamRoles();
  const examSubjectId = params.get('subject') ?? '';
  const sectionId = params.get('section') ?? '';
  // After an admin action the sheet reloads from the server (a new controller).
  const [revision, setRevision] = useState(0);
  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <Link
          href={`/exams/${id}`}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) w-fit items-center gap-1 text-sm print:hidden"
        >
          <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
          {t('back')}
        </Link>
        {isAdmin && (
          <SheetAdminActions
            key={`a${revision}`}
            examSubjectId={examSubjectId}
            sectionId={sectionId}
            onChanged={() => setRevision((r) => r + 1)}
          />
        )}
        <MarkEntry key={`m${revision}`} examSubjectId={examSubjectId} sectionId={sectionId} />
      </div>
    </PageGate>
  );
}
