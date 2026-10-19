import { z } from 'zod';
import type { IsoDate } from './dates.js';
import { isoDateSchema } from './dates.js';
import { toAsciiDigits } from './digits.js';
import { generatedGuardianName, hasPersonName, sameName, type PersonNames } from './people.js';
import { normalizeBdPhone } from './phone.js';
import {
  BLOOD_GROUPS,
  normalizeBirthRegistration,
  type BloodGroup,
  type Gender,
  type GuardianRelation,
  type Religion,
} from './students.js';

// Student import from Excel/CSV: columns, header detection, cell parsing and row validation.
// The API runs the same functions for the preview and again when the import runs.

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

export const IMPORT_FIELDS = [
  'studentCode',
  'nameBn',
  'nameEn',
  'classLevel',
  'section',
  'roll',
  'studyGroup',
  'dateOfBirth',
  'gender',
  'religion',
  'bloodGroup',
  'birthRegistrationNo',
  'fatherNameBn',
  'fatherNameEn',
  'motherNameBn',
  'motherNameEn',
  'presentAddress',
  'permanentAddress',
  'guardianPhone',
  'guardianNameBn',
  'guardianNameEn',
  'guardianRelation',
  'guardian2Phone',
  'guardian2NameBn',
  'guardian2NameEn',
  'guardian2Relation',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Template headers (Bangla, English) and other spellings people use, for auto-detection. */
export const IMPORT_HEADERS: Record<ImportField, { bn: string; en: string; aliases?: string[] }> = {
  studentCode: { bn: 'শিক্ষার্থী আইডি', en: 'Student ID', aliases: ['আইডি', 'student code', 'id'] },
  nameBn: {
    bn: 'নাম (বাংলা)',
    en: 'Name (Bangla)',
    aliases: ['নাম', 'শিক্ষার্থীর নাম', 'name bn', 'bangla name'],
  },
  nameEn: {
    bn: 'নাম (ইংরেজি)',
    en: 'Name (English)',
    aliases: ['name', 'student name', 'english name', 'name en'],
  },
  classLevel: { bn: 'শ্রেণি', en: 'Class', aliases: ['ক্লাস', 'কোর্স', 'course', 'class level'] },
  section: { bn: 'শাখা', en: 'Section', aliases: ['ব্যাচ', 'batch'] },
  roll: { bn: 'রোল', en: 'Roll', aliases: ['রোল নম্বর', 'roll no', 'roll number'] },
  studyGroup: { bn: 'বিভাগ', en: 'Group', aliases: ['study group', 'গ্রুপ'] },
  dateOfBirth: {
    bn: 'জন্ম তারিখ',
    en: 'Date of birth',
    aliases: ['dob', 'birth date', 'জন্মতারিখ'],
  },
  gender: { bn: 'লিঙ্গ', en: 'Gender', aliases: ['sex'] },
  religion: { bn: 'ধর্ম', en: 'Religion' },
  bloodGroup: { bn: 'রক্তের গ্রুপ', en: 'Blood group', aliases: ['blood'] },
  birthRegistrationNo: {
    bn: 'জন্ম নিবন্ধন নম্বর',
    en: 'Birth registration no.',
    aliases: ['জন্ম নিবন্ধন', 'birth registration', 'birth reg', 'brn', 'birth certificate no'],
  },
  fatherNameBn: { bn: 'পিতার নাম (বাংলা)', en: 'Father name (Bangla)', aliases: ['পিতার নাম'] },
  fatherNameEn: {
    bn: 'পিতার নাম (ইংরেজি)',
    en: 'Father name (English)',
    aliases: ['father name', "father's name"],
  },
  motherNameBn: { bn: 'মাতার নাম (বাংলা)', en: 'Mother name (Bangla)', aliases: ['মাতার নাম'] },
  motherNameEn: {
    bn: 'মাতার নাম (ইংরেজি)',
    en: 'Mother name (English)',
    aliases: ['mother name', "mother's name"],
  },
  presentAddress: { bn: 'বর্তমান ঠিকানা', en: 'Present address', aliases: ['ঠিকানা', 'address'] },
  permanentAddress: { bn: 'স্থায়ী ঠিকানা', en: 'Permanent address' },
  guardianPhone: {
    bn: 'অভিভাবকের মোবাইল',
    en: 'Guardian phone',
    aliases: ['মোবাইল', 'ফোন', 'mobile', 'phone', 'guardian mobile', 'অভিভাবকের ফোন'],
  },
  guardianNameBn: {
    bn: 'অভিভাবকের নাম (বাংলা)',
    en: 'Guardian name (Bangla)',
    aliases: ['অভিভাবকের নাম'],
  },
  guardianNameEn: {
    bn: 'অভিভাবকের নাম (ইংরেজি)',
    en: 'Guardian name (English)',
    aliases: ['guardian name', 'guardian'],
  },
  guardianRelation: {
    bn: 'অভিভাবকের সম্পর্ক',
    en: 'Guardian relation',
    aliases: ['সম্পর্ক', 'relation'],
  },
  guardian2Phone: { bn: 'দ্বিতীয় অভিভাবকের মোবাইল', en: 'Second guardian phone' },
  guardian2NameBn: { bn: 'দ্বিতীয় অভিভাবকের নাম (বাংলা)', en: 'Second guardian name (Bangla)' },
  guardian2NameEn: { bn: 'দ্বিতীয় অভিভাবকের নাম (ইংরেজি)', en: 'Second guardian name (English)' },
  guardian2Relation: { bn: 'দ্বিতীয় অভিভাবকের সম্পর্ক', en: 'Second guardian relation' },
};

/** "Name (Bangla)", "name bangla", "NAME  ( bangla )" → "name bangla". */
export function normalizeHeader(h: string): string {
  return toAsciiDigits(h)
    .toLowerCase()
    .replace(/[()[\]{}:.*_\-–/|'’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The template's own header: "নাম (বাংলা) / Name (Bangla)". */
export const templateHeader = (f: ImportField) =>
  `${IMPORT_HEADERS[f].bn} / ${IMPORT_HEADERS[f].en}`;

/** field → column index, from the file's header row (null = not found). */
export function detectMapping(headers: string[]): Record<ImportField, number | null> {
  const norm = headers.map(normalizeHeader);
  const out = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<
    ImportField,
    number | null
  >;
  const used = new Set<number>();
  // Exact matches first (template headers, then the bn/en halves), then aliases.
  const passes: ((f: ImportField) => string[])[] = [
    (f) => [templateHeader(f)],
    (f) => [IMPORT_HEADERS[f].bn, IMPORT_HEADERS[f].en],
    (f) => IMPORT_HEADERS[f].aliases ?? [],
  ];
  for (const candidates of passes) {
    for (const f of IMPORT_FIELDS) {
      if (out[f] !== null) continue;
      const wanted = new Set(candidates(f).map(normalizeHeader));
      const i = norm.findIndex((h, idx) => !used.has(idx) && wanted.has(h));
      if (i >= 0) {
        out[f] = i;
        used.add(i);
      }
    }
  }
  return out;
}

export const importMappingSchema = z.object({
  mapping: z
    .record(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(200).nullable())
    .refine((m) => {
      const cols = Object.values(m).filter((v): v is number => v !== null);
      return new Set(cols).size === cols.length;
    }, 'A column is mapped twice'),
});
export type ImportMapping = Partial<Record<ImportField, number | null>>;

// ─────────────────────────── Cell parsing ───────────────────────────

const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

/** A phone as typed in Excel: 01…, +8801…, Bangla digits, or 1711… (Excel dropped the 0). */
export function parseImportPhone(v: string): string | null {
  const s = toAsciiDigits(clean(v)).replace(/[\s-]/g, '');
  if (/^1[3-9]\d{8}$/.test(s)) return normalizeBdPhone(`0${s}`);
  return normalizeBdPhone(s);
}

const GENDER_WORDS: Record<string, Gender> = {
  male: 'MALE',
  m: 'MALE',
  boy: 'MALE',
  ছেলে: 'MALE',
  পুরুষ: 'MALE',
  ছাত্র: 'MALE',
  female: 'FEMALE',
  f: 'FEMALE',
  girl: 'FEMALE',
  মেয়ে: 'FEMALE',
  মহিলা: 'FEMALE',
  ছাত্রী: 'FEMALE',
  নারী: 'FEMALE',
  other: 'OTHER',
  অন্যান্য: 'OTHER',
};
const RELIGION_WORDS: Record<string, Religion> = {
  islam: 'ISLAM',
  muslim: 'ISLAM',
  ইসলাম: 'ISLAM',
  মুসলিম: 'ISLAM',
  মুসলমান: 'ISLAM',
  hindu: 'HINDUISM',
  hinduism: 'HINDUISM',
  হিন্দু: 'HINDUISM',
  সনাতন: 'HINDUISM',
  christian: 'CHRISTIANITY',
  christianity: 'CHRISTIANITY',
  খ্রিস্টান: 'CHRISTIANITY',
  খ্রিষ্টান: 'CHRISTIANITY',
  buddhist: 'BUDDHISM',
  buddhism: 'BUDDHISM',
  বৌদ্ধ: 'BUDDHISM',
  other: 'OTHER',
  অন্যান্য: 'OTHER',
};
const RELATION_WORDS: Record<string, GuardianRelation> = {
  father: 'FATHER',
  পিতা: 'FATHER',
  বাবা: 'FATHER',
  আব্বা: 'FATHER',
  mother: 'MOTHER',
  মাতা: 'MOTHER',
  মা: 'MOTHER',
  আম্মা: 'MOTHER',
  brother: 'BROTHER',
  ভাই: 'BROTHER',
  sister: 'SISTER',
  বোন: 'SISTER',
  grandfather: 'GRANDFATHER',
  দাদা: 'GRANDFATHER',
  নানা: 'GRANDFATHER',
  grandmother: 'GRANDMOTHER',
  দাদি: 'GRANDMOTHER',
  নানি: 'GRANDMOTHER',
  uncle: 'UNCLE',
  চাচা: 'UNCLE',
  মামা: 'UNCLE',
  কাকা: 'UNCLE',
  aunt: 'AUNT',
  চাচি: 'AUNT',
  খালা: 'AUNT',
  মামি: 'AUNT',
  ফুফু: 'AUNT',
  other: 'OTHER',
  অন্যান্য: 'OTHER',
};
const word = (v: string) =>
  clean(v)
    .toLowerCase()
    .replace(/[.\s]+/g, '');

export const parseGender = (v: string): Gender | null => GENDER_WORDS[word(v)] ?? null;
export const parseReligion = (v: string): Religion | null => RELIGION_WORDS[word(v)] ?? null;
export const parseRelation = (v: string): GuardianRelation | null =>
  RELATION_WORDS[word(v)] ??
  (IMPORT_RELATIONS.has(clean(v).toUpperCase() as GuardianRelation)
    ? (clean(v).toUpperCase() as GuardianRelation)
    : null);
const IMPORT_RELATIONS = new Set<GuardianRelation>([
  'FATHER',
  'MOTHER',
  'BROTHER',
  'SISTER',
  'GRANDFATHER',
  'GRANDMOTHER',
  'UNCLE',
  'AUNT',
  'OTHER',
]);

export function parseBloodGroup(v: string): BloodGroup | null {
  const s = clean(v)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace('−', '-')
    .replace(/POSITIVE|POS|\(\+\)/, '+')
    .replace(/NEGATIVE|NEG|\(-\)/, '-');
  const m = /^(AB|A|B|O)([+-])$/.exec(s);
  if (!m) return BLOOD_GROUPS.includes(s as BloodGroup) ? (s as BloodGroup) : null;
  return `${m[1]}_${m[2] === '+' ? 'POSITIVE' : 'NEGATIVE'}` as BloodGroup;
}

/** 2013-05-17, 17/05/2013, 17-05-2013, 17.05.2013 (day first, as in Bangladesh); Bangla digits. */
export function parseImportDate(v: string): IsoDate | null {
  const s = toAsciiDigits(clean(v));
  let iso: string | null = null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  if (!iso || !isoDateSchema.safeParse(iso).success) return null;
  return iso >= '1920-01-01' && iso <= new Date().toISOString().slice(0, 10) ? iso : null;
}

// ─────────────────────────── Row validation ───────────────────────────

/** What the institute has, for matching names in the file (current academic year). */
export interface ImportLookups {
  classLevels: { id: string; code: string; nameBn: string; nameEn: string; isActive: boolean }[];
  /** Sections of the current year. */
  sections: { id: string; classLevelId: string; name: string; isActive: boolean }[];
  studyGroups: { id: string; code: string; nameBn: string; nameEn: string; isActive: boolean }[];
}

export type ImportErrorCode =
  | 'NAME_MISSING'
  | 'CLASS_MISSING'
  | 'CLASS_UNKNOWN'
  | 'SECTION_UNKNOWN'
  | 'GROUP_UNKNOWN'
  | 'ROLL_INVALID'
  | 'ROLL_NEEDS_SECTION'
  | 'ROLL_DUPLICATE_IN_FILE'
  | 'ROLL_TAKEN'
  | 'PHONE_MISSING'
  | 'PHONE_INVALID'
  | 'GUARDIAN_NAME_MISSING'
  | 'RELATION_UNKNOWN'
  | 'BIRTH_REG_INVALID'
  | 'BIRTH_REG_DUPLICATE_IN_FILE'
  | 'CODE_INVALID'
  | 'CODE_DUPLICATE_IN_FILE'
  | 'DATE_INVALID'
  | 'GENDER_UNKNOWN'
  | 'RELIGION_UNKNOWN'
  | 'BLOOD_GROUP_UNKNOWN'
  | 'SECTION_FULL'
  | 'ROW_REJECTED'
  | 'GUARDIAN_PHONE_TWICE'
  /** No guardian name, and several guardians here have the phone: we cannot tell which one. */
  | 'GUARDIAN_NAME_NEEDED'
  /** At the run, the guardians on this phone were not what the preview showed: check again. */
  | 'GUARDIAN_CHANGED';

export interface ImportRowError {
  code: ImportErrorCode;
  field: ImportField;
  /** The cell text, shortened (shown back to the user). */
  value?: string;
}

export interface ImportGuardian {
  phone: string;
  nameBn: string | null;
  nameEn: string | null;
  relation: GuardianRelation;
  isPrimary: boolean;
  occupation: null;
}

export interface ImportStudent {
  studentCode: string | null;
  nameBn: string | null;
  nameEn: string | null;
  classLevelId: string;
  sectionId: string | null;
  studyGroupId: string | null;
  roll: number | null;
  dateOfBirth: IsoDate | null;
  gender: Gender | null;
  religion: Religion | null;
  bloodGroup: BloodGroup | null;
  birthRegistrationNo: string | null;
  fatherNameBn: string | null;
  fatherNameEn: string | null;
  motherNameBn: string | null;
  motherNameEn: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  guardians: ImportGuardian[];
}

export type ParsedRow =
  { ok: true; student: ImportStudent } | { ok: false; errors: ImportRowError[] };

const same = (a: string, b: string) => normalizeHeader(a) === normalizeHeader(b);
const short = (v: string) => (v.length > 40 ? `${v.slice(0, 40)}…` : v);

/** One row → a student ready to create, or the exact problems (all of them, not the first). */
export function parseImportRow(
  cells: string[],
  mapping: ImportMapping,
  lookups: ImportLookups,
): ParsedRow {
  const get = (f: ImportField) => {
    const i = mapping[f];
    return i === null || i === undefined ? '' : clean(cells[i]);
  };
  const errors: ImportRowError[] = [];
  const err = (code: ImportErrorCode, field: ImportField) => {
    const v = get(field);
    errors.push(v ? { code, field, value: short(v) } : { code, field });
  };
  const text = (f: ImportField, max = 120) => get(f).slice(0, max) || null;

  const nameBn = text('nameBn');
  const nameEn = text('nameEn');
  if (!nameBn && !nameEn) err('NAME_MISSING', 'nameBn');

  // Class: name in either language, or its code.
  let classLevelId: string | null = null;
  const cls = get('classLevel');
  if (!cls) err('CLASS_MISSING', 'classLevel');
  else {
    const digits = toAsciiDigits(cls);
    const c = lookups.classLevels.find(
      (x) =>
        x.isActive &&
        (same(x.nameBn, cls) ||
          same(x.nameEn, cls) ||
          same(x.code, cls) ||
          same(x.code, `CLASS_${digits}`) ||
          same(x.nameEn, `Class ${digits}`)),
    );
    if (c) classLevelId = c.id;
    else err('CLASS_UNKNOWN', 'classLevel');
  }

  let sectionId: string | null = null;
  const sec = get('section');
  if (sec && classLevelId) {
    const s = lookups.sections.find(
      (x) => x.isActive && x.classLevelId === classLevelId && same(x.name, sec),
    );
    if (s) sectionId = s.id;
    else err('SECTION_UNKNOWN', 'section');
  }

  let studyGroupId: string | null = null;
  const grp = get('studyGroup');
  if (grp) {
    const g = lookups.studyGroups.find(
      (x) => x.isActive && (same(x.nameBn, grp) || same(x.nameEn, grp) || same(x.code, grp)),
    );
    if (g) studyGroupId = g.id;
    else err('GROUP_UNKNOWN', 'studyGroup');
  }

  let roll: number | null = null;
  const rollText = toAsciiDigits(get('roll'));
  if (rollText) {
    const n = Number(rollText);
    if (!Number.isInteger(n) || n < 1 || n > 9999) err('ROLL_INVALID', 'roll');
    else if (!sec) err('ROLL_NEEDS_SECTION', 'roll');
    else roll = n;
  }

  let studentCode: string | null = null;
  const code = toAsciiDigits(get('studentCode')).toUpperCase();
  if (code) {
    if (/^[A-Z0-9][A-Z0-9/_-]{0,29}$/.test(code)) studentCode = code;
    else err('CODE_INVALID', 'studentCode');
  }

  let birthRegistrationNo: string | null = null;
  if (get('birthRegistrationNo')) {
    birthRegistrationNo = normalizeBirthRegistration(get('birthRegistrationNo'));
    if (!birthRegistrationNo) err('BIRTH_REG_INVALID', 'birthRegistrationNo');
  }

  let dateOfBirth: IsoDate | null = null;
  if (get('dateOfBirth')) {
    dateOfBirth = parseImportDate(get('dateOfBirth'));
    if (!dateOfBirth) err('DATE_INVALID', 'dateOfBirth');
  }
  const enumField = <T>(
    f: ImportField,
    parse: (v: string) => T | null,
    code: ImportErrorCode,
  ): T | null => {
    if (!get(f)) return null;
    const v = parse(get(f));
    if (!v) err(code, f);
    return v;
  };
  const gender = enumField('gender', parseGender, 'GENDER_UNKNOWN');
  const religion = enumField('religion', parseReligion, 'RELIGION_UNKNOWN');
  const bloodGroup = enumField('bloodGroup', parseBloodGroup, 'BLOOD_GROUP_UNKNOWN');

  const guardians: ImportGuardian[] = [];
  const guardian = (n: '' | '2') => {
    const phoneF = `guardian${n}Phone` as ImportField;
    const relF = `guardian${n}Relation` as ImportField;
    const bnF = `guardian${n}NameBn` as ImportField;
    const enF = `guardian${n}NameEn` as ImportField;
    const any = [phoneF, relF, bnF, enF].some((f) => get(f));
    if (!any) {
      if (n === '') err('PHONE_MISSING', phoneF);
      return;
    }
    const phone = parseImportPhone(get(phoneF));
    if (!get(phoneF)) err('PHONE_MISSING', phoneF);
    else if (!phone) err('PHONE_INVALID', phoneF);
    const relation = get(relF) ? parseRelation(get(relF)) : n === '' ? 'FATHER' : 'MOTHER';
    if (!relation) err('RELATION_UNKNOWN', relF);
    if (phone && relation) {
      // No guardian name in the row: a father/mother takes the parent's name columns.
      const parent = relation === 'FATHER' ? 'father' : relation === 'MOTHER' ? 'mother' : null;
      const nameBnG = text(bnF) ?? (parent ? text(`${parent}NameBn` as ImportField) : null);
      const nameEnG = text(enF) ?? (parent ? text(`${parent}NameEn` as ImportField) : null);
      if (guardians.some((g) => g.phone === phone)) err('GUARDIAN_PHONE_TWICE', phoneF);
      else
        guardians.push({
          phone,
          nameBn: nameBnG,
          nameEn: nameEnG,
          relation,
          isPrimary: n === '',
          occupation: null,
        });
    }
  };
  guardian('');
  guardian('2');

  if (errors.length > 0 || !classLevelId) return { ok: false, errors };
  return {
    ok: true,
    student: {
      studentCode,
      nameBn,
      nameEn,
      classLevelId,
      sectionId,
      studyGroupId,
      roll,
      dateOfBirth,
      gender,
      religion,
      bloodGroup,
      birthRegistrationNo,
      fatherNameBn: text('fatherNameBn'),
      fatherNameEn: text('fatherNameEn'),
      motherNameBn: text('motherNameBn'),
      motherNameEn: text('motherNameEn'),
      presentAddress: text('presentAddress', 300),
      permanentAddress: text('permanentAddress', 300),
      guardians,
    },
  };
}

/** Duplicates inside the file: roll per section, birth registration, student code. */
export function findInFileDuplicates(rows: ParsedRow[]): Map<number, ImportRowError[]> {
  const out = new Map<number, ImportRowError[]>();
  const seen = {
    roll: new Map<string, number>(),
    reg: new Map<string, number>(),
    code: new Map<string, number>(),
  };
  const add = (i: number, e: ImportRowError) => out.set(i, [...(out.get(i) ?? []), e]);
  rows.forEach((r, i) => {
    if (!r.ok) return;
    const s = r.student;
    if (s.sectionId && s.roll !== null) {
      const k = `${s.sectionId}:${s.roll}`;
      if (seen.roll.has(k))
        add(i, { code: 'ROLL_DUPLICATE_IN_FILE', field: 'roll', value: String(s.roll) });
      else seen.roll.set(k, i);
    }
    if (s.birthRegistrationNo) {
      if (seen.reg.has(s.birthRegistrationNo))
        add(i, {
          code: 'BIRTH_REG_DUPLICATE_IN_FILE',
          field: 'birthRegistrationNo',
          value: s.birthRegistrationNo,
        });
      else seen.reg.set(s.birthRegistrationNo, i);
    }
    if (s.studentCode) {
      if (seen.code.has(s.studentCode))
        add(i, { code: 'CODE_DUPLICATE_IN_FILE', field: 'studentCode', value: s.studentCode });
      else seen.code.set(s.studentCode, i);
    }
  });
  return out;
}

// ─────────────────────────── API types ───────────────────────────

export type ImportStatus = 'UPLOADED' | 'VALIDATED' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
/** OK: will be created; EXISTS: same student_code or birth registration already here (skipped). */
export type ImportRowStatus = 'OK' | 'ERROR' | 'EXISTS' | 'IMPORTED' | 'SKIPPED';

export interface ImportRowResult {
  /** 1-based row number in the file (the header is row 1). */
  row: number;
  status: ImportRowStatus;
  errors: ImportRowError[];
  /** IMPORTED/EXISTS: the student's code. */
  studentCode?: string;
  /** For the preview and the report. */
  name?: string;
  /** How the row's guardians are (or were) linked, for the admin to check. */
  notes?: ImportRowNote[];
}

export type ImportRowNoteCode =
  /** Phone and name match a guardian here: linked to them. */
  | 'GUARDIAN_LINKED'
  /** No name in the row; the one guardian here with the phone was linked (please check). */
  | 'GUARDIAN_LINKED_BY_PHONE_ONLY'
  /** Guardians here have the phone but not the name: a new guardian was added. */
  | 'GUARDIAN_NEW_SAME_PHONE'
  /** No name and an unknown phone: a new guardian named after the student (rename later). */
  | 'GUARDIAN_NAME_GENERATED';

export interface ImportRowNote {
  code: ImportRowNoteCode;
  /** The row's first or second guardian. */
  guardian: 1 | 2;
}

/** A guardian already here (or, in the preview, created by an earlier row: `id` null). */
export interface KnownGuardian {
  id: string | null;
  phone: string;
  nameBn: string | null;
  nameEn: string | null;
}

export type GuardianPlan =
  | {
      kind: 'link';
      guardian: KnownGuardian;
      note: 'GUARDIAN_LINKED' | 'GUARDIAN_LINKED_BY_PHONE_ONLY';
    }
  | {
      kind: 'new';
      nameBn: string | null;
      nameEn: string | null;
      note: 'GUARDIAN_NEW_SAME_PHONE' | 'GUARDIAN_NAME_GENERATED' | null;
    }
  | { kind: 'ambiguous' };

/**
 * How an imported row's guardian is linked (decision #6), the same in the preview and the run.
 * `known`: guardians with these phones, oldest first.
 * - With a name: link only when the phone and a name match; otherwise a new guardian.
 * - No name: the one guardian with the phone is linked; several: an error; none: a new guardian
 *   named after the student.
 */
export function planImportGuardian(
  g: ImportGuardian,
  student: PersonNames,
  known: KnownGuardian[],
): GuardianPlan {
  const samePhone = known.filter((k) => k.phone === g.phone);
  if (hasPersonName(g)) {
    const match = samePhone.find((k) => sameName(g, k));
    if (match) return { kind: 'link', guardian: match, note: 'GUARDIAN_LINKED' };
    return {
      kind: 'new',
      nameBn: g.nameBn,
      nameEn: g.nameEn,
      note: samePhone.length > 0 ? 'GUARDIAN_NEW_SAME_PHONE' : null,
    };
  }
  if (samePhone.length === 1) {
    return { kind: 'link', guardian: samePhone[0]!, note: 'GUARDIAN_LINKED_BY_PHONE_ONLY' };
  }
  if (samePhone.length > 1) return { kind: 'ambiguous' };
  return { kind: 'new', ...generatedGuardianName(student), note: 'GUARDIAN_NAME_GENERATED' };
}

export interface StudentImportSummary {
  id: string;
  status: ImportStatus;
  fileName: string;
  headers: string[];
  mapping: Record<ImportField, number | null>;
  rowCount: number;
  counts: { ok: number; error: number; exists: number; imported: number; skipped: number };
  /** Rows done while RUNNING. */
  processed: number;
  createdAt: string;
  finishedAt: string | null;
  /** FAILED: why. */
  failure: string | null;
}

export interface ImportPreviewRow extends ImportRowResult {
  /** The mapped cells (field → text), for showing the row. */
  values: Partial<Record<ImportField, string>>;
}

export interface ImportPreviewPage {
  rows: ImportPreviewRow[];
  total: number;
}

export const importRowsQuerySchema = z.object({
  filter: z.enum(['all', 'ok', 'error', 'exists']).default('all'),
  page: z.coerce.number().int().min(0).max(1000).default(0),
});
