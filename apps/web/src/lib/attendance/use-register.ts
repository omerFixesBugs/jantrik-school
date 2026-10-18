'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { AttendanceStatus, IsoDate } from '@jantrik/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { RegisterController } from './register-controller';

interface Options {
  sectionId: string;
  periodNo: number;
  date?: IsoDate;
  sectionName: string;
}

/** One register on screen. The rules live in RegisterController; this binds it to React. */
export function useRegister({ sectionId, periodNo, date, sectionName }: Options) {
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const userId = session?.user.id ?? '';
  const tenantId = session?.tenant?.id ?? '';

  // A new controller per register (section, period, date).
  const [controller] = useState(
    () =>
      new RegisterController({
        api: (path, init) => client.api(path, init),
        userId,
        tenantId,
        sectionId,
        periodNo,
        date,
        sectionName,
        onSaved: () => {
          void queryClient.invalidateQueries({ queryKey: ['attendance-my-sections'] });
          void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
        },
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

  const counts = useMemo(() => {
    const c: Record<AttendanceStatus, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, LEAVE: 0 };
    for (const st of state.draft?.roster ?? []) c[state.draft!.statuses[st.id] ?? 'PRESENT'] += 1;
    return c;
  }, [state.draft]);

  // Warn before leaving with work the server does not have yet (the draft stays on the phone).
  const unsent = ['local', 'sending', 'retrying', 'conflict', 'roster-changed', 'error'].includes(
    state.sync.kind,
  );
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent]);

  return { ...state, counts, controller, offline: !state.sheet && !!state.draft };
}
