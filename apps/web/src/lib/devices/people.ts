import { toAsciiDigits, type DevicePersonKind, type DevicePersonRow } from '@jantrik/shared';

/*
 * The people ↔ device IDs list is loaded once (students and staff together, with the counts);
 * these narrow it in the browser: the kind, people without an ID, a section, and a search.
 */

export interface PeopleFilter {
  kind: DevicePersonKind;
  unmappedOnly: boolean;
  /** Students only; '' for every section. */
  sectionId: string;
  query: string;
}

const SECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filter a link opens with: `unmapped=1` (people without an ID) and `section=<id>` (the
 * today page's "give IDs"), plus a search (an unknown ID from the feed). Students first.
 */
export function peopleFilterFromUrl(params: URLSearchParams, query: string): PeopleFilter {
  const section = params.get('section') ?? '';
  return {
    kind: 'STUDENT',
    unmappedOnly: params.get('unmapped') === '1',
    sectionId: SECTION_ID.test(section) ? section : '',
    query,
  };
}

/** The URL's parameters for a filter: "without an ID" and the students' section stay in it. */
export function peopleFilterUrl(params: URLSearchParams, f: PeopleFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  if (f.unmappedOnly) next.set('unmapped', '1');
  else next.delete('unmapped');
  if (f.kind === 'STUDENT' && f.sectionId) next.set('section', f.sectionId);
  else next.delete('section');
  return next;
}

/** What a search looks in: both names, the student code, the ID and the suggested ID. */
const haystack = (p: DevicePersonRow): string =>
  toAsciiDigits(
    (p.kind === 'STUDENT' ? [p.nameBn, p.nameEn, p.studentCode] : [p.name, p.nameBn])
      .concat(p.deviceUserId, p.suggested)
      .filter(Boolean)
      .join(' '),
  ).toLowerCase();

export function filterPeople(rows: readonly DevicePersonRow[], f: PeopleFilter): DevicePersonRow[] {
  const query = toAsciiDigits(f.query).trim().toLowerCase();
  return rows.filter(
    (p) =>
      p.kind === f.kind &&
      (!f.unmappedOnly || p.deviceUserId === null) &&
      (p.kind === 'STAFF' || !f.sectionId || p.section?.id === f.sectionId) &&
      (!query || haystack(p).includes(query)),
  );
}

/** The students' sections, once each, in list order ("ষষ্ঠ ক"). */
export function sectionChoices(
  rows: readonly DevicePersonRow[],
  locale: 'bn' | 'en',
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const p of rows) {
    if (p.kind !== 'STUDENT' || !p.section || seen.has(p.section.id)) continue;
    const cls = locale === 'bn' ? p.classLevel.nameBn : p.classLevel.nameEn;
    seen.set(p.section.id, `${cls} ${p.section.name}`);
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}
