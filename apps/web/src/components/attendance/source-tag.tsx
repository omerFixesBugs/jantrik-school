'use client';

import type { AttendanceSource } from '@jantrik/shared';
import { FingerprintIcon, PencilLineIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill } from '@/components/kit/pill';

/**
 * Who set a record: the device (its punches) or a person by hand. Icon and word, quiet tones:
 * a source is a fact, not a status.
 */
export function SourceTag({ source, className }: { source: AttendanceSource; className?: string }) {
  const t = useTranslations('attendance');
  const Icon = source === 'DEVICE' ? FingerprintIcon : PencilLineIcon;
  return (
    <Pill tone={source === 'DEVICE' ? 'info' : 'neutral'} className={className}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {t(`source${source}`)}
    </Pill>
  );
}
