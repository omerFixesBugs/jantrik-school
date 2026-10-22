'use client';

import { formatDateInput, parseDateInput, type IsoDate } from '@jantrik/shared';
import { CalendarDaysIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import type { Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';

/** Not in any form: the hidden native picker must never be validated or submitted. */
const NO_FORM = 'jantrik-date-picker-no-form';

/**
 * A date field in the form Bangladeshi forms use: day first (DD/MM/YYYY), Bangla or ASCII digits,
 * ISO pasted in works too (docs/design.md → Layout). It replaces `<input type="date">`, which
 * shows "mm/dd/yyyy" in the browser's language whatever the page's.
 *
 * - The value is ISO (YYYY-MM-DD), '' when empty **or not a date yet**: text that doesn't parse
 *   stays on screen to be fixed but never passes on an old value.
 * - Invalid or out-of-range text blocks the form through the browser's own validation (kept in
 *   step with the text, `min`, `max` and `required`), as the native field did.
 * - `name` posts the ISO value through a hidden input (GET forms).
 * - The calendar button opens the browser's own date picker.
 */
export function DateInput({
  id,
  value,
  defaultValue,
  onValueChange,
  name,
  min,
  max,
  required,
  disabled,
  className,
  onBlur,
  ...props
}: {
  id: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: IsoDate | '') => void;
  /** Posts the ISO value under this name (uncontrolled GET forms). */
  name?: string;
  min?: string;
  max?: string;
} & Omit<
  ComponentProps<typeof Input>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'name' | 'min' | 'max' | 'id'
>) {
  const t = useTranslations('dateInput');
  const locale = useLocale() as Locale;
  const [own, setOwn] = useState<string>(defaultValue ?? '');
  const iso = value ?? own;
  // What the person typed, while it differs from the value; otherwise the value, formatted.
  const [draft, setDraft] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const text = draft ?? (iso ? formatDateInput(iso, locale) : '');

  // The browser's validation follows what is on screen, whatever changed it (typing, the picker,
  // a new min or max from the form around it).
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    let message = '';
    if (text.trim()) {
      const parsed = parseDateInput(text);
      if (!parsed) message = t('invalid');
      else if (min && parsed < min) message = t('tooEarly', { date: formatDateInput(min, locale) });
      else if (max && parsed > max) message = t('tooLate', { date: formatDateInput(max, locale) });
    }
    el.setCustomValidity(message);
  }, [text, min, max, t, locale]);

  const commit = (next: IsoDate | '') => {
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };

  return (
    <div className={cn('relative', className)}>
      <Input
        {...props}
        ref={field}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={props.placeholder ?? t('placeholder')}
        value={text}
        disabled={disabled}
        required={required}
        className="pe-(--control-h)"
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          // Not a date (yet): the value is empty, so the form's own checks see "no date".
          commit(parseDateInput(raw) ?? '');
        }}
        onBlur={(e) => {
          // A valid date settles into DD/MM/YYYY; anything else stays as typed to be fixed.
          if (!e.target.value.trim() || parseDateInput(e.target.value)) setDraft(null);
          onBlur?.(e);
        }}
      />
      {name && <input type="hidden" name={name} value={iso} />}
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={t('calendar')}
        title={t('calendar')}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-0 flex w-(--control-h) items-center justify-center rounded-e-md"
        onClick={() => {
          try {
            picker.current?.showPicker();
          } catch {
            // No picker in this browser (or not allowed now): typing still works.
          }
        }}
      >
        <CalendarDaysIcon aria-hidden className="size-4" />
      </button>
      {/* The browser's own picker, opened from the button: never tabbed to, never read out, in
          no form (so it is neither validated nor submitted). */}
      <input
        ref={picker}
        type="date"
        form={NO_FORM}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute end-0 bottom-0 size-px opacity-0"
        value={iso}
        min={min}
        max={max}
        onChange={(e) => {
          setDraft(null);
          commit(e.target.value);
        }}
      />
    </div>
  );
}
