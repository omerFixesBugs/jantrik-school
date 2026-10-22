'use client';

import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { CollectionsReport } from '@/components/fees/reports/collections';
import { DueListReport } from '@/components/fees/reports/due-list';
import { PageGate } from '@/components/page-gate';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUrlParams } from '@/lib/view-state';

const TABS = ['dues', 'defaulters', 'collections'] as const;
type Tab = (typeof TABS)[number];

export default function FeeReportsPage() {
  return (
    <PageGate page="fees">
      {/* The report and its filters live in the URL (useSearchParams). */}
      <Suspense>
        <Reports />
      </Suspense>
    </PageGate>
  );
}

/**
 * Fee reports (docs/fees.md → Reports): the due list, the defaulters and the collections, each
 * with its filters in the URL, totals in the footer, a CSV in the page's language and a print
 * of the table alone (landscape A4).
 */
function Reports() {
  const t = useTranslations('fees.reports.dues');
  const { params, set } = useUrlParams();
  const asked = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'dues';
  const labels: Record<Tab, string> = {
    dues: t('tabDues'),
    defaulters: t('tabDefaulters'),
    collections: t('tabCollections'),
  };
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-reports">
      <FeesTabs />
      <Tabs
        value={tab}
        onValueChange={(v: Tab) =>
          // A sort belongs to the table it was chosen in; the class filter carries over.
          set({ tab: v === 'dues' ? null : v, sort: null, dir: null })
        }
        className="gap-(--section-gap)"
      >
        <TabsList aria-label={t('tabsLabel')} className="max-w-full print:hidden">
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key} data-testid={`reports-tab-${key}`}>
              {labels[key]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="dues" className="text-base">
          <DueListReport mode="dues" />
        </TabsContent>
        <TabsContent value="defaulters" className="text-base">
          <DueListReport mode="defaulters" />
        </TabsContent>
        <TabsContent value="collections" className="text-base">
          <CollectionsReport />
        </TabsContent>
      </Tabs>
    </div>
  );
}
