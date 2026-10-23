'use client';

import { parseTaka } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Field } from '@/components/form-kit';
import { Input } from '@/components/ui/input';

/** Paisa → what the field shows while editing (ASCII, no grouping: easy to correct). */
const toText = (paisa: number | null) =>
  paisa === null ? '' : paisa % 100 === 0 ? String(paisa / 100) : (paisa / 100).toFixed(2);

/**
 * A taka amount (stored as paisa). Accepts Bangla digits, commas and up to 2 decimals
 * (parseTaka); `onChange` gets paisa, or null while the text is not an amount. 16 px text and a
 * 44 px target on phones (docs/design.md → Forms).
 */
export function MoneyField({
  id,
  label,
  valuePaisa,
  onChange,
  hint,
  error,
  required,
  disabled,
  className,
  testId,
}: {
  id: string;
  label: string;
  valuePaisa: number | null;
  onChange: (paisa: number | null) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const t = useTranslations('fees.common.money');
  const [text, setText] = useState(toText(valuePaisa));
  // Follow the value when it changes from outside (not while the person is typing it): adjust
  // state during render (react.dev, "storing information from previous renders").
  const [seen, setSeen] = useState(valuePaisa);
  if (valuePaisa !== seen) {
    setSeen(valuePaisa);
    if (parseTaka(text) !== valuePaisa) setText(toText(valuePaisa));
  }
  const invalid = text.trim() !== '' && parseTaka(text) === null;
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error ?? (invalid ? t('invalid') : null)}
      required={required}
      className={className}
    >
      <div className="relative">
        <span
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center"
        >
          {t('taka')}
        </span>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className="pl-8 tabular-nums"
          value={text}
          disabled={disabled}
          required={required}
          aria-invalid={invalid || error ? true : undefined}
          data-testid={testId}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseTaka(e.target.value));
          }}
        />
      </div>
    </Field>
  );
}
