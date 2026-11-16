'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage, useLabel } from '@/lib/hooks';

const KNOWN = new Set([
  'RUN_APPLYING',
  'RUN_EXISTS',
  'PREVIEW_CHANGED',
  'SECTION_FULL',
  'TARGET_INVALID',
  'MERIT_NEEDS_EXAMS',
  'MERIT_EXAM_INVALID',
  'NOTHING_TO_APPLY',
  'ROW_APPLIED',
  'ROLL_TAKEN',
  'YEAR_ORDER',
  'RUNS_PENDING',
  'RUN_HAS_APPLIED',
]);

/** The name in the page's language, the other one when it is missing. */
export function pick(
  locale: string,
  value: { nameBn?: string | null; nameEn?: string | null } | null | undefined,
): string {
  if (!value) return '';
  return (locale === 'bn' ? value.nameBn || value.nameEn : value.nameEn || value.nameBn) ?? '';
}

/** The message for a promotion error code (or the general one). */
export function usePromotionError() {
  const t = useTranslations('promotion.run.errors');
  const label = useLabel();
  const describe = useErrorMessage();
  return (e: unknown) =>
    e instanceof ApiError && e.code && KNOWN.has(e.code)
      ? t(e.code, { section: label('section', 'Section', { inText: true }) })
      : describe(e);
}

/** The reason a run stopped (`last_error`), in words. */
export function useStopReason() {
  const t = useTranslations('promotion.run.errors');
  const label = useLabel();
  return (code: string) => {
    const known = [...KNOWN, 'ACTOR_NOT_ADMIN', 'ERROR', 'TIMEOUT'];
    return known.includes(code)
      ? t(code, { section: label('section', 'Section', { inText: true }) })
      : t('ERROR');
  };
}

/**
 * A promotion write: on success the promotion queries (and setup lists) are fetched again and
 * `success` is shown; an error shows its message.
 */
export function usePromotionMutation<I, O>(
  fn: (input: I) => Promise<O>,
  opts: { success?: string; onSuccess?: (out: O) => void; onError?: (e: unknown) => void } = {},
) {
  const queryClient = useQueryClient();
  const message = usePromotionError();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => {
      for (const key of ['promotion', 'setup', 'me-context'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(out);
    },
    onError: (e) => {
      toast.error(message(e));
      opts.onError?.(e);
    },
  });
}
