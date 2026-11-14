import type { DevicePersonRow } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { filterPeople, peopleFilterFromUrl, peopleFilterUrl, sectionChoices } from './people';

const student = (
  id: string,
  over: Partial<Extract<DevicePersonRow, { kind: 'STUDENT' }>> = {},
): DevicePersonRow => ({
  kind: 'STUDENT',
  id,
  nameBn: `ছাত্র ${id}`,
  nameEn: `Student ${id}`,
  studentCode: `S-0${id}`,
  classLevel: { id: 'c6', nameBn: 'ষষ্ঠ', nameEn: 'Six' },
  section: { id: 'a', name: 'ক' },
  deviceUserId: null,
  suggested: null,
  sync: 'NONE',
  ...over,
});
const staff = (id: string, deviceUserId: string | null = null): DevicePersonRow => ({
  kind: 'STAFF',
  id,
  name: `Teacher ${id}`,
  nameBn: `শিক্ষক ${id}`,
  roles: ['TEACHER'],
  deviceUserId,
  suggested: null,
  sync: 'NONE',
});

const ROWS: DevicePersonRow[] = [
  student('101', { deviceUserId: '101' }),
  student('102', { suggested: '102' }),
  student('103', { section: { id: 'b', name: 'খ' }, suggested: '103' }),
  student('201', {
    classLevel: { id: 'c7', nameBn: 'সপ্তম', nameEn: 'Seven' },
    section: null,
  }),
  staff('t1', '9001'),
  staff('t2'),
];
const ids = (rows: DevicePersonRow[]) => rows.map((r) => r.id);
const all = { kind: 'STUDENT' as const, unmappedOnly: false, sectionId: '', query: '' };

describe('filterPeople', () => {
  it('shows one kind at a time', () => {
    expect(ids(filterPeople(ROWS, all))).toEqual(['101', '102', '103', '201']);
    expect(ids(filterPeople(ROWS, { ...all, kind: 'STAFF' }))).toEqual(['t1', 't2']);
  });

  it('keeps only people without an ID when asked', () => {
    expect(ids(filterPeople(ROWS, { ...all, unmappedOnly: true }))).toEqual(['102', '103', '201']);
    expect(ids(filterPeople(ROWS, { ...all, kind: 'STAFF', unmappedOnly: true }))).toEqual(['t2']);
  });

  it('narrows students to a section; staff ignore it', () => {
    expect(ids(filterPeople(ROWS, { ...all, sectionId: 'b' }))).toEqual(['103']);
    expect(ids(filterPeople(ROWS, { ...all, kind: 'STAFF', sectionId: 'b' }))).toEqual([
      't1',
      't2',
    ]);
  });

  it('searches names in both languages, codes, IDs and suggestions, Bangla digits too', () => {
    expect(ids(filterPeople(ROWS, { ...all, query: 'ছাত্র ১০২' }))).toEqual(['102']);
    expect(ids(filterPeople(ROWS, { ...all, query: 'student 103' }))).toEqual(['103']);
    expect(ids(filterPeople(ROWS, { ...all, query: 's-0201' }))).toEqual(['201']);
    expect(ids(filterPeople(ROWS, { ...all, query: '১০১' }))).toEqual(['101']);
    expect(ids(filterPeople(ROWS, { ...all, kind: 'STAFF', query: '9001' }))).toEqual(['t1']);
    expect(ids(filterPeople(ROWS, { ...all, query: '  ' }))).toEqual(['101', '102', '103', '201']);
  });
});

describe('sectionChoices', () => {
  it('lists each section of the students once, in list order', () => {
    expect(sectionChoices(ROWS, 'bn')).toEqual([
      { value: 'a', label: 'ষষ্ঠ ক' },
      { value: 'b', label: 'ষষ্ঠ খ' },
    ]);
    expect(sectionChoices(ROWS, 'en')[0]).toEqual({ value: 'a', label: 'Six ক' });
  });
});

describe('the filter in the URL', () => {
  const SECTION = '01a16c54-85f8-724c-91ff-c2b68b7b2b31';

  it('opens on the students without an ID of one section from a link', () => {
    expect(peopleFilterFromUrl(new URLSearchParams(`unmapped=1&section=${SECTION}`), '')).toEqual({
      kind: 'STUDENT',
      unmappedOnly: true,
      sectionId: SECTION,
      query: '',
    });
  });

  it('starts on every student, with a search when one is given', () => {
    expect(peopleFilterFromUrl(new URLSearchParams(''), '4321')).toEqual({
      kind: 'STUDENT',
      unmappedOnly: false,
      sectionId: '',
      query: '4321',
    });
    // Anything else in the place of a section or a flag is ignored.
    expect(peopleFilterFromUrl(new URLSearchParams('unmapped=yes&section=x'), '')).toMatchObject({
      unmappedOnly: false,
      sectionId: '',
    });
  });

  it('keeps "without an ID" and the section in the URL, other parameters as they are', () => {
    const base = new URLSearchParams('unknown=4321');
    const on = peopleFilterUrl(base, {
      kind: 'STUDENT',
      unmappedOnly: true,
      sectionId: SECTION,
      query: 'x',
    });
    expect(Object.fromEntries(on)).toEqual({ unknown: '4321', unmapped: '1', section: SECTION });
    const off = peopleFilterUrl(on, {
      kind: 'STAFF',
      unmappedOnly: false,
      sectionId: SECTION,
      query: '',
    });
    // Staff have no section: it leaves the URL with the flag; the staff list stays in it.
    expect(Object.fromEntries(off)).toEqual({ unknown: '4321', kind: 'staff' });
    const back = peopleFilterUrl(off, { ...all, unmappedOnly: false });
    expect(Object.fromEntries(back)).toEqual({ unknown: '4321' });
  });

  it('a reload of the staff without an ID shows the staff without an ID again', () => {
    const staffUnmapped = { kind: 'STAFF' as const, unmappedOnly: true, sectionId: '', query: '' };
    const url = peopleFilterUrl(new URLSearchParams(''), staffUnmapped);
    expect(url.toString()).toBe('kind=staff&unmapped=1');
    expect(peopleFilterFromUrl(url, '')).toEqual(staffUnmapped);
    expect(ids(filterPeople(ROWS, peopleFilterFromUrl(url, '')))).toEqual(['t2']);
    // Any other kind is the students.
    expect(peopleFilterFromUrl(new URLSearchParams('kind=STAFF'), '').kind).toBe('STUDENT');
  });
});
