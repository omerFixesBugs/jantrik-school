'use client';

import {
  formatCount,
  formatDate,
  formatGpa,
  formatIdentifier,
  formatMarks,
  formatPercentH,
  type ReportCard,
  type ReportCards,
} from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n/config';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/** Columns a phone has no room for (parts, the class highest); always printed. */
const WIDE = 'hidden sm:table-cell print:table-cell';

/**
 * Printed report cards (A4 portrait, one per page: the `exam-print` named page in globals.css),
 * Bangla first. What a card may show is decided by the API (parents' names only under decision
 * #19). Black on white in print whatever the theme.
 */
export function ReportCardsPrint({ data }: { data: ReportCards }) {
  return (
    <div className="exam-print print-area flex flex-col gap-6" data-testid="report-cards">
      {data.cards.map((card) => (
        <ReportCardPage key={card.student.id} data={data} card={card} />
      ))}
    </div>
  );
}

function ReportCardPage({ data, card }: { data: ReportCards; card: ReportCard }) {
  const t = useTranslations('exams.print');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = (x: { nameBn: string | null; nameEn: string | null }) =>
    displayName(x.nameBn, x.nameEn, locale);
  const gpa = data.exam.resultMode === 'GPA';
  const decimals = data.grading?.gpaDecimals ?? 2;
  const father =
    locale === 'bn'
      ? (card.student.fatherNameBn ?? card.student.fatherNameEn)
      : (card.student.fatherNameEn ?? card.student.fatherNameBn);
  const mother =
    locale === 'bn'
      ? (card.student.motherNameBn ?? card.student.motherNameEn)
      : (card.student.motherNameEn ?? card.student.motherNameBn);
  return (
    <article
      className="exam-page bg-card mx-auto flex w-full max-w-[210mm] flex-col gap-4 rounded-xl border p-6 text-sm print:max-w-none print:rounded-none print:border-0 print:bg-white print:p-0 print:text-black"
      data-testid="report-card"
    >
      <header className="flex flex-col items-center gap-1 border-b pb-3 text-center">
        <p className="text-lg font-bold">{data.institute.name}</p>
        <p className="text-base font-semibold">{name(data.exam)}</p>
        <p className="text-muted-foreground print:text-black">{t('reportCard')}</p>
      </header>

      <section className="grid grid-cols-[1fr_auto] gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground print:text-black">{t('name')}</dt>
          <dd className="font-semibold">{name(card.student)}</dd>
          <dt className="text-muted-foreground print:text-black">{t('studentId')}</dt>
          <dd className="font-mono whitespace-nowrap">
            {formatIdentifier(card.student.studentCode)}
          </dd>
          <dt className="text-muted-foreground print:text-black">
            {label('class_level', t('class'))}
          </dt>
          <dd>
            {name(data.classLevel)} · {label('section', t('section'))} {card.section.name}
            {card.studyGroup && ` · ${name(card.studyGroup)}`}
          </dd>
          <dt className="text-muted-foreground print:text-black">{label('roll', t('roll'))}</dt>
          <dd className="font-mono">{card.roll != null ? formatIdentifier(card.roll) : '—'}</dd>
          {father && (
            <>
              <dt className="text-muted-foreground print:text-black">{t('father')}</dt>
              <dd>{father}</dd>
            </>
          )}
          {mother && (
            <>
              <dt className="text-muted-foreground print:text-black">{t('mother')}</dt>
              <dd>{mother}</dd>
            </>
          )}
        </dl>
        {card.student.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.student.photoUrl}
            alt=""
            className="size-24 rounded-md border object-cover"
          />
        )}
      </section>

      <table className="w-full border-collapse text-sm" data-testid="report-card-subjects">
        <thead>
          <tr className="border-y">
            <th scope="col" className="py-1.5 pe-2 text-start">
              {t('subject')}
            </th>
            <th scope="col" className={cn(WIDE, 'px-2 py-1.5 text-start')}>
              {t('parts')}
            </th>
            <th scope="col" className="px-2 py-1.5 text-end">
              {t('obtained')}
            </th>
            <th scope="col" className={cn(WIDE, 'px-2 py-1.5 text-end')}>
              {t('highest')}
            </th>
            {gpa && (
              <th scope="col" className="px-2 py-1.5 text-center">
                {t('grade')}
              </th>
            )}
            {gpa && (
              <th scope="col" className="ps-2 py-1.5 text-end">
                {t('point')}
              </th>
            )}
            {!gpa && (
              <th scope="col" className="ps-2 py-1.5 text-center">
                {t('result')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {card.subjects.map((s) => {
            const parts = s.components
              .map(
                (c) =>
                  `${name(c)} ${c.mark ? (c.mark.absent ? t('absent') : formatMarks(c.mark.scoreH ?? 0, locale)) : '—'}`,
              )
              .join(' · ');
            return (
              <tr key={s.subject.id} className="border-b">
                <th scope="row" className="py-1.5 pe-2 text-start font-medium">
                  {name(s.subject)}
                  {s.optional && (
                    <span className="text-muted-foreground ms-1 text-xs print:text-black">
                      ({t('fourth')})
                    </span>
                  )}
                  {/* A phone has no room for the parts column: they go under the name. */}
                  <span className="text-muted-foreground block text-xs font-normal sm:hidden print:hidden">
                    {parts}
                  </span>
                </th>
                <td className={cn(WIDE, 'px-2 py-1.5 text-xs')}>{parts}</td>
                <td className="font-numeric px-2 py-1.5 text-end whitespace-nowrap">
                  {s.status === 'ABSENT' ? t('absent') : formatMarks(s.obtainedH, locale)}/
                  {formatCount(s.fullMarks, locale)}
                </td>
                <td className={cn(WIDE, 'font-numeric px-2 py-1.5 text-end whitespace-nowrap')}>
                  {s.highestH != null ? formatMarks(s.highestH, locale) : '—'}
                </td>
                {gpa && (
                  <td
                    className={cn(
                      'px-2 py-1.5 text-center font-semibold',
                      !s.passed && 'text-destructive print:text-black',
                    )}
                  >
                    {s.letter ?? '—'}
                  </td>
                )}
                {gpa && (
                  <td className="font-numeric ps-2 py-1.5 text-end whitespace-nowrap">
                    {s.gradePoint != null
                      ? formatGpa(Math.round(s.gradePoint * 100), 2, locale)
                      : '—'}
                  </td>
                )}
                {!gpa && (
                  <td className="ps-2 py-1.5 text-center">{s.passed ? t('pass') : t('fail')}</td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-b font-semibold">
            <th scope="row" className="py-1.5 pe-2 text-start">
              {t('total')}
            </th>
            <td className={WIDE} />
            <td className="font-numeric px-2 py-1.5 text-end whitespace-nowrap">
              {formatMarks(card.totalH, locale)}/{formatCount(card.fullMarks, locale)}
            </td>
            <td className={cn(WIDE, 'font-numeric px-2 py-1.5 text-end whitespace-nowrap')}>
              {formatPercentH(card.percentH, locale)}%
            </td>
            <td
              colSpan={gpa ? 2 : 1}
              className="font-numeric ps-2 py-1.5 text-end whitespace-nowrap sm:hidden print:hidden"
            >
              {formatPercentH(card.percentH, locale)}%
            </td>
            <td colSpan={gpa ? 2 : 1} className={WIDE} />
          </tr>
        </tfoot>
      </table>

      <section className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3"
          data-testid="report-card-summary"
        >
          {gpa && (
            <>
              <dt>{t('gpa')}</dt>
              <dd className="font-numeric text-base font-bold">
                {card.gpaH != null ? formatGpa(card.gpaH, decimals, locale) : '—'} (
                {card.letter ?? '—'})
              </dd>
              <dt>{t('gpaWithoutFourth')}</dt>
              <dd className="font-numeric">
                {card.gpaWithoutOptionalH != null
                  ? formatGpa(card.gpaWithoutOptionalH, decimals, locale)
                  : '—'}
              </dd>
            </>
          )}
          <dt>{t('result')}</dt>
          <dd className="font-semibold">
            {card.passed
              ? t('passed')
              : t('failed', { count: formatCount(card.failedSubjects, locale) })}
          </dd>
          <dt>{t('classPosition')}</dt>
          <dd className="font-numeric">
            {card.classPosition != null
              ? t('positionOf', {
                  position: formatCount(card.classPosition, locale),
                  size: formatCount(card.classSize, locale),
                })
              : '—'}
          </dd>
          <dt>{t('sectionPosition')}</dt>
          <dd className="font-numeric">
            {card.sectionPosition != null ? formatCount(card.sectionPosition, locale) : '—'}
          </dd>
          {card.attendance && (
            <>
              <dt>{t('attendance')}</dt>
              <dd className="font-numeric">
                {t('attendanceDays', {
                  present: formatCount(card.attendance.present, locale),
                  total: formatCount(card.attendance.total, locale),
                })}
                {card.attendance.percentH != null &&
                  ` (${formatPercentH(card.attendance.percentH, locale)}%)`}
              </dd>
            </>
          )}
        </dl>
        {data.grading && (
          <table className="w-full rounded-lg border text-xs" aria-label={t('gradingKey')}>
            <thead>
              <tr className="border-b">
                <th scope="col" className="px-2 py-1 text-start">
                  {t('marksRange')}
                </th>
                <th scope="col" className="px-2 py-1 text-center">
                  {t('grade')}
                </th>
                <th scope="col" className="px-2 py-1 text-end">
                  {t('point')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.grading.bands.map((b) => (
                <tr key={b.letter}>
                  <td className="font-numeric px-2 py-0.5">
                    {formatCount(b.minPercent, locale)}–{formatCount(b.maxPercent, locale)}
                  </td>
                  <td className="px-2 py-0.5 text-center">{b.letter}</td>
                  <td className="font-numeric px-2 py-0.5 text-end">
                    {formatGpa(Math.round(b.gradePoint * 100), 2, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border p-3">
        <p className="text-muted-foreground text-xs print:text-black">{t('remarks')}</p>
        <p className="min-h-10">{card.remarks ?? ''}</p>
      </section>

      <footer className="mt-6 grid grid-cols-3 gap-6 text-center text-xs">
        {(['classTeacher', 'headTeacher', 'guardian'] as const).map((who) => (
          <p key={who} className="border-t pt-1">
            {t(who)}
          </p>
        ))}
      </footer>
      <p className="text-muted-foreground text-end text-xs print:text-black">
        {t('publishedOn', { date: formatDate(data.publishedAt, locale) })}
      </p>
    </article>
  );
}
