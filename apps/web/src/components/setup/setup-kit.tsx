'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EllipsisVerticalIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export type SetupTab =
  'years' | 'classes' | 'shifts' | 'subjects' | 'groups' | 'labels' | 'studentCode' | 'appearance';

const TABS: { key: SetupTab; href: string }[] = [
  { key: 'years', href: '/setup' },
  { key: 'classes', href: '/setup/classes' },
  { key: 'shifts', href: '/setup/shifts' },
  { key: 'subjects', href: '/setup/subjects' },
  { key: 'groups', href: '/setup/groups' },
  { key: 'labels', href: '/setup/labels' },
  { key: 'studentCode', href: '/setup/student-code' },
  // The institute's look is the owner's choice (shown to owners only).
  { key: 'appearance', href: '/setup/appearance' },
];

/** The setup area's pages, labelled with the institute's own words. Wraps on narrow phones. */
export function SetupTabs({ active }: { active: SetupTab }) {
  const t = useTranslations('setup');
  const label = useLabel();
  const { data: context } = useMeContext();
  const owner = context?.roles.includes('OWNER') ?? false;
  const text: Record<SetupTab, string> = {
    years: label('academic_year', 'Academic Year'),
    classes: t('tabClasses', {
      classLevel: label('class_level', 'Class'),
      section: label('section', 'Section', { inText: true }),
    }),
    shifts: label('shift', 'Shift'),
    subjects: t('tabSubjects'),
    groups: label('study_group', 'Group'),
    labels: t('tabLabels'),
    studentCode: t('tabStudentCode', { student: label('student', 'Student', { inText: true }) }),
    appearance: t('tabAppearance'),
  };
  return (
    <nav aria-label={t('title')}>
      <ul className="flex flex-wrap gap-2">
        {TABS.filter((tab) => tab.key !== 'appearance' || owner).map((tab) => (
          <li key={tab.key} className="min-w-0">
            <Link
              href={tab.href}
              aria-current={tab.key === active ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-(--control-h) max-w-full items-center rounded-full border px-4 text-sm font-medium transition-colors',
                'focus-visible:ring-ring focus-visible:ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                tab.key === active
                  ? 'bg-primary text-primary-foreground border-primary-ink'
                  : 'bg-card hover:border-primary/40',
              )}
            >
              {text[tab.key]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Page frame: gate (OWNER/ADMIN, CORE), heading, tabs. */
export function SetupPage({ tab, children }: { tab: SetupTab; children: ReactNode }) {
  return (
    <PageGate page="setup">
      {/* The page title is in the top bar. */}
      <div className="flex flex-col gap-5">
        <SetupTabs active={tab} />
        {children}
      </div>
    </PageGate>
  );
}

/** GET a setup list, cached per tenant. */
export function useSetupQuery<T>(path: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['setup', session?.tenant?.id, path],
    queryFn: () => client.api<T>(path!),
    enabled: path !== null,
  });
}

/** After a setup change: every setup list, plus things built from setup data elsewhere. */
export function useInvalidateSetup() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      'setup',
      'me-context',
      'student-filters',
      'attendance-my-sections',
      'attendance-report-today',
      'attendance-summary',
      'attendance-trend',
      'students',
      'students-total',
      'students-summary',
    ])
      void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

/** Error text for setup writes: IN_USE explains why, others as usual. */
export function useSetupErrorMessage() {
  const t = useTranslations('setup');
  const describe = useErrorMessage();
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.code === 'IN_USE') return t('errorInUse');
      if (error.code === 'INACTIVE') return t('errorInactive');
      if (error.code === 'CAPACITY_TOO_LOW') return t('errorCapacity');
      if (error.code === 'DUPLICATE') return t('errorDuplicate');
      if (error.code === 'REFERENCE_CONFLICT') return t('errorReference');
      if (error.status === 400) return t('errorCheckForm');
    }
    return describe(error);
  };
}

/** A setup write with the standard success/error handling. */
export function useSetupMutation<I, O = unknown>(
  fn: (input: I) => Promise<O>,
  opts: { success?: string; onSuccess?: (out: O) => void } = {},
) {
  const invalidate = useInvalidateSetup();
  const message = useSetupErrorMessage();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => {
      invalidate();
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(out);
    },
    onError: (e) => toast.error(message(e)),
  });
}

/**
 * Edit / deactivate / delete for one row. Delete is offered only when nothing uses the item;
 * otherwise the menu says why and offers deactivate.
 */
export function RowActions({
  name,
  active,
  inUse,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  name: string;
  active: boolean;
  inUse: boolean;
  onEdit: () => void;
  onToggleActive?: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('setup');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t('rowActions', { name })}>
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={onEdit}>
          <PencilIcon aria-hidden />
          {t('edit')}
        </DropdownMenuItem>
        {onToggleActive && (
          <DropdownMenuItem onClick={onToggleActive}>
            {active ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}
            {active ? t('deactivate') : t('activate')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onDelete} disabled={inUse} variant="destructive">
          <Trash2Icon aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span>{t('delete')}</span>
            {inUse && (
              <span className="text-muted-foreground text-xs font-normal">{t('inUseHint')}</span>
            )}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Delete X?" with a destructive confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  destructive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  const t = useTranslations('setup');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A dialog holding a form; scrolls inside itself on short phone screens. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  pending,
  submitLabel,
  onSubmit,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  pending?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const t = useTranslations('setup');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Open/close state for "edit this one" (null = closed, 'new' = create). */
export function useEditing<T>() {
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  return { editing, setEditing, close: () => setEditing(null) };
}
