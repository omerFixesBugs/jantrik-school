'use client';

import { useQuery } from '@tanstack/react-query';
import type { FeeDueView, FeeGuardianView } from '@jantrik/shared';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';

/** One query per child, shared by the dashboard's summary and the fees page. */
export const childFeesKey = (tenantId: string | undefined, childId: string) =>
  ['child-fees', tenantId, childId] as const;

/** GET /me/children/:id/fees (404 for a child that is not the caller's). */
export function useChildFees(childId: string, enabled = true) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: childFeesKey(session?.tenant?.id, childId),
    queryFn: () => client.api<FeeGuardianView>(`/me/children/${childId}/fees`),
    enabled: enabled && Boolean(childId),
  });
}

/** Guardian fee screens show only to a guardian whose institute runs FEES (the API checks too). */
export function useGuardianFeesOn(): boolean | undefined {
  const { data } = useMeContext();
  if (!data) return undefined;
  return data.roles.includes('GUARDIAN') && data.modules.includes('FEES');
}

/** A due as a guardian reads it: still to pay (late or not), paid, or cancelled. */
export type DueState = 'OVERDUE' | 'OPEN' | 'PAID' | 'CANCELLED';

export function dueState(due: FeeDueView): DueState {
  if (due.status === 'CANCELLED') return 'CANCELLED';
  if (due.balance.total <= 0) return 'PAID';
  return due.overdue ? 'OVERDUE' : 'OPEN';
}

export const isOwed = (due: FeeDueView): boolean => {
  const s = dueState(due);
  return s === 'OVERDUE' || s === 'OPEN';
};

/** Dues named in this child's submissions still waiting to be checked. */
export function pendingDueIds(view: FeeGuardianView): Set<string> {
  return new Set(
    view.submissions.filter((s) => s.status === 'PENDING').flatMap((s) => s.dues.map((d) => d.id)),
  );
}

/** At most this many submissions wait per child (the API's TOO_MANY_PENDING). */
export const MAX_PENDING_PER_CHILD = 5;
/** At most this many dues in one submission (guardianSubmissionSchema). */
export const MAX_DUES_PER_SUBMISSION = 24;
