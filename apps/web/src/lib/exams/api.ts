'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useMeContext } from '@/lib/hooks';

/** GET an exams path, cached per institute; `null` waits. Every key starts with 'exams'. */
export function useExamQuery<T>(path: string | null, opts: { enabled?: boolean } = {}) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['exams', session?.tenant?.id, path],
    queryFn: () => client.api<T>(path!),
    enabled: path !== null && (opts.enabled ?? true),
  });
}

/** After an exams write every exams query is stale (lists, grids, results, the dashboard card). */
export function useInvalidateExams() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
    void queryClient.invalidateQueries({ queryKey: ['child-results'] });
  };
}

/** The exams API's refusals in the institute's words. */
export function useExamError() {
  const t = useTranslations('exams.common.errors');
  const describe = useErrorMessage();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      const known: Record<string, string> = {
        NOT_ASSIGNED: t('notAssigned'),
        SHEET_LOCKED: t('sheetLocked'),
        VERSION_CONFLICT: t('versionConflict'),
        ROSTER_CHANGED: t('rosterChanged'),
        INCOMPLETE: t('incomplete'),
        INVALID_MARKS: t('invalidMarks'),
        MARKS_EXIST: t('marksExist'),
        NOT_READY: t('notReady'),
        PUBLISH_CHANGED: t('publishChanged'),
        PREVIEW_CHANGED: t('previewChanged'),
        NOT_PUBLISHED: t('notPublished'),
        PUBLISHED: t('published'),
        OUTSIDE_YEAR: t('outsideYear'),
        NOT_IN_SETUP: t('notInSetup'),
        NOT_OPEN: t('notOpen'),
        CLASS_IN_USE: t('classInUse'),
        CAPACITY_SHORT: t('capacityShort'),
        NOT_STAFF: t('notStaff'),
        SUBJECT_NOT_IN_CLASS: t('subjectNotInClass'),
        NOT_ELECTIVE: t('notElective'),
        NOT_IN_SECTION: t('notInSection'),
        NOT_CLASS_TEACHER: t('notClassTeacher'),
        WRONG_STATUS: t('wrongStatus'),
        DUPLICATE: t('duplicate'),
        REFERENCE_CONFLICT: t('inUse'),
        IN_USE: t('inUse'),
        NO_CHANGE: t('noChange'),
      };
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 404) return t('notFound');
      if (e.status === 403) return t('forbidden');
      if (e.status === 400 || e.status === 422) return t('checkForm');
    }
    return describe(e);
  };
}

/** An exams write with the standard toasts; every exams query is refreshed after it. */
export function useExamMutation<I, O = unknown>(
  fn: (input: I) => Promise<O>,
  opts: {
    success?: string | ((out: O) => string);
    onSuccess?: (out: O, input: I) => void;
    onError?: (e: unknown) => void;
  } = {},
) {
  const invalidate = useInvalidateExams();
  const message = useExamError();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out, input) => {
      invalidate();
      const text = typeof opts.success === 'function' ? opts.success(out) : opts.success;
      if (text) toast.success(text);
      opts.onSuccess?.(out, input);
    },
    onError: (e) => {
      toast.error(message(e));
      opts.onError?.(e);
    },
  });
}

/** The caller's roles as the screens need them (the API decides; this only shapes the UI). */
export function useExamRoles() {
  const { data } = useMeContext();
  const roles = data?.roles ?? [];
  return {
    ready: !!data,
    isAdmin: roles.includes('OWNER') || roles.includes('ADMIN'),
    isTeacher: roles.includes('TEACHER'),
  };
}

/** A person's name in the UI language (Bangla first in bn, English first in en). */
export const nameIn = (
  x: { nameBn: string | null; nameEn: string | null },
  locale: string,
): string => (locale === 'bn' ? (x.nameBn ?? x.nameEn ?? '') : (x.nameEn ?? x.nameBn ?? ''));
