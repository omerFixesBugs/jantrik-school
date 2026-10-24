'use client';

import { useLocale } from 'next-intl';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { useInvalidateExams } from './api';
import { MarkSheetController } from './sheet-controller';

/** One mark sheet on screen. The rules live in MarkSheetController; this binds it to React. */
export function useMarkSheet(examSubjectId: string, sectionId: string) {
  const { client, session } = useAuth();
  const invalidate = useInvalidateExams();
  const locale = useLocale() === 'en' ? 'en' : 'bn';
  const [controller] = useState(
    () =>
      new MarkSheetController({
        api: (path, init) => client.api(path, init),
        userId: session?.user.id ?? '',
        tenantId: session?.tenant?.id ?? '',
        examSubjectId,
        sectionId,
        locale,
        onSaved: () => invalidate(),
      }),
  );

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // Warn before leaving with marks the server does not have yet (they stay on the phone).
  const unsent = ['local', 'sending', 'retrying', 'conflict', 'roster-changed', 'error'].includes(
    state.sync.kind,
  );
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent]);

  return { ...state, controller, offline: !state.view && !!state.draft };
}
