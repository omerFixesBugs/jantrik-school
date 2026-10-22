'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fitAccent,
  isHex,
  THEME_MODES,
  THEME_PRESETS,
  themeTokens,
  type Appearance,
  type ThemeMode,
  type ThemePreset,
} from '@jantrik/shared';
import { CheckIcon, CircleAlertIcon, RotateCcwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { SetupPage, useSetupErrorMessage } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * How the institute looks (docs/design.md → Themes), for the owner: one of four presets, each in
 * light and dark, and optionally an accent colour. The colour is checked live by the same rules
 * the server applies (fitAccent): nudged until every text reads at 4.5:1 in both modes, and the
 * nudged colour is what is shown and saved. Each person still picks light, dark or the device.
 */

/** A few accents that suit each preset, besides its own. */
/**
 * Arrow keys move the choice within a radio group (one tab stop: the checked one), Home and End
 * to the ends; modifier keys stay the browser's.
 */
function radioKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = radios.findIndex((r) => r === document.activeElement);
  if (at < 0) return;
  const to: Record<string, number> = {
    ArrowRight: at + 1,
    ArrowDown: at + 1,
    ArrowLeft: at - 1,
    ArrowUp: at - 1,
    Home: 0,
    End: radios.length - 1,
  };
  if (!(e.key in to)) return;
  e.preventDefault();
  const next = radios[(to[e.key]! + radios.length) % radios.length]!;
  next.focus();
  next.click();
}

const SUGGESTED: Record<ThemePreset, string[]> = {
  SCHOOL: ['#0f766e', '#7c3aed', '#be123c', '#b45309'],
  MADRASA: ['#0f766e', '#1e3a8a', '#7c2d12', '#365314'],
  COACHING: ['#2563eb', '#db2777', '#ea580c', '#0d9488'],
  ENGLISH_MEDIUM: ['#1e3a8a', '#7f1d1d', '#14532d', '#a16207'],
};

export default function AppearancePage() {
  const t = useTranslations('appearance');
  const { data: context } = useMeContext();
  return (
    <SetupPage tab="appearance">
      {!context ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !context.roles.includes('OWNER') ? (
        // The look is the owner's choice (PUT /settings/appearance is OWNER only).
        <p className="text-muted-foreground" data-testid="appearance-owner-only">
          {t('ownerOnly')}
        </p>
      ) : (
        <AppearanceForm
          key={`${context.appearance.preset}|${context.appearance.accent}`}
          current={context.appearance}
        />
      )}
    </SetupPage>
  );
}

function AppearanceForm({ current }: { current: Appearance }) {
  const t = useTranslations('appearance');
  const message = useSetupErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<ThemePreset>(current.preset);
  const [accent, setAccent] = useState<string | null>(current.accent);
  const [draft, setDraft] = useState(current.accent ?? '');
  const fit = accent ? fitAccent(accent, preset) : null;
  const shown = fit?.ok ? fit.light.primary : null;
  const changed = preset !== current.preset || accent !== current.accent;

  const save = useMutation({
    mutationFn: (body: { preset: ThemePreset | null; accent: string | null }) =>
      client.api<Appearance>('/settings/appearance', { method: 'PUT', json: body }),
    onSuccess: (_, body) => {
      const reset = body.preset === null && body.accent === null;
      toast.success(reset ? t('resetDone') : t('saved'));
      // A reset that changes nothing on the server would not remount the form: clear it here.
      if (reset) {
        setPreset(current.typeDefault);
        chooseAccent(null);
      }
      // The new look reaches this page (and everyone's next page) through /me/context.
      void queryClient.invalidateQueries({ queryKey: ['me-context', session?.tenant?.id] });
    },
    onError: (e) =>
      toast.error(
        e instanceof ApiError && e.code === 'ACCENT_CONTRAST' ? t('accentRefused') : message(e),
      ),
  });

  const chooseAccent = (value: string | null) => {
    setAccent(value);
    setDraft(value ?? '');
  };

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <SectionCard id="appearance-preset" title={t('presetTitle')} hint={t('presetText')}>
        <div
          role="radiogroup"
          aria-label={t('presetTitle')}
          onKeyDown={radioKeys}
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          data-testid="preset-choices"
        >
          {THEME_PRESETS.map((p) => (
            <PresetCard
              key={p}
              preset={p}
              accent={p === preset ? accent : null}
              checked={p === preset}
              isDefault={p === current.typeDefault}
              onChoose={() => setPreset(p)}
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard id="appearance-accent" title={t('accentTitle')} hint={t('accentText')}>
        <div className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label={t('accentTitle')}
            onKeyDown={radioKeys}
            className="flex flex-wrap gap-2"
          >
            <Swatch
              color={themeTokens(preset, 'light').primary!}
              label={t('accentOwn')}
              checked={accent === null}
              // One tab stop even when a custom colour (no swatch) is chosen.
              focusable={accent === null || !SUGGESTED[preset].includes(accent)}
              onChoose={() => chooseAccent(null)}
            />
            {SUGGESTED[preset].map((c) => (
              <Swatch
                key={c}
                color={fitAccent(c, preset).ok ? themeTokens(preset, 'light', c).primary! : c}
                label={c}
                checked={accent === c}
                focusable={accent === c}
                onChoose={() => chooseAccent(c)}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('accentCustom')}
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={t('accentPicker')}
                  value={isHex(draft) ? draft : '#2563eb'}
                  onChange={(e) => chooseAccent(e.target.value.toLowerCase())}
                  className="border-input size-(--control-h) shrink-0 cursor-pointer rounded-xl border bg-transparent p-1"
                />
                <Input
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value.trim().toLowerCase();
                    setDraft(v);
                    if (isHex(v)) setAccent(v);
                  }}
                  placeholder="#2563eb"
                  aria-label={t('accentHex')}
                  spellCheck={false}
                  dir="ltr"
                  className="w-32 font-mono"
                  data-testid="accent-hex"
                />
              </span>
            </label>
            {accent && fit && (
              <p
                className="flex items-center gap-2 text-sm"
                data-testid="accent-check"
                aria-live="polite"
              >
                {fit.ok ? (
                  <>
                    <Pill tone="success">
                      <CheckIcon aria-hidden className="size-3.5" />
                      {t('accentFits')}
                    </Pill>
                    {shown && shown !== accent && (
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-4 rounded-full border"
                          style={{ background: shown }}
                        />
                        {t('accentAdjusted', { color: shown })}
                      </span>
                    )}
                  </>
                ) : (
                  <Pill tone="destructive">
                    <CircleAlertIcon aria-hidden className="size-3.5" />
                    {t('accentRefused')}
                  </Pill>
                )}
              </p>
            )}
          </div>
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => save.mutate({ preset, accent })}
          disabled={!changed || save.isPending || (fit !== null && !fit.ok)}
          data-testid="appearance-save"
        >
          {t('save')}
        </Button>
        <Button
          variant="outline"
          onClick={() => save.mutate({ preset: null, accent: null })}
          disabled={
            save.isPending || (!current.chosen && preset === current.typeDefault && accent === null)
          }
          data-testid="appearance-reset"
        >
          <RotateCcwIcon aria-hidden />
          {t('reset')}
        </Button>
        <p className="text-muted-foreground text-sm">{t('modeNote')}</p>
      </div>
    </div>
  );
}

/** One preset: its name, what it suits, and a small light and dark preview from its real tokens. */
function PresetCard({
  preset,
  accent,
  checked,
  isDefault,
  onChoose,
}: {
  preset: ThemePreset;
  accent: string | null;
  checked: boolean;
  isDefault: boolean;
  onChoose: () => void;
}) {
  const t = useTranslations('appearance');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={onChoose}
      data-testid={`preset-${preset.toLowerCase()}`}
      className={cn(
        'bg-card rounded-card focus-visible:ring-ring flex flex-col gap-3 border p-3 text-start transition-shadow outline-none focus-visible:ring-2',
        checked ? 'ring-primary-ink shadow-card ring-2' : 'hover:shadow-card',
      )}
    >
      <span className="grid grid-cols-2 gap-2" aria-hidden>
        {THEME_MODES.map((mode) => (
          <Preview key={mode} preset={preset} mode={mode} accent={accent} />
        ))}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t(`preset_${preset}`)}</span>
        {isDefault && <Pill tone="accent">{t('typeDefault')}</Pill>}
        {checked && <CheckIcon aria-hidden className="text-primary-ink ms-auto size-4" />}
      </span>
      <span className="text-muted-foreground text-sm">{t(`presetText_${preset}`)}</span>
    </button>
  );
}

/** A thumbnail of the look: the ground, the sidebar, a card with a heading, a line and a button. */
function Preview({
  preset,
  mode,
  accent,
}: {
  preset: ThemePreset;
  mode: ThemeMode;
  accent: string | null;
}) {
  const k = themeTokens(preset, mode, accent);
  return (
    <span
      className="flex h-20 overflow-hidden rounded-xl border"
      style={{ background: k.background, borderColor: k.border }}
    >
      <span
        className="w-1/4"
        style={{ background: k.sidebar, borderInlineEnd: `1px solid ${k['sidebar-border']}` }}
      >
        <span
          className="m-1.5 block h-2 rounded-full"
          style={{ background: k['sidebar-primary'] }}
        />
      </span>
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span
          className="h-5 rounded-md"
          style={{ background: `linear-gradient(135deg, ${k['hero-from']}, ${k['hero-to']})` }}
        />
        <span
          className="flex flex-1 flex-col justify-between rounded-md p-1"
          style={{ background: k.card }}
        >
          <span className="block h-1.5 w-2/3 rounded-full" style={{ background: k.foreground }} />
          <span className="flex items-end gap-0.5">
            {[0.5, 0.8, 0.6, 1].map((h, i) => (
              <span
                key={i}
                className="w-1.5 rounded-full"
                style={{ height: `${h * 14}px`, background: i === 3 ? k['primary'] : k['ramp-2'] }}
              />
            ))}
            <span className="ms-auto h-2.5 w-6 rounded-full" style={{ background: k.primary }} />
          </span>
        </span>
      </span>
    </span>
  );
}

function Swatch({
  color,
  label,
  checked,
  focusable,
  onChoose,
}: {
  color: string;
  label: string;
  checked: boolean;
  focusable: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={focusable ? 0 : -1}
      aria-label={label}
      title={label}
      onClick={onChoose}
      className={cn(
        'focus-visible:ring-ring flex size-(--control-h) items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        checked && 'ring-primary-ink ring-2 ring-offset-2',
      )}
      style={{ background: color }}
    >
      {checked && (
        <span className="bg-card text-foreground flex size-5 items-center justify-center rounded-full">
          <CheckIcon aria-hidden className="size-3.5" />
        </span>
      )}
    </button>
  );
}
