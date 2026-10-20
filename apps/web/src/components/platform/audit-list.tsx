'use client';

import {
  formatBdPhone,
  formatDate,
  formatTaka,
  formatTime,
  type PlatformAuditEntry,
} from '@jantrik/shared';
import { TerminalIcon, UserRoundIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { Locale } from '@/i18n/config';

const KNOWN_ACTIONS = new Set([
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'ADMIN_CREATE',
  'ADMIN_PASSWORD',
  'ADMIN_DISABLE',
  'ADMIN_ENABLE',
  'ADMIN_RESET_2FA',
  'INSTITUTE_CREATE',
  'INSTITUTE_SUSPEND',
  'INSTITUTE_REACTIVATE',
  'INSTITUTE_MODULE_ON',
  'INSTITUTE_MODULE_OFF',
  'INSTITUTE_LIMITS',
  'INSTITUTE_OWNER_INVITE',
  'INSTITUTE_OWNER_REINVITE',
  'INSTITUTE_OWNER_CANCEL',
  'INSTITUTE_PLAN',
  'INSTITUTE_ACTIVATE',
  'INVOICE_ISSUE',
  'INVOICES_GENERATE',
  'PAYMENT_RECORD',
  'INVOICE_VOID',
  'SETTINGS_SMS_COST',
]);
const MODULES = new Set(['ATTENDANCE', 'FEES', 'EXAMS']);

const KNOWN_REASONS = new Set(['BAD_CODE', 'CODE_REUSED', 'BAD_BACKUP_CODE', 'TOO_MANY_ATTEMPTS']);

/** Platform audit entries: who did what, when (cards: they read well at 360 px and 1440 px). */
export function AuditList({ entries }: { entries: PlatformAuditEntry[] }) {
  const t = useTranslations('platform');
  const tModules = useTranslations('platformInstitutes.modules');
  const locale = useLocale() as Locale;
  const label = (action: string) => (KNOWN_ACTIONS.has(action) ? t(`action_${action}`) : action);
  const detail = (e: PlatformAuditEntry): string | null => {
    const d = e.details ?? {};
    const reason = d['reason'];
    if (typeof reason === 'string') {
      return KNOWN_REASONS.has(reason) ? t(`reason_${reason}`) : t('auditReason', { reason }); // free text, e.g. from the CLI
    }
    if (typeof d['method'] === 'string') return t(`method_${d['method']}`);
    if (e.action === 'SETTINGS_SMS_COST' && typeof d['to'] === 'number') {
      const from = typeof d['from'] === 'number' ? formatTaka(d['from'], locale) : '—';
      return `${from} → ${formatTaka(d['to'], locale)}`;
    }
    if (typeof d['module'] === 'string' && MODULES.has(d['module'])) return tModules(d['module']);
    if (typeof d['phone'] === 'string') return formatBdPhone(d['phone']);
    return null;
  };
  if (entries.length === 0) return <p className="text-muted-foreground">{t('auditEmpty')}</p>;
  return (
    <ul
      className="flex flex-col divide-y rounded-xl border bg-card"
      data-testid="platform-audit-list"
    >
      {entries.map((e) => {
        const extra = detail(e);
        return (
          <li
            key={e.id}
            className="flex flex-col gap-1 px-4 py-3"
            data-testid="platform-audit-entry"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{label(e.action)}</span>
              {e.action === 'LOGIN_FAILED' && <Badge variant="warning">{t('failed')}</Badge>}
              {e.targetTenantName && <Badge variant="soft">{e.targetTenantName}</Badge>}
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1">
                {e.actor === 'CLI' ? (
                  <TerminalIcon aria-hidden className="size-3.5" />
                ) : (
                  <UserRoundIcon aria-hidden className="size-3.5" />
                )}
                {e.actor === 'CLI' ? t('actorCli') : (e.adminName ?? '—')}
              </span>
              <span>
                {formatDate(new Date(e.createdAt), locale, 'medium')} ·{' '}
                {formatTime(new Date(e.createdAt), locale)}
              </span>
              {extra && <span className="break-words">{extra}</span>}
              {e.ip && (
                <span dir="ltr" className="font-numeric">
                  {e.ip}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
