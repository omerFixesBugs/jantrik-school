'use client';

import type { InstituteStatus, PlatformOwnerStatus } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/hooks';

const STATUS_VARIANT = {
  TRIAL: 'soft',
  ACTIVE: 'success',
  SUSPENDED: 'destructive',
  ARCHIVED: 'secondary',
} as const;

/** An institute's status as a pill with a dot (never colour alone). */
export function InstituteStatusBadge({
  status,
  trialEnded = false,
}: {
  status: InstituteStatus;
  trialEnded?: boolean;
}) {
  const t = useTranslations('platformInstitutes');
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={STATUS_VARIANT[status]} data-testid="institute-status">
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {t(`status_${status}`)}
      </Badge>
      {trialEnded && <Badge variant="warning">{t('trialEnded')}</Badge>}
    </span>
  );
}

const OWNER_VARIANT = {
  ACTIVE: 'success',
  INVITED: 'soft',
  EXPIRED: 'warning',
  DECLINED: 'destructive',
  DISABLED: 'secondary',
} as const;

export function OwnerStatusBadge({ status }: { status: PlatformOwnerStatus }) {
  const t = useTranslations('platformInstitutes');
  return (
    <Badge variant={OWNER_VARIANT[status]} data-testid="owner-status">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t(`owner_${status}`)}
    </Badge>
  );
}

/** API refusals on the platform institute screens, in the reader's language. */
export function usePlatformError() {
  const t = useTranslations('platformInstitutes');
  const describe = useErrorMessage();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      const known: Record<string, string> = {
        SLUG_TAKEN: t('errorSlugTaken'),
        UNKNOWN_INSTITUTE_TYPE: t('errorType'),
        ALREADY_STAFF: t('errorAlreadyStaff'),
        INSTITUTE_HAS_OWNER: t('errorHasOwner'),
        OWNER_INVITED: t('errorOwnerInvited'),
        NOT_REINVITABLE: t('errorNotReinvitable'),
        NOT_INVITED: t('errorNotInvited'),
        BAD_STATUS: t('errorBadStatus'),
        REASON_REQUIRED: t('errorReason'),
      };
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 400) return t('errorCheckForm');
      if (e.status === 404) return t('errorNotFound');
    }
    return describe(e);
  };
}

/** Field paths a 400 (zod) or a known 409/422 points at, e.g. `owner.phone` or `slug`. */
export function fieldErrorsOf(e: unknown): Set<string> {
  const out = new Set<string>();
  if (!(e instanceof ApiError)) return out;
  const body = e.body as { errors?: { path: string }[]; field?: string } | null;
  for (const x of body?.errors ?? []) out.add(x.path);
  if (body?.field) out.add(body.field);
  return out;
}

/** "120.50" (taka, as typed) → 12050 paisa; null when empty or not a number. */
export function takaToPaisa(value: string): number | null {
  const v = value.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

export const paisaToTaka = (paisa: number): string =>
  paisa % 100 === 0 ? String(paisa / 100) : (paisa / 100).toFixed(2);

/** "50" → 50; "" → null (no limit); anything else → undefined (invalid). */
export function parseLimit(value: string, min: number): number | null | undefined {
  const v = value.trim();
  if (v === '') return null;
  if (!/^\d{1,7}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= min && n <= 1_000_000 ? n : undefined;
}
