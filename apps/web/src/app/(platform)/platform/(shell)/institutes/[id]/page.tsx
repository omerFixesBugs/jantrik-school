'use client';

import {
  PLATFORM_MODULES,
  addMonths,
  formatBdPhone,
  formatCount,
  formatDate,
  formatMonth,
  formatTaka,
  normalizeBdPhone,
  type IsoDate,
  type PlatformInstituteDetail,
  type PlatformInvoicePage,
  type PlatformInstituteOwner,
  type PlatformModule,
} from '@jantrik/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIcon,
  ArrowLeftIcon,
  BadgeCheckIcon,
  CheckIcon,
  GraduationCapIcon,
  PencilIcon,
  MessageSquareTextIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  SendIcon,
  UploadIcon,
  UserPlusIcon,
  UsersIcon,
  XCircleIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, SectionCard, SelectField, TextField } from '@/components/form-kit';
import { InvoiceDialog, InvoiceList } from '@/components/platform/billing-kit';
import {
  InstituteStatusBadge,
  OwnerStatusBadge,
  calendarDate,
  fieldErrorsOf,
  parseLimit,
  usePlatformError,
} from '@/components/platform/institute-kit';
import {
  PlanFields,
  newPlanForm,
  planFormOf,
  planFromForm,
  type PlanForm,
} from '@/components/platform/plan-fields';
import { FormDialog } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DateInput } from '@/components/date-input';
import type { Locale } from '@/i18n/config';
import { usePlatformToday } from '@/lib/platform/hooks';
import { platformApi } from '@/lib/platform/platform-api';

const textareaClass =
  'min-h-24 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive dark:bg-input/30';

/** One institute from the platform side: metadata, usage counts and the platform's controls. */
export default function PlatformInstitutePage() {
  const t = useTranslations('platformInstitutes');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['platform-institute', id],
    queryFn: () => platformApi<PlatformInstituteDetail>(`/platform/institutes/${id}`),
  });

  if (q.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (q.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertDescription>{explain(q.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const d = q.data;
  const typeName = locale === 'bn' ? d.type.nameBn : d.type.nameEn;
  return (
    <div className="flex flex-col gap-5" data-testid="institute-detail">
      <div className="flex flex-col gap-2">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold break-words">{d.name}</h1>
          <InstituteStatusBadge status={d.status} trialEnded={d.trialEnded} />
        </div>
        <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <span dir="ltr">{d.slug}</span>
          <span>{typeName}</span>
          <span>
            {t('createdOn', { date: formatDate(new Date(d.createdAt), locale, 'medium') })}
          </span>
        </p>
      </div>

      {d.status === 'SUSPENDED' && (
        <Alert variant="destructive" data-testid="institute-suspended">
          <PauseCircleIcon aria-hidden />
          <AlertDescription>
            {t('suspendedAlert', {
              date: d.suspendedAt ? formatDate(new Date(d.suspendedAt), locale, 'medium') : '—',
            })}
          </AlertDescription>
        </Alert>
      )}
      {d.trialEnded && d.subscription?.trialEndsOn && (
        <Alert data-testid="institute-trial-ended">
          <AlertDescription>
            {t('trialEndedAlert', {
              date: formatDate(calendarDate(d.subscription.trialEndsOn), locale, 'medium'),
            })}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
          <Usage d={d} locale={locale} />
          <Owners d={d} locale={locale} />
          <Modules d={d} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Status d={d} />
          <Plan d={d} locale={locale} />
          <Billing d={d} locale={locale} />
          <Limits d={d} />
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  const t = useTranslations('platformInstitutes');
  return (
    <Link
      href="/platform/institutes"
      className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
    >
      <ArrowLeftIcon aria-hidden className="size-4" />
      {t('backToList')}
    </Link>
  );
}

/** A platform action on this institute: the response is the new detail. */
function useInstituteAction<V>(
  id: string,
  request: (vars: V) => Promise<PlatformInstituteDetail>,
  done: string,
  onDone?: () => void,
) {
  const queryClient = useQueryClient();
  const explain = usePlatformError();
  return useMutation({
    mutationFn: request,
    onSuccess: (detail) => {
      queryClient.setQueryData(['platform-institute', id], detail);
      void queryClient.invalidateQueries({ queryKey: ['platform-institutes'] });
      toast.success(done);
      onDone?.();
    },
    onError: (e) => toast.error(explain(e)),
  });
}

function Usage({ d, locale }: { d: PlatformInstituteDetail; locale: Locale }) {
  const t = useTranslations('platformInstitutes');
  const c = d.counts;
  const items = [
    {
      icon: GraduationCapIcon,
      label: t('activeStudents'),
      value: formatCount(c.activeStudents, locale),
    },
    { icon: UsersIcon, label: t('activeStaff'), value: formatCount(c.activeStaff, locale) },
    {
      icon: MessageSquareTextIcon,
      label: t('smsThisMonth'),
      value: formatCount(c.smsThisMonth, locale),
      note: t('segmentsCost', {
        count: formatCount(c.smsSegmentsThisMonth, locale),
        cost: formatTaka(c.smsCostThisMonth, locale),
      }),
    },
    {
      icon: UploadIcon,
      label: t('importsThisMonth'),
      value: formatCount(c.importsThisMonth, locale),
      note: t('importsTotal', { count: formatCount(c.importsTotal, locale) }),
    },
  ];
  return (
    <SectionCard id="institute-usage" title={t('usageTitle')} hint={t('usageHint')}>
      {/* One column on a phone: Bangla words like "পাঠানোগুলোর" need the width. */}
      <dl className="grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.label} className="flex items-start gap-3">
            <span className="bg-primary-soft text-primary-ink flex size-10 shrink-0 items-center justify-center rounded-lg">
              <i.icon aria-hidden className="size-5" />
            </span>
            <div className="flex min-w-0 flex-col">
              <dt className="text-muted-foreground text-sm">{i.label}</dt>
              <dd className="font-numeric text-xl font-semibold">{i.value}</dd>
              {i.note && <dd className="text-muted-foreground text-sm">{i.note}</dd>}
            </div>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ActivityIcon aria-hidden className="size-4" />
        {c.lastActivityAt
          ? t('lastActivity', { date: formatDate(new Date(c.lastActivityAt), locale, 'medium') })
          : t('noActivity')}
      </p>
    </SectionCard>
  );
}

function Owners({ d, locale }: { d: PlatformInstituteDetail; locale: Locale }) {
  const t = useTranslations('platformInstitutes');
  const [inviting, setInviting] = useState(false);
  const base = `/platform/institutes/${d.id}/owner-invitations`;
  const resend = useInstituteAction(
    d.id,
    (userId: string) =>
      platformApi<PlatformInstituteDetail>(`${base}/${userId}/resend`, { method: 'POST' }),
    t('ownerResent'),
  );
  const cancel = useInstituteAction(
    d.id,
    (userId: string) =>
      platformApi<PlatformInstituteDetail>(`${base}/${userId}/cancel`, { method: 'POST' }),
    t('ownerCancelled'),
  );
  // The same rules as the API: with an active owner the institute manages its owners itself,
  // and only one owner invitation is pending at a time.
  const hasActive = d.owners.some((o) => o.status === 'ACTIVE');
  const pendingId = d.owners.find((o) => o.status === 'INVITED')?.userId ?? null;
  const canInvite = !hasActive && pendingId === null;
  return (
    <SectionCard
      id="institute-owner"
      title={t('ownerTitle')}
      hint={t('ownerDetailHint')}
      actions={
        canInvite ? (
          <Button variant="outline" onClick={() => setInviting(true)} data-testid="invite-owner">
            <UserPlusIcon aria-hidden />
            {t('inviteOwner')}
          </Button>
        ) : undefined
      }
    >
      {d.owners.length === 0 ? (
        <p className="text-muted-foreground">{t('noOwner')}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="owner-list">
          {d.owners.map((o) => (
            <OwnerRow
              key={o.userId}
              owner={o}
              locale={locale}
              pending={resend.isPending || cancel.isPending}
              canCancel={!hasActive}
              canResend={!hasActive && (pendingId === null || pendingId === o.userId)}
              onResend={() => resend.mutate(o.userId)}
              onCancel={() => cancel.mutate(o.userId)}
            />
          ))}
        </ul>
      )}
      {inviting && <InviteOwnerDialog id={d.id} onClose={() => setInviting(false)} />}
    </SectionCard>
  );
}

function OwnerRow({
  owner: o,
  locale,
  pending,
  canCancel,
  canResend,
  onResend,
  onCancel,
}: {
  owner: PlatformInstituteOwner;
  locale: Locale;
  pending: boolean;
  canCancel: boolean;
  canResend: boolean;
  onResend: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('platformInstitutes');
  const name = (locale === 'bn' ? o.nameBn : null) ?? o.name ?? '—';
  const reinvitable = canResend && (o.status === 'EXPIRED' || o.status === 'DECLINED');
  const cancellable =
    canCancel && (o.status === 'INVITED' || o.status === 'DECLINED' || o.status === 'EXPIRED');
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3" data-testid="owner-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold break-words">{name}</span>
        <OwnerStatusBadge status={o.status} />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {o.phone && (
          <a
            href={`tel:${o.phone}`}
            className="text-primary-ink tabular-nums underline-offset-2 hover:underline"
            dir="ltr"
          >
            {formatBdPhone(o.phone)}
          </a>
        )}
        {o.status === 'INVITED' && o.inviteExpiresAt && (
          <span>
            {t('inviteExpires', {
              date: formatDate(new Date(o.inviteExpiresAt), locale, 'medium'),
            })}
          </span>
        )}
      </div>
      {(reinvitable || cancellable) && (
        <div className="flex flex-wrap gap-2">
          {reinvitable && (
            <Button size="sm" variant="outline" disabled={pending} onClick={onResend}>
              <SendIcon aria-hidden />
              {t('resendInvite')}
            </Button>
          )}
          {cancellable && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
              <XCircleIcon aria-hidden />
              {t('cancelInvite')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function InviteOwnerDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('platformInstitutes');
  const [name, setName] = useState('');
  const [nameBn, setNameBn] = useState('');
  const [phone, setPhone] = useState('');
  const [problems, setProblems] = useState<Set<string>>(new Set());
  const invite = useInstituteAction(
    id,
    (body: { name: string; nameBn: string | null; phone: string }) =>
      platformApi<PlatformInstituteDetail>(`/platform/institutes/${id}/owner-invitations`, {
        method: 'POST',
        json: body,
      }),
    t('ownerInvited'),
    onClose,
  );
  const submit = () => {
    const normalized = normalizeBdPhone(phone);
    const invalid = new Set<string>();
    if (!name.trim()) invalid.add('name');
    if (!normalized) invalid.add('phone');
    setProblems(invalid);
    if (invalid.size > 0) return;
    invite.mutate(
      { name: name.trim(), nameBn: nameBn.trim() || null, phone: normalized! },
      { onError: (e) => setProblems(fieldErrorsOf(e)) },
    );
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('inviteOwner')}
      description={t('inviteOwnerHint')}
      submitLabel={t('sendInvite')}
      pending={invite.isPending}
      onSubmit={submit}
      testId="invite-owner-dialog"
    >
      <TextField
        id="invite-owner-name"
        label={t('ownerName')}
        value={name}
        onChange={setName}
        required
        error={problems.has('name') ? t('errorRequired') : null}
      />
      <TextField
        id="invite-owner-name-bn"
        label={t('ownerNameBn')}
        value={nameBn}
        onChange={setNameBn}
        lang="bn"
      />
      <TextField
        id="invite-owner-phone"
        label={t('ownerPhone')}
        value={phone}
        onChange={setPhone}
        required
        type="tel"
        inputMode="tel"
        dir="ltr"
        error={problems.has('phone') ? t('errorPhone') : null}
      />
    </FormDialog>
  );
}

function Modules({ d }: { d: PlatformInstituteDetail }) {
  const t = useTranslations('platformInstitutes');
  const tModules = useTranslations('platformInstitutes.modules');
  const toggle = useInstituteAction(
    d.id,
    ({ module, enabled }: { module: PlatformModule; enabled: boolean }) =>
      platformApi<PlatformInstituteDetail>(`/platform/institutes/${d.id}/modules/${module}`, {
        method: 'PUT',
        json: { enabled },
      }),
    t('modulesSaved'),
  );
  const enabled = (key: string) => d.modules.some((m) => m.key === key && m.enabled);
  return (
    <SectionCard id="institute-modules" title={t('modulesTitle')} hint={t('modulesDetailHint')}>
      <ul className="flex flex-col divide-y rounded-lg border">
        <li className="flex items-center justify-between gap-3 px-3 py-3">
          <span className="font-medium">{tModules('CORE')}</span>
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
            <CheckIcon aria-hidden className="size-4" />
            {t('alwaysOn')}
          </span>
        </li>
        {PLATFORM_MODULES.map((m) => (
          <li key={m} className="flex items-center justify-between gap-3 px-3 py-3">
            <label htmlFor={`module-${m}`} className="font-medium">
              {tModules(m)}
            </label>
            <input
              id={`module-${m}`}
              type="checkbox"
              role="switch"
              className="accent-primary size-5"
              checked={enabled(m)}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate({ module: m, enabled: e.target.checked })}
              data-testid={`module-${m}`}
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function Limits({ d }: { d: PlatformInstituteDetail }) {
  const t = useTranslations('platformInstitutes');
  const [studentLimit, setStudentLimit] = useState(
    d.subscription?.studentLimit != null ? String(d.subscription.studentLimit) : '',
  );
  const [smsDailyCap, setSmsDailyCap] = useState(
    d.subscription?.smsDailyCap != null ? String(d.subscription.smsDailyCap) : '',
  );
  const [problems, setProblems] = useState<Set<string>>(new Set());
  const save = useInstituteAction(
    d.id,
    (body: { studentLimit: number | null; smsDailyCap: number | null }) =>
      platformApi<PlatformInstituteDetail>(`/platform/institutes/${d.id}/limits`, {
        method: 'PUT',
        json: body,
      }),
    t('limitsSaved'),
  );
  const submit = () => {
    const limit = parseLimit(studentLimit, 1);
    const cap = parseLimit(smsDailyCap, 0);
    const invalid = new Set<string>();
    if (limit === undefined) invalid.add('studentLimit');
    if (cap === undefined) invalid.add('smsDailyCap');
    setProblems(invalid);
    if (invalid.size === 0) save.mutate({ studentLimit: limit ?? null, smsDailyCap: cap ?? null });
  };
  return (
    <SectionCard id="institute-limits" title={t('limitsTitle')} hint={t('limitsHint')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="limit-students"
            label={t('studentLimit')}
            hint={t('noLimitHint')}
            value={studentLimit}
            onChange={setStudentLimit}
            inputMode="numeric"
            error={problems.has('studentLimit') ? t('errorLimit') : null}
            data-testid="limit-students"
          />
          <TextField
            id="limit-sms"
            label={t('smsDailyCap')}
            hint={t('smsCeilingHint')}
            value={smsDailyCap}
            onChange={setSmsDailyCap}
            inputMode="numeric"
            error={problems.has('smsDailyCap') ? t('errorLimit') : null}
            data-testid="limit-sms"
          />
        </div>
        <Button type="submit" variant="outline" className="w-fit" disabled={save.isPending}>
          {t('saveLimits')}
        </Button>
      </form>
    </SectionCard>
  );
}

function Plan({ d, locale }: { d: PlatformInstituteDetail; locale: Locale }) {
  const t = useTranslations('platformInstitutes');
  const tModules = useTranslations('platformInstitutes.modules');
  const [editing, setEditing] = useState(false);
  const s = d.subscription;
  const edit = (
    <Button variant="outline" onClick={() => setEditing(true)} data-testid="edit-plan">
      <PencilIcon aria-hidden />
      {s?.planName ? t('editPlan') : t('setPlan')}
    </Button>
  );
  const dialog = editing && <PlanDialog d={d} onClose={() => setEditing(false)} />;
  if (!s || !s.planName) {
    return (
      <SectionCard id="institute-plan" title={t('planTitle')} actions={edit}>
        <p className="text-muted-foreground">{t('noPlanText')}</p>
        {dialog}
      </SectionCard>
    );
  }
  const rows: [string, string][] = [
    [t('planName'), s.planName],
    [t('pricing'), t(`pricing_${s.pricing}`)],
    ...(s.pricing === 'FLAT'
      ? ([[t('priceFlat'), formatTaka(s.flatPaisa, locale)]] as [string, string][])
      : (
          [
            ['CORE', s.corePaisa],
            ['ATTENDANCE', s.attendancePaisa],
            ['FEES', s.feesPaisa],
            ['EXAMS', s.examsPaisa],
          ] as const
        ).map(
          ([m, paisa]) =>
            [t('pricePerStudent', { module: tModules(m) }), formatTaka(paisa, locale)] as [
              string,
              string,
            ],
        )),
    [
      t('cycle'),
      s.cycle === 'YEARLY'
        ? `${t('cycle_YEARLY')} · ${t('discountValue', { percent: formatCount(s.yearlyDiscountPercent, locale) })}`
        : t('cycle_MONTHLY'),
    ],
    [t('dueDays'), formatCount(s.dueDays, locale)],
    [
      t('trialEndsOn'),
      s.trialEndsOn ? formatDate(calendarDate(s.trialEndsOn), locale, 'medium') : t('noTrialEnd'),
    ],
    [
      t('billingStartsOn'),
      s.billingStartsOn ? formatMonth(s.billingStartsOn.slice(0, 7), locale) : t('notBilledYet'),
    ],
  ];
  return (
    <SectionCard id="institute-plan" title={t('planTitle')} actions={edit}>
      <dl className="flex flex-col divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2.5"
          >
            <dt className="text-muted-foreground text-sm">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {dialog}
    </SectionCard>
  );
}

function PlanDialog({ d, onClose }: { d: PlatformInstituteDetail; onClose: () => void }) {
  const today = usePlatformToday();
  const t = useTranslations('platformInstitutes');
  const locale = useLocale() as Locale;
  const s = d.subscription;
  const [plan, setPlan] = useState<PlanForm>(() => (s?.planName ? planFormOf(s) : newPlanForm()));
  const [trialEndsOn, setTrialEndsOn] = useState<string>(s?.trialEndsOn ?? '');
  const [billingStartsOn, setBillingStartsOn] = useState<string>(s?.billingStartsOn ?? '');
  const [problems, setProblems] = useState<Set<string>>(new Set());
  const thisMonth = today.slice(0, 7);
  const months = Array.from({ length: 19 }, (_, i) => `${addMonths(thisMonth, i - 12)}-01`);
  if (billingStartsOn && !months.includes(billingStartsOn)) months.unshift(billingStartsOn);
  const save = useInstituteAction(
    d.id,
    (body: Record<string, unknown>) =>
      platformApi<PlatformInstituteDetail>(`/platform/institutes/${d.id}/plan`, {
        method: 'PUT',
        json: body,
      }),
    t('planSaved'),
    onClose,
  );
  const err = (path: string, message: string) => (problems.has(path) ? message : null);
  const submit = () => {
    const invalid = new Set<string>();
    const built = planFromForm(plan, invalid);
    setProblems(invalid);
    if (invalid.size > 0) return;
    save.mutate(
      {
        ...built,
        trialEndsOn: (trialEndsOn || null) as IsoDate | null,
        billingStartsOn: (billingStartsOn || null) as IsoDate | null,
      },
      {
        // The body is flat (`corePaisa`); the fields are named `plan.corePaisa`.
        onError: (e) =>
          setProblems(
            new Set(
              [...fieldErrorsOf(e)].map((path) =>
                path.startsWith('plan.') ? path : `plan.${path}`,
              ),
            ),
          ),
      },
    );
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('editPlanTitle', { name: d.name })}
      description={t('editPlanHint')}
      submitLabel={t('savePlan')}
      pending={save.isPending}
      onSubmit={submit}
      testId="plan-dialog"
    >
      <PlanFields form={plan} onChange={setPlan} err={err} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="plan-trial-ends" label={t('trialEndsOn')}>
          <DateInput id="plan-trial-ends" value={trialEndsOn} onValueChange={setTrialEndsOn} />
        </Field>
        <SelectField
          id="plan-billing-start"
          label={t('billingStartsOn')}
          hint={t('billingStartsHint')}
          value={billingStartsOn}
          onChange={setBillingStartsOn}
          placeholder={t('notBilledYet')}
          options={months.map((m) => ({ value: m, label: formatMonth(m.slice(0, 7), locale) }))}
        />
      </div>
    </FormDialog>
  );
}

/** What the institute owes: open and overdue amounts, its latest invoices. */
function Billing({ d, locale }: { d: PlatformInstituteDetail; locale: Locale }) {
  const t = useTranslations('platformBilling');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['platform-invoices', 'institute', d.id],
    queryFn: () =>
      platformApi<PlatformInvoicePage>(`/platform/invoices?tenantId=${d.id}&pageSize=6`),
  });
  const b = d.billing;
  return (
    <SectionCard
      id="institute-billing"
      title={t('billingTitle')}
      actions={
        <ButtonLink href="/platform/billing" variant="outline" size="sm">
          {t('allBilling')}
        </ButtonLink>
      }
    >
      {b.overdueCount > 0 ? (
        <Alert variant="destructive" data-testid="institute-overdue">
          <AlertDescription>
            {t('overdueSummary', {
              count: formatCount(b.overdueCount, locale),
              n: b.overdueCount,
              amount: formatTaka(b.overduePaisa, locale),
            })}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground text-sm">
          {b.openCount > 0
            ? t('openSummary', {
                count: formatCount(b.openCount, locale),
                n: b.openCount,
                amount: formatTaka(b.openPaisa, locale),
              })
            : t('nothingOpen')}
        </p>
      )}
      {q.data && q.data.items.length > 0 && (
        <InvoiceList items={q.data.items} showInstitute={false} onOpen={setOpen} />
      )}
      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </SectionCard>
  );
}

type StatusAction = 'suspend' | 'reactivate' | 'activate';

function Status({ d }: { d: PlatformInstituteDetail }) {
  const t = useTranslations('platformInstitutes');
  const [action, setAction] = useState<StatusAction | null>(null);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const done: Record<StatusAction, string> = {
    suspend: t('suspended'),
    reactivate: t('reactivated'),
    activate: t('activated'),
  };
  const change = useInstituteAction(
    d.id,
    ({ to, reason }: { to: StatusAction; reason: string }) =>
      platformApi<PlatformInstituteDetail>(`/platform/institutes/${d.id}/${to}`, {
        method: 'POST',
        json: { reason },
      }),
    action ? done[action] : '',
    () => {
      setAction(null);
      setReason('');
    },
  );
  if (d.status === 'ARCHIVED') return null;
  const suspended = d.status === 'SUSPENDED';
  const back = t(`status_${d.suspendedFrom ?? 'ACTIVE'}`);
  const copy: Record<StatusAction, { title: string; hint: string; button: string }> = {
    suspend: {
      title: t('suspendTitle', { name: d.name }),
      hint: t('suspendHint'),
      button: t('suspend'),
    },
    reactivate: {
      title: t('reactivateTitle', { name: d.name }),
      hint: t('reactivateHint', { status: back }),
      button: t('reactivate'),
    },
    activate: {
      title: t('activateTitle', { name: d.name }),
      hint: t('activateHint'),
      button: t('activate'),
    },
  };
  const submit = () => {
    const ok = reason.trim().length >= 3;
    setInvalid(!ok);
    if (ok && action) change.mutate({ to: action, reason: reason.trim() });
  };
  return (
    <SectionCard
      id="institute-status"
      title={t('statusTitle')}
      hint={
        suspended
          ? t('reactivateHint', { status: back })
          : d.status === 'TRIAL'
            ? t('trialHint')
            : t('suspendHint')
      }
    >
      <div className="flex flex-wrap gap-2">
        {d.status === 'TRIAL' && (
          <Button onClick={() => setAction('activate')} data-testid="activate-institute">
            <BadgeCheckIcon aria-hidden />
            {t('activate')}
          </Button>
        )}
        {suspended ? (
          <Button onClick={() => setAction('reactivate')} data-testid="reactivate-institute">
            <PlayCircleIcon aria-hidden />
            {t('reactivate')}
          </Button>
        ) : (
          <Button
            variant="destructive"
            onClick={() => setAction('suspend')}
            data-testid="suspend-institute"
          >
            <PauseCircleIcon aria-hidden />
            {t('suspend')}
          </Button>
        )}
      </div>
      <FormDialog
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
        title={action ? copy[action].title : ''}
        description={action ? copy[action].hint : undefined}
        submitLabel={action ? copy[action].button : ''}
        pending={change.isPending}
        onSubmit={submit}
        testId="status-dialog"
      >
        <Field
          id="status-reason"
          label={t('reason')}
          hint={t('reasonHint')}
          error={invalid ? t('errorReason') : null}
          required
        >
          <textarea
            id="status-reason"
            className={textareaClass}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={invalid || undefined}
            data-testid="status-reason"
          />
        </Field>
      </FormDialog>
    </SectionCard>
  );
}
