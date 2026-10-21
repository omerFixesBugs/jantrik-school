'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DateInput } from '@/components/date-input';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

/** A titled block on a settings-style page. */
export function SectionCard({
  id,
  title,
  hint,
  actions,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-slot="card"
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-4 border p-(--panel-p)"
      aria-labelledby={`${id}-title`}
      data-testid={id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${id}-title`} className="text-base font-semibold break-words">
            {title}
          </h3>
          {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Label + input + hint + error, wired up for screen readers. */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            *
          </span>
        )}
      </Label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-muted-foreground text-sm">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** An input's props as the date field takes them (min/max as ISO strings, no `type`). */
function dateProps({
  type: _type,
  min,
  max,
  defaultValue: _defaultValue,
  ...rest
}: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'id'>) {
  return {
    ...rest,
    min: typeof min === 'string' ? min : undefined,
    max: typeof max === 'string' ? max : undefined,
  };
}

/** A text input inside a Field. */
export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
  className,
  ...props
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'id'>) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {props.type === 'date' ? (
        // Day-first, Bangla-digit date field instead of the browser's (date-input.tsx).
        <DateInput
          {...dateProps(props)}
          id={id}
          value={value}
          onValueChange={onChange}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          {...props}
        />
      )}
    </Field>
  );
}

/** A native select styled like the inputs (works everywhere, including old Android browsers). */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  required,
  className,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <select
        id={id}
        value={value}
        required={required}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(
          'border-input bg-card h-(--control-h) w-full min-w-0 rounded-md border ps-2.5 pe-2 text-(length:--input-fs) outline-none',
          'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
          'aria-invalid:border-destructive disabled:opacity-60',
        )}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A checkbox styled as a switch, with its label and an optional hint. */
export function ToggleField({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary mt-0.5 size-5 shrink-0"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={id}
          className="flex min-h-(--control-h-xs) items-center leading-snug font-medium"
        >
          {label}
        </label>
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      </div>
    </div>
  );
}

/** "Inactive" badge for deactivated setup items. */
export function InactiveBadge({ active }: { active: boolean }) {
  const t = useTranslations('setup');
  if (active) return null;
  return <Badge variant="warning">{t('inactive')}</Badge>;
}

/**
 * Field problems from a 400 (zod paths) or a 409 DUPLICATE (`field`), keyed by field name, as
 * translated text. Server messages are English-only, so only the kind of problem is used.
 */
export function useFieldErrors() {
  const t = useTranslations('setup');
  return (error: unknown): Record<string, string> => {
    if (!(error instanceof ApiError)) return {};
    const body = error.body as {
      errors?: { path: string; message: string }[];
      field?: string;
    } | null;
    const out: Record<string, string> = {};
    for (const e of body?.errors ?? []) out[e.path.split('.')[0] ?? e.path] = t('errorInvalid');
    if (error.code === 'DUPLICATE' && body?.field) out[body.field] = t('errorDuplicate');
    return out;
  };
}

/** A pill-shaped radio or checkbox (big tap target). */
export function ChoiceChip({
  type,
  name,
  checked,
  onChange,
  children,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-(--control-h) cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
        'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-3',
        checked
          ? 'border-primary-ink bg-primary-soft text-accent-foreground'
          : 'bg-card hover:border-primary/40',
      )}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary size-4"
      />
      {children}
    </label>
  );
}
