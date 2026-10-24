import type { DevicePersonRow } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { filterPeople, sectionChoices } from './people';

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
