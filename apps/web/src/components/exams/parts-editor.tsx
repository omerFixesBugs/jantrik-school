'use client';

import {
  COMPONENT_KINDS,
  suggestedPassMarks,
  toAsciiDigits,
  type ComponentKind,
  type ExamComponentView,
  type GradeBandView,
  type PassGroupView,
  type PassRule,
} from '@jantrik/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { NativeSelect, localDigits, parseWhole } from '@/components/fees/setup/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface PartsValue {
  passRule: PassRule;
  components: ExamComponentView[];
  passGroups: PassGroupView[];
}

/**
 * A subject's parts (CQ, MCQ, practical, papers), their full and pass marks, and how it is passed:
 * each part on its own, or same-kind parts added across papers against one combined mark.
 * Numbers accept Bangla digits; a suggested pass mark is the lowest passing band's share.
 */
export function PartsEditor({
  value,
  onChange,
  bands,
  idPrefix,
}: {
  value: PartsValue;
  onChange: (v: PartsValue) => void;
  bands: GradeBandView[];
  idPrefix: string;
}) {
  const t = useTranslations('exams.parts');
  const tKind = useTranslations('exams.common.componentKind');
  const locale = useLocale();
  const set = (patch: Partial<PartsValue>) => onChange({ ...value, ...patch });
  const setPart = (i: number, patch: Partial<ExamComponentView>) =>
    set({ components: value.components.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const kinds = [...new Set(value.components.map((c) => c.kind))];
  const fullOf = (kind: ComponentKind) =>
    value.components.filter((c) => c.kind === kind).reduce((n, c) => n + c.fullMarks, 0);
  const groupOf = (kind: ComponentKind) => value.passGroups.find((g) => g.kind === kind);
  const setGroup = (kind: ComponentKind, passMarks: number) =>
    set({ passGroups: [...value.passGroups.filter((g) => g.kind !== kind), { kind, passMarks }] });

  return (
    <div className="flex flex-col gap-4" data-testid={`${idPrefix}-parts`}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-rule`} className="font-medium">
          {t('passRule')}
        </label>
        <NativeSelect
          id={`${idPrefix}-rule`}
          value={value.passRule}
          onChange={(v) => {
            const passRule = v as PassRule;
            // Switching to COMBINED prefills a combined mark per kind from the summed full marks.
            const passGroups =
              passRule === 'COMBINED'
                ? kinds.map(
                    (k) =>
                      groupOf(k) ?? { kind: k, passMarks: suggestedPassMarks(fullOf(k), bands) },
                  )
                : [];
            set({ passRule, passGroups });
          }}
          options={(['PER_COMPONENT', 'COMBINED'] as const).map((r) => ({
            value: r,
            label: t(`rule.${r}`),
          }))}
        />
        <p className="text-muted-foreground text-sm">{t(`ruleHint.${value.passRule}`)}</p>
      </div>

      <ul className="flex flex-col gap-3">
        {value.components.map((c, i) => (
          <li
            key={i}
            className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[6rem_8rem_1fr_1fr_5rem_5rem_auto] sm:items-end"
          >
            <Cell label={t('key')} id={`${idPrefix}-key-${i}`}>
              <Input
                id={`${idPrefix}-key-${i}`}
                value={c.key}
                onChange={(e) =>
                  setPart(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })
                }
              />
            </Cell>
            <Cell label={t('kind')} id={`${idPrefix}-kind-${i}`}>
              <NativeSelect
                id={`${idPrefix}-kind-${i}`}
                value={c.kind}
                onChange={(v) => setPart(i, { kind: v as ComponentKind })}
                options={COMPONENT_KINDS.map((k) => ({ value: k, label: tKind(k) }))}
              />
            </Cell>
            <Cell label={t('nameBn')} id={`${idPrefix}-nbn-${i}`}>
              <Input
                id={`${idPrefix}-nbn-${i}`}
                value={c.nameBn}
                onChange={(e) => setPart(i, { nameBn: e.target.value })}
              />
            </Cell>
            <Cell label={t('nameEn')} id={`${idPrefix}-nen-${i}`}>
              <Input
                id={`${idPrefix}-nen-${i}`}
                value={c.nameEn}
                onChange={(e) => setPart(i, { nameEn: e.target.value })}
              />
            </Cell>
            <Cell label={t('full')} id={`${idPrefix}-full-${i}`}>
              <Input
                id={`${idPrefix}-full-${i}`}
                inputMode="numeric"
                className="text-end"
                value={localDigits(String(c.fullMarks), locale)}
                onChange={(e) => {
                  const full = parseWhole(e.target.value) ?? 0;
                  setPart(i, {
                    fullMarks: full,
                    passMarks: c.passMarks === null ? null : suggestedPassMarks(full, bands),
                  });
                }}
              />
            </Cell>
            <Cell label={t('pass')} id={`${idPrefix}-pass-${i}`}>
              <Input
                id={`${idPrefix}-pass-${i}`}
                inputMode="numeric"
                className="text-end"
                disabled={value.passRule === 'COMBINED'}
                value={c.passMarks === null ? '' : localDigits(String(c.passMarks), locale)}
                onChange={(e) => {
                  const raw = toAsciiDigits(e.target.value).trim();
                  setPart(i, { passMarks: raw === '' ? null : (parseWhole(raw) ?? 0) });
                }}
              />
            </Cell>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remove')}
              disabled={value.components.length <= 1}
              onClick={() => set({ components: value.components.filter((_, j) => j !== i) })}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            set({
              components: [
                ...value.components,
                {
                  key: `P${value.components.length + 1}`,
                  kind: 'WRITTEN',
                  nameBn: '',
                  nameEn: '',
                  fullMarks: 100,
                  passMarks: suggestedPassMarks(100, bands),
                },
              ],
            })
          }
        >
          <PlusIcon aria-hidden />
          {t('add')}
        </Button>
      </div>

      {value.passRule === 'COMBINED' && (
        <fieldset className="flex flex-col gap-2 rounded-xl border p-3">
          <legend className="px-1 font-medium">{t('combined')}</legend>
          {kinds.map((k) => (
            <div key={k} className="flex flex-wrap items-center gap-3">
              <label htmlFor={`${idPrefix}-group-${k}`} className="min-w-32">
                {t('combinedFor', { kind: tKind(k), full: localDigits(String(fullOf(k)), locale) })}
              </label>
              <Input
                id={`${idPrefix}-group-${k}`}
                inputMode="numeric"
                className="w-24 text-end"
                value={localDigits(String(groupOf(k)?.passMarks ?? ''), locale)}
                onChange={(e) => setGroup(k, parseWhole(e.target.value) ?? 0)}
              />
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function Cell({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </label>
      {children}
    </div>
  );
}

/** "CQ ৭০ + MCQ ৩০" */
export function partsLine(components: ExamComponentView[], locale: string): string {
  return components.map((c) => `${c.key} ${localDigits(String(c.fullMarks), locale)}`).join(' + ');
}
