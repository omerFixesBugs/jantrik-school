'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  renderStudentCode,
  toAsciiDigits,
  validateCodePattern,
  type StudentSettings,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionCard, TextField } from '@/components/form-kit';
import { SetupPage, useSetupErrorMessage } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';

const TOKENS = ['{PREFIX}', '{YEAR}', '{YY}', '{NNNN}'] as const;

/** How new student codes (IDs) are made: prefix + pattern, e.g. SS-2026-0031. */
export default function StudentCodePage() {
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const settings = useQuery({
    queryKey: ['student-settings', session?.tenant?.id],
    queryFn: () => client.api<StudentSettings>('/students/settings'),
  });
  return (
    <SetupPage tab="studentCode">
      {settings.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : settings.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(settings.error)}</AlertDescription>
        </Alert>
      ) : (
        <CodeForm initial={settings.data} />
      )}
    </SetupPage>
  );
}

function CodeForm({ initial }: { initial: StudentSettings }) {
  const t = useTranslations('setup');
  const label = useLabel();
  const message = useSetupErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const { data: context } = useMeContext();
  const [prefix, setPrefix] = useState(initial.codePrefix);
  const [pattern, setPattern] = useState(initial.codePattern);
  const cleanPrefix = toAsciiDigits(prefix.trim()).toUpperCase();
  const prefixOk = /^[A-Z0-9]{1,10}$/.test(cleanPrefix);
  const problems = validateCodePattern(pattern.trim());
  const year = Number((context?.academicYear?.startDate ?? '2026').slice(0, 4));
  const save = useMutation({
    mutationFn: () =>
      client.api<StudentSettings>('/students/settings', {
        method: 'PUT',
        json: { codePrefix: cleanPrefix, codePattern: pattern.trim() },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(['student-settings', session?.tenant?.id], next);
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const samples =
    prefixOk && problems.length === 0
      ? [1, 2, 125].map((seq) =>
          renderStudentCode(pattern.trim(), { prefix: cleanPrefix, year, seq }),
        )
      : [];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (prefixOk && problems.length === 0) save.mutate();
      }}
      data-testid="student-code-form"
    >
      <SectionCard
        id="setup-student-code"
        title={t('tabStudentCode', { student: label('student', 'Student', { inText: true }) })}
        hint={t('studentCodeHint')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="code-prefix"
            label={t('codePrefix')}
            value={prefix}
            onChange={setPrefix}
            dir="ltr"
            maxLength={10}
            required
            hint={t('codePrefixHint')}
            error={prefix && !prefixOk ? t('codePrefixError') : null}
          />
          <TextField
            id="code-pattern"
            label={t('codePattern')}
            value={pattern}
            onChange={setPattern}
            dir="ltr"
            maxLength={40}
            required
            error={problems.length > 0 ? t('codePatternError') : null}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('codeTokens')}</span>
          {TOKENS.map((tok) => (
            <Button
              key={tok}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPattern((p) => p + tok)}
            >
              <span dir="ltr" className="font-mono text-xs">
                {tok}
              </span>
            </Button>
          ))}
        </div>
        <div
          className="bg-canvas flex flex-col gap-1 rounded-lg border p-3"
          data-testid="code-preview"
        >
          <span className="text-muted-foreground text-xs font-medium">{t('preview')}</span>
          {samples.length > 0 ? (
            <p className="font-mono break-all" dir="ltr">
              {samples.join(', ')}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">—</p>
          )}
          <p className="text-muted-foreground text-sm">
            {t('codeNext', { code: initial.example })}
          </p>
        </div>
        <Button
          type="submit"
          className="w-fit"
          disabled={!prefixOk || problems.length > 0 || save.isPending}
        >
          {t('save')}
        </Button>
      </SectionCard>
    </form>
  );
}
