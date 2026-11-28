// The admission test and its merit list (sprint 1 P4, docs/admission.md → "The admission test"):
// the merit order, the result SMS text and the API's shapes. No zod here (the public status page
// imports this file); the input schemas are in admission-schema.ts.

import type { AdmissionApplicationStatus, AdmissionNamed } from './admission.js';
import type { IsoDate } from './dates.js';
import { formatCount, formatIdentifier } from './format.js';

export const ADMISSION_TIE_BREAKS = ['OLDER_FIRST', 'YOUNGER_FIRST', 'NONE'] as const;
export type AdmissionTieBreak = (typeof ADMISSION_TIE_BREAKS)[number];

export const ADMISSION_TEST_RESULTS = [
  'SELECTED',
  'WAITLISTED',
  'NOT_SELECTED',
  'FAILED',
  'ABSENT',
] as const;
export type AdmissionTestResult = (typeof ADMISSION_TEST_RESULTS)[number];

/** The reason a publish gives a REJECTED applicant (decision P4-E). */
export const ADMISSION_TEST_REJECT_REASONS = ['NOT_SELECTED', 'FAILED', 'ABSENT'] as const;

// ─────────────────────────── The merit list ───────────────────────────

export interface MeritApplicant {
  id: string;
  /** Hundredths; null with `absent` (a row with neither is treated as absent). */
  scoreH: number | null;
  absent: boolean;
  dateOfBirth: IsoDate;
  /** ISO instant. */
  submittedAt: string;
}

export interface MeritOutcome {
  result: AdmissionTestResult;
  meritPosition: number | null;
  waitlistPosition: number | null;
}

export interface MeritOptions {
  tieBreak: AdmissionTieBreak;
  /** Hundredths; null: nobody fails (decision P4-D). */
  passMarksH: number | null;
  selectCount: number;
  waitlistCount: number;
}

/**
 * The merit list (sprint plan P4, decisions P4-A, P4-B, P4-D): absent and below the pass marks are
 * unranked (ABSENT, FAILED). The rest are ranked by score (higher first), then by the cycle's
 * tie-break (the older or the younger by date of birth, then the earlier submission; NONE: the
 * score alone). Rows equal on every key share a place and the next place skips (1, 2, 2, 4), as
 * `meritPositions()`. Places up to `selectCount` are SELECTED, everyone sharing the last of them
 * too (`boundaryTie` counts the extra seats); the next `waitlistCount` places are WAITLISTED with
 * positions 1..n (shared the same way, `waitlistTie` the extra), the rest NOT_SELECTED. The input
 * order never changes the output.
 */
export function admissionMerit(
  rows: readonly MeritApplicant[],
  opts: MeritOptions,
): { outcomes: Map<string, MeritOutcome>; boundaryTie: number; waitlistTie: number } {
  const outcomes = new Map<string, MeritOutcome>();
  const ranked: (MeritApplicant & { scoreH: number })[] = [];
  for (const r of rows) {
    if (r.absent || r.scoreH === null) {
      outcomes.set(r.id, { result: 'ABSENT', meritPosition: null, waitlistPosition: null });
    } else if (opts.passMarksH !== null && r.scoreH < opts.passMarksH) {
      outcomes.set(r.id, { result: 'FAILED', meritPosition: null, waitlistPosition: null });
    } else {
      ranked.push({ ...r, scoreH: r.scoreH });
    }
  }
  const compare = (a: (typeof ranked)[number], b: (typeof ranked)[number]): number => {
    if (a.scoreH !== b.scoreH) return b.scoreH - a.scoreH;
    if (opts.tieBreak === 'NONE') return 0;
    if (a.dateOfBirth !== b.dateOfBirth) {
      const olderFirst = a.dateOfBirth < b.dateOfBirth ? -1 : 1;
      return opts.tieBreak === 'OLDER_FIRST' ? olderFirst : -olderFirst;
    }
    return Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
  };
  // The id last: equal rows sort the same way whatever the input order (their places are equal).
  const sorted = [...ranked].sort((a, b) => compare(a, b) || (a.id < b.id ? -1 : 1));
  const places = new Map<string, number>();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    places.set(r.id, prev && compare(prev, r) === 0 ? places.get(prev.id)! : i + 1);
  });
  const selected = sorted.filter((r) => places.get(r.id)! <= opts.selectCount).length;
  const waitlistUpTo = selected + opts.waitlistCount;
  let waitlisted = 0;
  for (const r of sorted) {
    const place = places.get(r.id)!;
    if (place <= opts.selectCount) {
      outcomes.set(r.id, { result: 'SELECTED', meritPosition: place, waitlistPosition: null });
    } else if (opts.waitlistCount > 0 && place <= waitlistUpTo) {
      waitlisted++;
      outcomes.set(r.id, {
        result: 'WAITLISTED',
        meritPosition: place,
        waitlistPosition: place - selected,
      });
    } else {
      outcomes.set(r.id, { result: 'NOT_SELECTED', meritPosition: place, waitlistPosition: null });
    }
  }
  return {
    outcomes,
    boundaryTie: Math.max(0, selected - opts.selectCount),
    waitlistTie: Math.max(0, waitlisted - opts.waitlistCount),
  };
}

// ─────────────────────────── The result SMS (P4-H) ───────────────────────────

/**
 * The outcome, the merit place or the waitlist position, the application number and the status
 * page link; never the score (that is on the status page, behind the phone code).
 */
export function admissionResultSmsText(input: {
  institute: string;
  applicationNo: string;
  outcome: 'SELECTED' | 'WAITLISTED' | 'REJECTED';
  meritPosition: number | null;
  waitlistPosition: number | null;
  statusUrl: string | null;
  locale: 'bn' | 'en';
}): string {
  const no = formatIdentifier(input.applicationNo);
  const n = (v: number) => formatCount(v, input.locale);
  if (input.locale === 'en') {
    const what =
      input.outcome === 'SELECTED'
        ? `selected in the admission test${input.meritPosition ? ` (merit place ${n(input.meritPosition)})` : ''}`
        : input.outcome === 'WAITLISTED'
          ? `on the waitlist${input.waitlistPosition ? `, number ${n(input.waitlistPosition)}` : ''}`
          : 'not selected in the admission test';
    const link = input.statusUrl ? ` Details: ${input.statusUrl}` : '';
    return `${input.institute}: application ${no} is ${what}.${link}`;
  }
  const what =
    input.outcome === 'SELECTED'
      ? `ভর্তি পরীক্ষায় নির্বাচিত হয়েছে${input.meritPosition ? ` (মেধাক্রম ${n(input.meritPosition)})` : ''}`
      : input.outcome === 'WAITLISTED'
        ? `অপেক্ষমাণ তালিকায় আছে${input.waitlistPosition ? ` (ক্রম ${n(input.waitlistPosition)})` : ''}`
        : 'ভর্তি পরীক্ষায় নির্বাচিত হয়নি';
  const link = input.statusUrl ? ` বিস্তারিত: ${input.statusUrl}` : '';
  return `${input.institute}: আবেদন ${no} ${what}।${link}`;
}

// ─────────────────────────── API shapes (staff) ───────────────────────────

/** A class's test: its setup, where the draft and the published list stand, and counts. */
export interface AdmissionTestClassView {
  id: string;
  cycle: {
    id: string;
    nameBn: string;
    nameEn: string | null;
    requiresTest: boolean;
    meritTieBreak: AdmissionTieBreak;
  };
  classLevel: AdmissionNamed;
  studyGroup: AdmissionNamed | null;
  testDate: IsoDate | null;
  /** "HH:MM", the institute's local time. */
  testTime: string | null;
  testVenueBn: string | null;
  testVenueEn: string | null;
  fullMarks: number | null;
  passMarks: number | null;
  selectCount: number | null;
  waitlistCount: number | null;
  /** ISO instants. */
  meritBuiltAt: string | null;
  resultsVersion: number;
  resultsPublishedAt: string | null;
  /** A score changed after the last publish (decision P4-J). */
  changedSincePublish: boolean;
  counts: {
    /** Applications that take the test (they have a roll). */
    withRoll: number;
    /** SUBMITTED or SHORTLISTED applications still without a roll. */
    awaitingRoll: number;
    scored: number;
    absent: number;
  };
}

export interface AdmissionScoreRow {
  applicationId: string;
  applicationNo: string;
  testRoll: number;
  nameBn: string | null;
  nameEn: string | null;
  scoreH: number | null;
  absent: boolean;
  status: AdmissionApplicationStatus;
}

export interface AdmissionMeritRow extends AdmissionScoreRow {
  dateOfBirth: IsoDate;
  testResult: AdmissionTestResult | null;
  meritPosition: number | null;
  waitlistPosition: number | null;
  resultFlag: string | null;
  /** The published snapshot, when this row has one. */
  published: {
    version: number;
    meritPosition: number | null;
    waitlistPosition: number | null;
  } | null;
}

export interface AdmissionMeritView {
  /** The draft's build time (ISO) or null; publish sends it back. */
  builtAt: string | null;
  /** The build the published version came from: equal to `builtAt` means nothing to publish. */
  publishedBuiltAt: string | null;
  /** The draft no longer matches the scores, statuses or settings: build again. */
  stale: boolean;
  /** Extra seats used by a tie on the last selected place; on the last waitlisted one. */
  boundaryTie: number;
  waitlistTie: number;
  counts: Record<AdmissionTestResult, number>;
  rows: AdmissionMeritRow[];
}

export interface AdmissionAdmitCard {
  applicationId: string;
  applicationNo: string;
  testRoll: number;
  nameBn: string | null;
  nameEn: string | null;
  hasPhoto: boolean;
}

export interface AdmissionAdmitCards {
  institute: { name: string; nameBn: string | null; nameEn: string | null; hasLogo: boolean };
  cycle: { nameBn: string; nameEn: string | null };
  classLevel: AdmissionNamed;
  studyGroup: AdmissionNamed | null;
  testDate: IsoDate | null;
  testTime: string | null;
  testVenueBn: string | null;
  testVenueEn: string | null;
  cards: AdmissionAdmitCard[];
}

export interface AdmissionResultSmsPreview {
  publishedVersion: number;
  /** Applications with a published result. */
  applications: number;
  /** Those whose status changed since their last result SMS (the first time: all of them). */
  toSend: number;
  segments: number;
  costPaisa: number;
  capLeftToday: number;
  wouldBeSkipped: number;
  sampleText: string | null;
}

export interface AdmissionResultSmsRun {
  runId: string;
  queued: number;
}

export interface AdmissionMoveUpResult {
  /** The applications that became SELECTED (more than one only for a tie, P4-a7). */
  moved: { applicationId: string; applicationNo: string }[];
}

// ─────────────────────────── API shapes (the public status page) ───────────────────────────

/** The test's details once a roll is issued (decision P4-M). */
export interface AdmissionPublicTest {
  roll: number;
  date: IsoDate | null;
  time: string | null;
  venueBn: string | null;
  venueEn: string | null;
}

/** The published result (S13): the status is the outcome, never the draft. */
export interface AdmissionPublicResult {
  version: number;
  meritPosition: number | null;
  waitlistPosition: number | null;
  scoreH: number | null;
  fullMarks: number;
  absent: boolean;
  publishedAt: string;
}
