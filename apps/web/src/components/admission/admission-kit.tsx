'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AdmissionApplicationStatus,
  AdmissionCycleView,
  AdmissionOptions,
} from '@jantrik/shared';
import type { PillTone } from '@/components/kit/pill';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';

export const CYCLE_TONE: Record<AdmissionCycleView['status'], PillTone> = {
  DRAFT: 'neutral',
  OPEN: 'success',
  CLOSED: 'warning',
};

export const APPLICATION_TONE: Record<AdmissionApplicationStatus, PillTone> = {
  SUBMITTED: 'info',
  SHORTLISTED: 'accent',
  SELECTED: 'accent',
  WAITLISTED: 'warning',
  REJECTED: 'destructive',
  ADMITTED: 'success',
  WITHDRAWN: 'neutral',
};

export function useCycles() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['admission-cycles', session?.tenant?.id],
    queryFn: () => client.api<AdmissionCycleView[]>('/admission/cycles'),
  });
}

export function useAdmissionOptions() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['admission-options', session?.tenant?.id],
    queryFn: () => client.api<AdmissionOptions>('/admission/options'),
  });
}

/** Bangladesh has no daylight saving: Dhaka time is UTC+6 all year. */
const DHAKA_MS = 6 * 3600_000;

/** An ISO timestamp as a datetime-local value in Dhaka time ("2026-11-01T09:00"). */
export function toDhakaInput(iso: string): string {
  return new Date(Date.parse(iso) + DHAKA_MS).toISOString().slice(0, 16);
}

/** A datetime-local value typed in Dhaka time, as an ISO timestamp with its offset. */
export function fromDhakaInput(value: string): string {
  return `${value}:00+06:00`;
}

/** The error's API code, if any. */
export const errorCode = (e: unknown): string | null =>
  e instanceof ApiError ? ((e.body as { code?: string } | null)?.code ?? e.code ?? null) : null;
