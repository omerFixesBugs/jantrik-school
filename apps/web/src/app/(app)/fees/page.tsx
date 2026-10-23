'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatCount, formatIdentifier, toAsciiDigits, type FeeStudentHit } from '@jantrik/shared';
import {
  ChevronRightIcon,
  ReceiptTextIcon,
  SearchIcon,
  SearchXIcon,
  UserSearchIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  EmptyState,
  feeKeys,
  LoadError,
  phoneText,
  StudentStatusPill,
  usePlace,
} from '@/components/fees/counter/kit';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { Button, ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, useFeeRoles } from '@/lib/fees';
import { useDebounced, useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';

/** The API returns at most this many hits (fee-students.service.ts). */
const HIT_LIMIT = 20;

export default function FeesCounterPage() {
  return (
    <PageGate page="fees">
      <div className="flex flex-col gap-(--section-gap)">
        <FeesTabs />
        {/* The search lives in the URL (useSearchParams): Back from a ledger returns to it. */}
        <Suspense>
          <CounterSearch />
        </Suspense>
      </div>
    </PageGate>
  );
}

/**
 * The fee counter (docs/fees.md → Collecting cash), phone-first: one big search by name, student
 * ID or guardian phone (Bangla digits typed are searched as ASCII), then a card per student that
 * opens their ledger. The accountant sees guardian phones masked and searches a phone only by the
 * whole number (decision #19).
 */
function CounterSearch() {
  const t = useTranslations('fees.counter.search');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const router = useRouter();
  const { client, session } = useAuth();
  const { manages } = useFeeRoles();
  const { params, set } = useUrlParams();
  const [text, setText] = useState(() => params.get('q') ?? '');
  const typed = text.trim();
  const settled = useDebounced(typed, 300);
  const term = toAsciiDigits(settled);
  const input = useRef<HTMLInputElement>(null);

  // The settled search goes into the address (replace, not a new history entry).
  useEffect(() => {
    set({ q: settled || null });
  }, [settled, set]);

  // A desk keyboard starts typing at once; a phone keeps its keyboard down until tapped.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);

  const search = useQuery({
    queryKey: feeKeys.search(session?.tenant?.id, term),
    queryFn: () => client.api<FeeStudentHit[]>(`/fees/students?q=${encodeURIComponent(term)}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const hits = term ? (search.data ?? []) : [];
  const waiting = typed !== settled || search.isFetching;

  const clear = () => {
    setText('');
    input.current?.focus();
  };

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <div role="search" aria-label={t('label')} className="flex flex-col gap-1.5">
        <Label htmlFor="fees-search" className="text-base font-semibold">
          {t('label')}
        </Label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2"
          />
          <Input
            ref={input}
            id="fees-search"
            type="search"
            inputMode="search"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={80}
            placeholder={t('placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // One match: Enter opens it, the way a counter works through a queue.
              if (e.key === 'Enter' && !waiting && hits.length === 1) {
                router.push(`/fees/students/${hits[0]!.id}`);
              }
            }}
            aria-describedby="fees-search-hint"
            data-testid="fees-search"
            data-page-search
            className="h-14 rounded-full ps-12 pe-14 text-lg [&::-webkit-search-cancel-button]:appearance-none"
          />
          {text && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clear}
              aria-label={t('clear')}
              className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-full"
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </div>
        <p id="fees-search-hint" className="text-muted-foreground text-sm">
          {t('hint')}
          {!manages && <> {t('hintMasked')}</>}
        </p>
      </div>

      {!typed || !term ? (
        <EmptyState
          icon={UserSearchIcon}
          title={t('startTitle')}
          text={t('startText')}
          testId="fees-search-start"
          action={
            <ButtonLink href="/fees/closing" variant="outline" className="mt-1">
              <ReceiptTextIcon aria-hidden />
              {t('closingLink')}
            </ButtonLink>
          }
        />
      ) : search.isPending ? (
        <ul className="grid gap-(--gap) md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i}>
              <Skeleton className="rounded-card h-28 w-full" />
            </li>
          ))}
          <li className="sr-only">{t('searching')}</li>
        </ul>
      ) : search.isError ? (
        <LoadError
          message={`${t('loadFailed')} ${describe(search.error)}`}
          onRetry={() => void search.refetch()}
        />
      ) : hits.length === 0 ? (
        <EmptyState
          icon={SearchXIcon}
          title={t('noneTitle', { q: settled })}
          text={t('noneText')}
          testId="fees-search-empty"
          action={
            <Button variant="outline" className="mt-1" onClick={clear}>
              <XIcon aria-hidden />
              {t('clear')}
            </Button>
          }
        />
      ) : (
        <section aria-label={t('results')} className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {hits.length >= HIT_LIMIT
              ? t('foundMany', { count: formatCount(hits.length, locale) })
              : t('found', { count: formatCount(hits.length, locale), n: hits.length })}
          </p>
          <ul
            className={cn(
              'grid gap-(--gap) transition-opacity md:grid-cols-2 xl:grid-cols-3',
              waiting && 'opacity-70',
            )}
            data-testid="fees-hits"
          >
            {hits.map((s) => (
              <li key={s.id}>
                <HitCard student={s} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One student found: the whole card opens their ledger. IDs, rolls and phones stay ASCII. */
function HitCard({ student: s }: { student: FeeStudentHit }) {
  const t = useTranslations('fees.counter.search');
  const locale = useLocale() as Locale;
  const place = usePlace();
  const name = pick(locale, s);
  const g = s.guardian;
  return (
    <Link
      href={`/fees/students/${s.id}`}
      data-testid="fees-hit"
      data-code={s.studentCode}
      data-slot="card"
      className="bg-card rounded-card shadow-card lift focus-visible:ring-ring flex h-full items-center gap-3 border p-(--panel-p) outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    >
      <PersonAvatar name={name} size="lg" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate py-0.5 leading-snug font-semibold">{name}</span>
          <StudentStatusPill status={s.status} />
        </span>
        <span className="text-muted-foreground truncate text-sm">{place(s.enrolment, locale)}</span>
        <span className="text-muted-foreground text-sm">
          {t('id')}{' '}
          <span className="text-foreground font-medium tabular-nums" dir="ltr">
            {formatIdentifier(s.studentCode)}
          </span>
        </span>
        {g && (
          <span className="text-muted-foreground flex min-w-0 gap-1.5 text-sm">
            <span className="min-w-0 truncate">{pick(locale, g) || t('guardian')}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums" dir="ltr">
              {phoneText(g.phone)}
            </span>
          </span>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden
        className="text-muted-foreground size-5 shrink-0 rtl:rotate-180"
      />
    </Link>
  );
}
