'use client';

import {
  formatCount,
  formatDate,
  formatGpa,
  formatIdentifier,
  formatMarks,
  formatPercentH,
  formatWallClock,
  type AdmitCards,
  type SeatPlan,
  type Tabulation,
} from '@jantrik/shared';
import { ChevronLeftIcon, DownloadIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { downloadFile } from '@/components/fees/reports/kit';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/** Back to the exam, and Print (the browser's own "Save as PDF" makes the PDF). Never printed. */
export function PrintToolbar({ examId, children }: { examId: string; children?: ReactNode }) {
  const t = useTranslations('exams.print');
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <Link
        href={`/exams/${examId}?tab=results`}
        className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) items-center gap-1 text-sm"
      >
        <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('back')}
      </Link>
      <span className="flex-1" />
      {children}
      <Button onClick={() => window.print()} data-testid="print">
        <PrinterIcon aria-hidden />
        {t('print')}
      </Button>
    </div>
  );
}

/** The tabulation sheet: one row per student, every subject's marks and grade (A4 landscape). */
export function TabulationSheet({
  data,
  examId,
  examClassId,
}: {
  data: Tabulation;
  examId: string;
  examClassId: string;
}) {
  const t = useTranslations('exams.print');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client } = useAuth();
  const name = (x: { nameBn: string | null; nameEn: string | null }) =>
    displayName(x.nameBn, x.nameEn, locale);
  const gpa = data.exam.resultMode === 'GPA';
  const query = new URLSearchParams({
    locale,
    ...(data.section ? { sectionId: data.section.id } : {}),
  });
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PrintToolbar examId={examId}>
        <Button
          variant="outline"
          onClick={() =>
            void downloadFile(
              client,
              `/exams/${examId}/classes/${examClassId}/tabulation/csv?${query}`,
              `tabulation-${data.classLevel.code}.csv`,
            )
          }
          data-testid="tabulation-csv"
        >
          <DownloadIcon aria-hidden />
          {t('csv')}
        </Button>
      </PrintToolbar>
      <section
        className="print-area bg-card rounded-card flex flex-col gap-3 border p-(--panel-p) print:border-0 print:p-0"
        data-testid="tabulation"
      >
        <header>
          <h2 className="text-lg font-semibold">
            {t('tabulationTitle')} · {name(data.exam)} · {name(data.classLevel)}
            {data.section && ` ${data.section.name}`}
          </h2>
          <p
            className="text-muted-foreground text-sm print:text-black"
            data-testid="tabulation-source"
          >
            {data.source === 'PREVIEW'
              ? t('preview')
              : data.stale
                ? t('stale', { version: formatCount(data.publishedVersion, locale) })
                : t('publishedVersion', { version: formatCount(data.publishedVersion, locale) })}
          </p>
        </header>
        <div className="print-unbound overflow-x-auto">
          <table className="tabulation-table w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="sticky start-0 bg-card px-2 py-1.5 text-start">
                  {t('position')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start">
                  {label('roll', t('roll'))}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start">
                  {t('name')}
                </th>
                {data.subjects.map((s) => (
                  <th
                    key={s.examSubjectId}
                    scope="col"
                    className="px-2 py-1.5 text-end"
                    title={name(s.subject)}
                  >
                    {s.subject.code}
                  </th>
                ))}
                <th scope="col" className="px-2 py-1.5 text-end">
                  {t('total')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-end">
                  %
                </th>
                {gpa && (
                  <th scope="col" className="px-2 py-1.5 text-end">
                    {t('gpa')}
                  </th>
                )}
                <th scope="col" className="px-2 py-1.5 text-center">
                  {t('result')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.studentId} className="border-b" data-testid="tabulation-row">
                  <td className="font-numeric sticky start-0 bg-card px-2 py-1">
                    {r.classPosition != null ? formatCount(r.classPosition, locale) : '—'}
                  </td>
                  <td className="px-2 py-1 font-mono">
                    {r.roll != null ? formatIdentifier(r.roll) : '—'}
                    {!data.section && ` ${r.section.name}`}
                  </td>
                  <td className="max-w-48 truncate px-2 py-1">{name(r)}</td>
                  {data.subjects.map((s) => {
                    const cell = r.subjects.find((x) => x.examSubjectId === s.examSubjectId);
                    return (
                      <td
                        key={s.examSubjectId}
                        className={cn(
                          'font-numeric px-2 py-1 text-end',
                          cell &&
                            !cell.passed &&
                            'text-destructive print:font-bold print:text-black',
                        )}
                      >
                        {!cell
                          ? ''
                          : cell.status === 'ABSENT'
                            ? t('absentShort')
                            : formatMarks(cell.obtainedH, locale)}
                        {cell && gpa && cell.letter && (
                          <span className="text-muted-foreground ms-1 text-xs print:text-black">
                            {cell.letter}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="font-numeric px-2 py-1 text-end font-semibold">
                    {formatMarks(r.totalH, locale)}
                  </td>
                  <td className="font-numeric px-2 py-1 text-end">
                    {formatPercentH(r.percentH, locale)}
                  </td>
                  {gpa && (
                    <td className="font-numeric px-2 py-1 text-end font-semibold">
                      {r.gpaH != null
                        ? `${formatGpa(r.gpaH, data.gpaDecimals, locale)} ${r.letter ?? ''}`
                        : '—'}
                    </td>
                  )}
                  <td className="px-2 py-1 text-center">
                    {!r.complete ? t('incomplete') : r.passed ? t('pass') : t('fail')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Admit cards, two to an A4 sheet with a cut line: who, where they sit, their own routine. */
export function AdmitCardsPrint({ data, examId }: { data: AdmitCards; examId: string }) {
  const t = useTranslations('exams.print');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = (x: { nameBn: string | null; nameEn: string | null }) =>
    displayName(x.nameBn, x.nameEn, locale);
  const pages: AdmitCards['cards'][] = [];
  for (let i = 0; i < data.cards.length; i += 2) pages.push(data.cards.slice(i, i + 2));
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PrintToolbar examId={examId} />
      <div className="exam-print print-area flex flex-col gap-6" data-testid="admit-cards">
        {pages.map((pair, i) => (
          <div key={i} className="exam-page flex flex-col gap-6">
            {pair.map((c, j) => (
              <article
                key={c.candidateId}
                className={cn(
                  'bg-card mx-auto flex w-full max-w-[190mm] flex-col gap-3 rounded-xl border p-5 text-sm print:min-h-[128mm] print:rounded-none print:bg-white print:text-black',
                  j === 0 && pair.length > 1 && 'print:border-b-2 print:border-dashed',
                )}
                data-testid="admit-card"
              >
                <header className="text-center">
                  <p className="text-base font-bold">{data.institute.name}</p>
                  <p className="font-semibold">{name(data.exam)}</p>
                  <p className="text-muted-foreground print:text-black">{t('admitCard')}</p>
                </header>
                <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground print:text-black">{t('name')}</dt>
                  <dd className="col-span-3 font-semibold">{name(c.student)}</dd>
                  <dt className="text-muted-foreground print:text-black">{t('studentId')}</dt>
                  <dd className="font-mono">{formatIdentifier(c.student.studentCode)}</dd>
                  <dt className="text-muted-foreground print:text-black">
                    {label('roll', t('roll'))}
                  </dt>
                  <dd className="font-mono">{c.roll != null ? formatIdentifier(c.roll) : '—'}</dd>
                  <dt className="text-muted-foreground print:text-black">
                    {label('class_level', t('class'))}
                  </dt>
                  <dd>
                    {name(c.classLevel)} {c.section.name}
                    {c.studyGroup && ` · ${name(c.studyGroup)}`}
                  </dd>
                  <dt className="text-muted-foreground print:text-black">{t('seat')}</dt>
                  <dd>
                    {c.seat
                      ? t('seatAt', {
                          room: c.seat.roomName,
                          seat: formatCount(c.seat.seatNo, locale),
                        })
                      : '—'}
                  </dd>
                </dl>
                {c.routine.length > 0 && (
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-y">
                        <th scope="col" className="py-1 text-start">
                          {t('date')}
                        </th>
                        <th scope="col" className="py-1 text-start">
                          {t('time')}
                        </th>
                        <th scope="col" className="py-1 text-start">
                          {t('subject')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.routine.map((r) => (
                        <tr key={r.subject.id} className="border-b">
                          <td className="py-0.5">
                            {r.examDate ? formatDate(r.examDate, locale) : '—'}
                          </td>
                          <td className="py-0.5">
                            {r.startTime ? formatWallClock(r.startTime, locale) : '—'}
                          </td>
                          <td className="py-0.5">{name(r.subject)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <footer className="mt-auto grid grid-cols-2 gap-6 pt-6 text-center text-xs">
                  <p className="border-t pt-1">{t('studentSignature')}</p>
                  <p className="border-t pt-1">{t('headTeacher')}</p>
                </footer>
              </article>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The seat plan: per room, the benches as a grid (row by row) and a door list by class. */
export function SeatPlanPrint({ data, examId }: { data: SeatPlan; examId: string }) {
  const t = useTranslations('exams.print');
  const locale = useLocale() as Locale;
  const name = (x: { nameBn: string | null; nameEn: string | null }) =>
    displayName(x.nameBn, x.nameEn, locale);
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PrintToolbar examId={examId} />
      <div className="print-area flex flex-col gap-6" data-testid="seat-plan">
        {data.rooms.length === 0 && <p className="text-muted-foreground">{t('noSeats')}</p>}
        {data.rooms.map((r) => (
          <section
            key={r.room.id}
            className="seat-room bg-card rounded-card flex flex-col gap-3 border p-(--panel-p) print:border-0 print:p-0"
          >
            <h2 className="text-lg font-semibold">
              {r.room.name} ·{' '}
              {t('seatsCount', {
                count: formatCount(r.seats.length, locale),
                capacity: formatCount(r.room.capacity, locale),
              })}
            </h2>
            <ol
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${r.room.cols}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: r.room.capacity }, (_, i) => {
                const seat = r.seats.find((s) => s.seatNo === i + 1);
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex min-h-14 flex-col rounded-md border p-1.5 text-xs',
                      !seat && 'border-dashed opacity-60',
                    )}
                  >
                    <span className="font-numeric text-muted-foreground print:text-black">
                      {formatCount(i + 1, locale)}
                    </span>
                    {seat && (
                      <>
                        <span className="font-semibold">
                          {name(seat.classLevel)} {seat.sectionName} ·{' '}
                          {seat.roll != null ? formatIdentifier(seat.roll) : '—'}
                        </span>
                        <span className="truncate">{seat.name}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
