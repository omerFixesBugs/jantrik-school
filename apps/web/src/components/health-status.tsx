'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { healthResponseSchema, type HealthResponse } from '@jantrik/shared';
import { Button } from '@/components/ui/button';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type State = { kind: 'loading' } | { kind: 'ok'; data: HealthResponse } | { kind: 'unreachable' };

/** Placeholder widget: shows whether the API and its database are reachable. */
export function HealthStatus() {
  const t = useTranslations('health');
  const [state, setState] = useState<State>({ kind: 'loading' });

  const check = useCallback(async () => {
    try {
      // 503 still carries a valid body (db down), so parse regardless of status.
      const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
      return { kind: 'ok', data: healthResponseSchema.parse(await res.json()) } as const;
    } catch {
      return { kind: 'unreachable' } as const;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void check().then((next) => active && setState(next));
    return () => {
      active = false;
    };
  }, [check]);

  const retry = () => {
    setState({ kind: 'loading' });
    void check().then(setState);
  };

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <h2 className="text-lg font-medium">{t('title')}</h2>
      {state.kind === 'loading' && <p className="text-muted-foreground">{t('checking')}</p>}
      {state.kind === 'unreachable' && <p className="text-destructive">{t('unreachable')}</p>}
      {state.kind === 'ok' && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>{t('api')}</dt>
          <dd>{t('up')}</dd>
          <dt>{t('database')}</dt>
          <dd className={state.data.db === 'up' ? '' : 'text-destructive'}>{t(state.data.db)}</dd>
        </dl>
      )}
      <Button variant="outline" size="sm" onClick={retry} disabled={state.kind === 'loading'}>
        {t('retry')}
      </Button>
    </section>
  );
}
