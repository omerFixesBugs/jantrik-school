'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toAsciiDigits, toBanglaDigits, type SetupAcademicYear } from '@jantrik/shared';
import { RotateCcwIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { FormEvent, ReactNode } from 'react';
import { toast } from 'sonner';
import { SelectField } from '@/components/form-kit';
import { useSetupQuery } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * Pieces shared by the fee setup sections (OWNER/ADMIN): queries, errors, the settings row
 * (label and help on the start side, the control on the end side: docs/design.md → Layout),
 * dialogs and the year picker.
 */

/** GET a fee setup path, cached per institute. `null` waits. */
export function useFeeQuery<T>(path: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['fees-setup', session?.tenant?.id, path],
    queryFn: () => client.api<T>(path!),
    enabled: path !== null,
  });
}

/** After a fee write: every fee query (setup, ledgers, reports) is stale. */
export function useInvalidateFees() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('fees'),
    });
}

/** The fee setup API's errors in the institute's words. */
export function useFeeSetupError() {
  const t = useTranslations('fees.setup.errors');
  const describe = useErrorMessage();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      const known: Record<string, string> = {
        DUPLICATE: t('duplicate'),
        NO_CURRENT_YEAR: t('noCurrentYear'),
        INVALID_HEAD: t('invalidHead'),
        INVALID_TERM: t('invalidTerm'),
        CONCESSION_OVERLAP: t('concessionOverlap'),
        ALREADY_ENDED: t('alreadyEnded'),
        INVALID_END: t('invalidEnd'),
        DIFFERENT_FAMILIES: t('differentFamilies'),
        REFERENCE_CONFLICT: t('inUse'),
        IN_USE: t('inUse'),
      };
      if (e.code && known[e.code]) return known[e.code]!;
      if (e.status === 404) return t('notFound');
      if (e.status === 403) return t('forbidden');
      if (e.status === 400 || e.status === 422) return t('checkForm');
    }
    return describe(e);
  };
}

/**
 * The fields a refused write names: zod paths of a 400 ("fine.capPaisa"), `fields` of a 422 and
 * `field` of a 409 DUPLICATE.
 */
export function fieldsFromError(e: unknown): Set<string> {
  const out = new Set<string>();
  if (!(e instanceof ApiError)) return out;
  const body = e.body as {
    errors?: { path: string }[];
    fields?: string[];
    field?: string;
  } | null;
  for (const x of body?.errors ?? []) out.add(x.path);
  for (const f of body?.fields ?? []) out.add(f);
  if (body?.field) out.add(body.field);
  return out;
}

/** A fee write with the standard toasts; every fee query is refreshed after it. */
export function useFeeMutation<I, O = unknown>(
  fn: (input: I) => Promise<O>,
  opts: {
    success?: string | ((out: O) => string);
    onSuccess?: (out: O, input: I) => void;
    onError?: (e: unknown) => void;
  } = {},
) {
  const invalidate = useInvalidateFees();
  const message = useFeeSetupError();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out, input) => {
      void invalidate();
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

/** A number typed with Bangla or ASCII digits → a whole number, or null. */
export function parseWhole(text: string): number | null {
  const ascii = toAsciiDigits(text).trim();
  return /^\d{1,6}$/.test(ascii) ? Number(ascii) : null;
}

/** Digits as the UI language writes them (for numbers shown inside inputs). */
export const localDigits = (text: string, locale: string) =>
  locale === 'bn' ? toBanglaDigits(text) : text;

/** Ordinals for ranks and "from the nth child" (1–10, words; beyond that the number). */
export function useOrdinal() {
  const t = useTranslations('fees.setup.ordinal');
  return (n: number) => (n >= 1 && n <= 10 ? t(String(n) as '1') : String(n));
}

/**
 * One setting: its label and help on the start side, the control on the end side (stacked on a
 * phone). `labelFor` ties the label to a single input; a group of controls uses `${id}-label`.
 */
export function SettingRow({
  id,
  label,
  hint,
  labelFor,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  labelFor?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="grid gap-x-8 gap-y-3 border-t pt-4 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
      data-testid={id}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {labelFor ? (
          <label htmlFor={labelFor} id={`${id}-label`} className="font-medium">
            {label}
          </label>
        ) : (
          <p id={`${id}-label`} className="font-medium">
            {label}
          </p>
        )}
        {hint && (
          <div id={`${id}-hint`} className="text-muted-foreground max-w-prose text-sm">
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A native select without its own label (the settings row labels it). */
export function NativeSelect({
  id,
  value,
  onChange,
  options,
  className,
  ...aria
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'border-input bg-card h-(--control-h) w-full min-w-0 rounded-md border ps-2.5 pe-2 text-(length:--input-fs) outline-none',
        'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
        className,
      )}
      {...aria}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** An on/off switch that says its state in words beside it (status is never colour alone). */
export function Switch({
  id,
  checked,
  onChange,
  labelledBy,
  describedBy,
  testId,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  testId?: string;
}) {
  const t = useTranslations('fees.setup.kit');
  return (
    <label
      htmlFor={id}
      className="has-[:focus-visible]:ring-ring inline-flex min-h-(--control-h) cursor-pointer items-center gap-3 rounded-md pe-2 has-[:focus-visible]:ring-3"
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="peer sr-only"
        data-testid={testId}
      />
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
          checked ? 'bg-primary border-primary' : 'bg-muted border-input',
        )}
      >
        <span
          className={cn(
            'bg-card size-5 rounded-full shadow-sm transition-transform',
            checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5',
          )}
        />
      </span>
      <span className="text-sm font-medium">{checked ? t('on') : t('off')}</span>
    </label>
  );
}

/** A dialog holding a form; scrolls inside itself on short phone screens. */
export function FeeDialog({
  onClose,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  children,
  testId,
  submitTestId,
  wide,
  destructive,
}: {
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  pending?: boolean;
  onSubmit: () => void;
  children: ReactNode;
  testId?: string;
  submitTestId?: string;
  wide?: boolean;
  destructive?: boolean;
}) {
  const t = useTranslations('fees.setup.kit');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
        data-testid={testId}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={pending}
              data-testid={submitTestId}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Are you sure?" before anything that changes money; says what will happen. */
export function FeeConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
  destructive,
  confirmTestId,
  children,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  destructive?: boolean;
  confirmTestId?: string;
  children?: ReactNode;
}) {
  const t = useTranslations('fees.setup.kit');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="fees-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One sentence on what is empty, one on what to do, and the action (docs/design.md). */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center"
      data-testid={testId}
    >
      <span className="bg-primary-soft text-primary-ink flex size-11 items-center justify-center rounded-xl">
        <Icon aria-hidden className="size-5" />
      </span>
      <p className="font-medium">{title}</p>
      {text && <p className="text-muted-foreground max-w-prose text-sm">{text}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A part that failed to load: what happened, and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('fees.setup.kit');
  const message = useFeeSetupError();
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message(error)}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcwIcon aria-hidden />
          {t('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The institute's academic years, the current one first in mind. */
export function useAcademicYears() {
  return useSetupQuery<SetupAcademicYear[]>('/setup/academic-years');
}

/** Pick an academic year (the current one is marked). */
export function YearSelect({
  id,
  years,
  value,
  onChange,
  className,
  disabled,
  hint,
}: {
  id: string;
  years: SetupAcademicYear[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  disabled?: boolean;
  hint?: string;
}) {
  const t = useTranslations('fees.setup.kit');
  return (
    <SelectField
      id={id}
      label={t('year')}
      value={value}
      onChange={onChange}
      className={className}
      disabled={disabled}
      hint={hint}
      options={years.map((y) => ({
        value: y.id,
        label: y.isCurrent ? t('currentYear', { name: y.name }) : y.name,
      }))}
    />
  );
}
