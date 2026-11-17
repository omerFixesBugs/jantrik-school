'use client';

import { NoticeForm } from '@/components/notices/notice-form';
import { ContextGate } from '@/components/page-gate';

/** A new notice (a draft until it is published from the list). */
export default function NewNoticePage() {
  return (
    <ContextGate allow={(c) => c.roles.includes('OWNER') || c.roles.includes('ADMIN')}>
      <NoticeForm />
    </ContextGate>
  );
}
