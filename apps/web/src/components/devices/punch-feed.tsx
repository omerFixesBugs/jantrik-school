'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDayMonth,
  formatTime,
  localDateOf,
  type FeedPunch,
  type PunchFeed,
  type PunchFlag,
  type PunchReviewAction,
  type VerifyKind,
} from '@jantrik/shared';
import {
  CheckIcon,
  CircleHelpIcon,
  ClockIcon,
  CreditCardIcon,
  FingerprintIcon,
  GlobeLockIcon,
  InboxIcon,
  KeyRoundIcon,
  LayersIcon,
  LogInIcon,
  LogOutIcon,
  MoonIcon,
  ScanFaceIcon,
  ShieldCheckIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataColumn } from '@/components/data-table';
import { LoadError } from '@/components/fees/reports/kit';
import { SectionCard } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { FEED_POLL_MS, feedPath, mergePunches, pollCursor } from '@/lib/devices/feed';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { deviceKeys } from '@/lib/devices/keys';
import { Ascii, useDevicesError, usePunchPerson } from './kit';

const TIME_ZONE = 'Asia/Dhaka';
/** The flags an admin reviews; the clock flags only explain how a time was read. */
const REVIEW_FLAGS: PunchFlag[] = ['NEW_IP', 'OUTSIDE_HOURS', 'BURST'];
const NOTE_FLAGS: PunchFlag[] = ['CLOCK_CORRECTED', 'CLOCK_FUTURE', 'STALE'];
const FLAG_ICON: Partial<Record<PunchFlag, LucideIcon>> = {
  NEW_IP: GlobeLockIcon,
  OUTSIDE_HOURS: MoonIcon,
  BURST: LayersIcon,
};
const VERIFY_ICON: Record<VerifyKind, LucideIcon> = {
  FINGERPRINT: FingerprintIcon,
  CARD: CreditCardIcon,
  FACE: ScanFaceIcon,
  PASSWORD: KeyRoundIcon,
  OTHER: CircleHelpIcon,
};

/** A flagged punch nobody has looked at yet. */
const needsReview = (p: FeedPunch) =>
  p.review === null && p.flags.some((f) => REVIEW_FLAGS.includes(f));

/**
 * The last 50 punches (all, or the flagged ones not yet reviewed), polled every 5 s while the page
 * is visible and `enabled` (there are devices). Each poll asks only for what arrived since a minute
 * before the newest row and merges it in by id (lib/devices/feed.ts); `reload` starts again from
 * scratch.
 */
export function usePunchFeed(flagged: boolean, enabled = true) {
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = deviceKeys.punches(session?.tenant?.id, flagged);
  const fresh = useRef(false);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const replace = fresh.current;
      fresh.current = false;
      const held = () => queryClient.getQueryData<FeedPunch[]>(key) ?? [];
      const after = replace ? undefined : pollCursor(held());
      const page = await client.api<PunchFeed>(feedPath({ flagged, after }));
      // Merged into the rows as they are now: a review made while this poll was on its way has
      // already changed them, and an answer read before it never undoes it.
      return mergePunches(held(), page.punches, { replace });
    },
    enabled,
    refetchInterval: FEED_POLL_MS,
    refetchIntervalInBackground: false,
    // A view left and opened again starts fresh (no merging into an old list).
    gcTime: 0,
  });
  const { refetch } = query;
  const reload = useCallback(() => {
    fresh.current = true;
    void refetch();
  }, [refetch]);
  return { query, reload };
}

/** The live feed card: all or flagged, rows newest first, review actions on flagged rows. */
export function LiveFeed({
  feed,
  flagged,
  onFlaggedChange,
  ref,
}: {
  feed: ReturnType<typeof usePunchFeed>;
  flagged: boolean;
  onFlaggedChange: (flagged: boolean) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const t = useTranslations('devices.devices.feed');
  const tCommon = useTranslations('common');
  const wide = useMediaQuery('(min-width: 1024px)');
  const { query } = feed;
  const punches = query.data;
  return (
    <div ref={ref} className="scroll-mt-24">
      <SectionCard
        id="device-feed"
        title={t('title')}
        hint={t('hint')}
        actions={
          <SegmentedControl
            label={t('viewLabel')}
            value={flagged ? 'flagged' : 'all'}
            onChange={(v) => onFlaggedChange(v === 'flagged')}
            options={[
              { value: 'all', label: t('viewAll') },
              { value: 'flagged', label: t('viewFlagged') },
            ]}
            testId="feed-view"
          />
        }
      >
        {punches === undefined ? (
          query.isError ? (
            <LoadError error={query.error} onRetry={feed.reload} />
          ) : (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label={tCommon('loading')}>
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          )
        ) : punches.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 py-8 text-center"
            data-testid="feed-empty"
          >
            <InboxIcon aria-hidden className="text-muted-foreground size-8" />
            <p className="font-medium">{flagged ? t('emptyFlagged') : t('empty')}</p>
            <p className="text-muted-foreground max-w-md text-sm">
              {flagged ? t('emptyFlaggedHint') : t('emptyHint')}
            </p>
          </div>
        ) : (
          <>
            {query.isError && (
              <p className="text-warning text-sm" role="status">
                {t('pollFailed')}
              </p>
            )}
            {wide ? <FeedTable punches={punches} /> : <FeedCards punches={punches} />}
          </>
        )}
      </SectionCard>
    </div>
  );
}

function useFeedParts() {
  const t = useTranslations('devices.devices');
  const locale = useLocale() as Locale;
  const person = usePunchPerson();
  const today = localDateOf(new Date(), TIME_ZONE);
  const time = (p: FeedPunch) =>
    p.localDate === today
      ? formatTime(p.punchedAt, locale)
      : `${formatDayMonth(p.punchedAt, locale)}, ${formatTime(p.punchedAt, locale)}`;
  const who = (p: FeedPunch) => {
    if (!p.person) {
      return (
        <Link
          href={`/attendance/devices/people?unknown=${encodeURIComponent(p.deviceUserId)}`}
          // 44 px tall on touch screens (--touch-min), the text's own height on a desk.
          className="text-link inline-flex min-h-(--touch-min) items-center font-medium underline-offset-4 hover:underline"
          data-testid="feed-unknown"
        >
          {/* One flex item, so the space before the ID stays. */}
          <span>
            {t.rich('feed.unknownId', {
              id: p.deviceUserId,
              v: () => <Ascii value={p.deviceUserId} />,
            })}
          </span>
        </Link>
      );
    }
    const { name, detail, code } = person(p.person);
    return (
      <div className="flex min-w-0 flex-col">
        <span className={cn('font-medium break-words', p.review === 'REJECTED' && 'line-through')}>
          {name}
        </span>
        <span className="text-muted-foreground text-sm">
          {detail}
          {code && (
            <>
              {' · '}
              <Ascii value={code} className="whitespace-nowrap" />
            </>
          )}
        </span>
      </div>
    );
  };
  const how = (p: FeedPunch) => {
    const Dir = p.direction === 'IN' ? LogInIcon : LogOutIcon;
    const Verify = VERIFY_ICON[p.verifyKind];
    return (
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-foreground inline-flex items-center gap-1">
          <Dir aria-hidden className="size-4" />
          {t(`punchDirection.${p.direction}`)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Verify aria-hidden className="size-4" />
          {t(`verify.${p.verifyKind}`)}
        </span>
      </span>
    );
  };
  const chips = (p: FeedPunch) => {
    const notes = p.flags.filter((f) => NOTE_FLAGS.includes(f));
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex flex-wrap gap-1">
          {p.arrival === 'LATE' && (
            <Pill tone="warning">
              <ClockIcon aria-hidden className="size-3.5" />
              {t('feed.late')}
            </Pill>
          )}
          {p.flags
            .filter((f) => REVIEW_FLAGS.includes(f))
            .map((f) => {
              const Icon = FLAG_ICON[f]!;
              return (
                <Pill key={f} tone="warning">
                  <Icon aria-hidden className="size-3.5" />
                  {t(`flag.${f}`)}
                </Pill>
              );
            })}
          {p.review && <ReviewPill review={p.review} />}
        </div>
        {notes.map((f) => (
          <span key={f} className="text-muted-foreground text-xs">
            {t(`flag.${f}`)}
          </span>
        ))}
      </div>
    );
  };
  return { time, who, how, chips };
}

function ReviewPill({ review }: { review: NonNullable<FeedPunch['review']> }) {
  const t = useTranslations('devices.devices.review');
  if (review === 'REJECTED') {
    return (
      <Pill tone="destructive">
        <XIcon aria-hidden className="size-3.5" />
        {t('REJECTED')}
      </Pill>
    );
  }
  return (
    <Pill tone="success">
      {review === 'OK' ? (
        <CheckIcon aria-hidden className="size-3.5" />
      ) : (
        <ShieldCheckIcon aria-hidden className="size-3.5" />
      )}
      {t(review)}
    </Pill>
  );
}

function FeedTable({ punches }: { punches: FeedPunch[] }) {
  const t = useTranslations('devices.devices.feed');
  const { time, who, how, chips } = useFeedParts();
  const columns: DataColumn<FeedPunch>[] = [
    {
      id: 'time',
      header: t('colTime'),
      cell: (p) => <span className="font-numeric whitespace-nowrap">{time(p)}</span>,
    },
    { id: 'person', header: t('colPerson'), cell: who },
    {
      id: 'id',
      header: t('colId'),
      cell: (p) => <Ascii value={p.deviceUserId} className="text-muted-foreground" />,
    },
    {
      id: 'device',
      header: t('colDevice'),
      cell: (p) => (
        <div className="flex flex-col">
          <span className="whitespace-nowrap">{p.device.name}</span>
          {p.device.gate && <span className="text-muted-foreground text-sm">{p.device.gate}</span>}
        </div>
      ),
    },
    { id: 'how', header: t('colHow'), cell: how },
    { id: 'status', header: t('colStatus'), cell: chips },
    { id: 'review', header: t('colReview'), cell: (p) => <ReviewActions punch={p} /> },
  ];
  return (
    <DataTable
      testId="feed-table"
      caption={t('title')}
      columns={columns}
      rows={punches}
      rowKey={(p) => p.id}
      // Edge to edge inside the card: one surface, the rows divided by hairlines.
      className="-mx-(--panel-p) rounded-none border-x-0 border-b-0 shadow-none"
    />
  );
}

function FeedCards({ punches }: { punches: FeedPunch[] }) {
  const { time, who, how, chips } = useFeedParts();
  return (
    <ul className="-mx-(--panel-p) flex flex-col divide-y border-y" data-testid="feed-cards">
      {punches.map((p) => (
        <li key={p.id} className="flex gap-3 px-(--panel-p) py-3" data-testid="feed-row">
          <span className="font-numeric text-muted-foreground w-20 shrink-0 pt-0.5 text-sm">
            {time(p)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {who(p)}
            <span className="text-muted-foreground text-sm">
              {p.device.name}
              {p.device.gate && ` · ${p.device.gate}`}
              {' · '}
              <Ascii value={p.deviceUserId} />
            </span>
            {how(p)}
            {chips(p)}
            <ReviewActions punch={p} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** OK, accept (a held BURST punch only) and reject (after a confirm) for a flagged punch. */
function ReviewActions({ punch }: { punch: FeedPunch }) {
  const t = useTranslations('devices.devices.review');
  const message = useDevicesError();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const review = useMutation({
    mutationFn: (action: PunchReviewAction) =>
      client.api<FeedPunch>(`/attendance/devices/punches/${punch.id}/review`, {
        method: 'POST',
        json: { action },
      }),
    onSuccess: (next, action) => {
      setConfirming(false);
      // The row changes in place in both views; the alerts' counts move.
      const tenantId = session?.tenant?.id;
      for (const flagged of [false, true]) {
        queryClient.setQueryData<FeedPunch[]>(deviceKeys.punches(tenantId, flagged), (rows) =>
          rows?.map((p) => (p.id === next.id ? next : p)),
        );
      }
      void queryClient.invalidateQueries({ queryKey: deviceKeys.alerts(tenantId) });
      toast.success(t(`done${action}`));
    },
    onError: (e) => toast.error(message(e)),
  });
  if (!needsReview(punch)) return null;
  const held = punch.flags.includes('BURST');
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="review-actions">
      <Button
        size="sm"
        variant="outline"
        disabled={review.isPending}
        onClick={() => review.mutate('OK')}
        data-testid="review-ok"
      >
        <CheckIcon aria-hidden />
        {t('ok')}
      </Button>
      {held && (
        <Button
          size="sm"
          disabled={review.isPending}
          onClick={() => review.mutate('ACCEPT')}
          data-testid="review-accept"
        >
          <ShieldCheckIcon aria-hidden />
          {t('accept')}
        </Button>
      )}
      <Button
        size="sm"
        variant="destructive"
        disabled={review.isPending}
        onClick={() => setConfirming(true)}
        data-testid="review-reject"
      >
        <XIcon aria-hidden />
        {t('reject')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('rejectTitle')}
        body={t('rejectBody')}
        confirmLabel={t('rejectConfirm')}
        cancelLabel={t('rejectKeep')}
        pending={review.isPending}
        onConfirm={() => review.mutate('REJECT')}
      />
    </div>
  );
}
