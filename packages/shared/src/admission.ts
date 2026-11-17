// Online admission (sprint 1 P3, docs/admission.md): statuses, the form's optional fields and
// their defaults, application numbers and the API's shapes. No zod here (the public form imports
// this file); the input schemas are in admission-schema.ts.

import type {
  AdmissionPublicResult,
  AdmissionPublicTest,
  AdmissionTieBreak,
} from './admission-test.js';
import type { IsoDate } from './dates.js';
import type { BloodGroup, Gender, GuardianRelation, Religion } from './students-values.js';

export const ADMISSION_CYCLE_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;
export type AdmissionCycleStatus = (typeof ADMISSION_CYCLE_STATUSES)[number];

export const ADMISSION_APPLICATION_STATUSES = [
  'SUBMITTED',
  'SHORTLISTED',
  'SELECTED',
  'WAITLISTED',
  'REJECTED',
  'ADMITTED',
  'WITHDRAWN',
] as const;
export type AdmissionApplicationStatus = (typeof ADMISSION_APPLICATION_STATUSES)[number];

export const ADMISSION_SOURCES = ['ONLINE', 'STAFF'] as const;
export type AdmissionSource = (typeof ADMISSION_SOURCES)[number];

/**
 * Statuses staff set by hand. SELECTED only in a cycle without an admission test (with one, the
 * merit list selects, P4); bulk approval approves SELECTED applications only (review S2).
 */
export const ADMISSION_STAFF_STATUSES = [
  'SUBMITTED',
  'SHORTLISTED',
  'SELECTED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type AdmissionStaffStatus = (typeof ADMISSION_STAFF_STATUSES)[number];

/** Statuses that need a reason (the database CHECK admission_applications_reason_required). */
export const ADMISSION_REASON_STATUSES: readonly AdmissionApplicationStatus[] = [
  'REJECTED',
  'WITHDRAWN',
];

/**
 * Which applications may be approved into a student (decision P3-H): without an admission test,
 * any still in play; with one, only those the merit list SELECTED (a waitlisted one is moved up
 * first, P4).
 */
export function approvableStatuses(requiresTest: boolean): readonly AdmissionApplicationStatus[] {
  return requiresTest ? ['SELECTED'] : ['SUBMITTED', 'SHORTLISTED', 'SELECTED'];
}

/** Why bulk approval skipped an application (decision P3-T; the database CHECK has the list). */
export const ADMISSION_APPROVAL_PROBLEMS = [
  'GUARDIAN_CHOICE_REQUIRED',
  'STUDENT_LIMIT',
  'SECTION_FULL',
  'DUPLICATE',
  'INACTIVE',
  'INVALID',
] as const;
export type AdmissionApprovalProblem = (typeof ADMISSION_APPROVAL_PROBLEMS)[number];

// ─────────────────────────── The form's optional fields ───────────────────────────

/** The fields a cycle may hide, offer or require (the CHECK admission_cycles_fields). */
export const ADMISSION_FIELDS = [
  'photo',
  'religion',
  'blood_group',
  'birth_registration_no',
  'previous_institute',
  'present_address',
  'permanent_address',
  'father_name',
  'mother_name',
  'guardian_occupation',
] as const;
export type AdmissionField = (typeof ADMISSION_FIELDS)[number];

export const ADMISSION_FIELD_SETTINGS = ['HIDDEN', 'OPTIONAL', 'REQUIRED'] as const;
export type AdmissionFieldSetting = (typeof ADMISSION_FIELD_SETTINGS)[number];
export type AdmissionFieldSettings = Record<AdmissionField, AdmissionFieldSetting>;

/**
 * Defaults (decision P3-Q). Always required, not listed here: a name, the date of birth, the
 * gender, the guardian's name, relation and phone. Blood group is hidden unless the cycle asks
 * for it (less personal data by default). The photo counts only when the cycle collects photos.
 */
export const DEFAULT_ADMISSION_FIELDS: AdmissionFieldSettings = {
  photo: 'OPTIONAL',
  religion: 'OPTIONAL',
  blood_group: 'HIDDEN',
  birth_registration_no: 'OPTIONAL',
  previous_institute: 'OPTIONAL',
  present_address: 'OPTIONAL',
  permanent_address: 'OPTIONAL',
  father_name: 'OPTIONAL',
  mother_name: 'OPTIONAL',
  guardian_occupation: 'OPTIONAL',
};

/**
 * What a cycle's form shows: its stored settings over the defaults; the photo is HIDDEN unless
 * the cycle collects photos (S9), and then OPTIONAL unless REQUIRED.
 */
export function effectiveAdmissionFields(
  stored: Partial<Record<string, string>> | null | undefined,
  collectPhoto: boolean,
): AdmissionFieldSettings {
  const out = { ...DEFAULT_ADMISSION_FIELDS };
  for (const f of ADMISSION_FIELDS) {
    const v = stored?.[f];
    if (v === 'HIDDEN' || v === 'OPTIONAL' || v === 'REQUIRED') out[f] = v;
  }
  out.photo = collectPhoto ? (out.photo === 'REQUIRED' ? 'REQUIRED' : 'OPTIONAL') : 'HIDDEN';
  return out;
}

/** An application's own fields (the form, a staff entry, an edit). */
export interface AdmissionApplicationFields {
  nameBn: string | null;
  nameEn: string | null;
  dateOfBirth: IsoDate;
  gender: Gender;
  religion: Religion | null;
  bloodGroup: BloodGroup | null;
  birthRegistrationNo: string | null;
  previousInstitute: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  fatherNameBn: string | null;
  fatherNameEn: string | null;
  motherNameBn: string | null;
  motherNameEn: string | null;
  guardianNameBn: string | null;
  guardianNameEn: string | null;
  guardianRelation: GuardianRelation;
  guardianOccupation: string | null;
}

/** Whether a value was given for each optional field (the photo is passed separately). */
function given(a: AdmissionApplicationFields, hasPhoto: boolean): Record<AdmissionField, boolean> {
  return {
    photo: hasPhoto,
    religion: a.religion !== null,
    blood_group: a.bloodGroup !== null,
    birth_registration_no: a.birthRegistrationNo !== null,
    previous_institute: a.previousInstitute !== null,
    present_address: a.presentAddress !== null,
    permanent_address: a.permanentAddress !== null,
    father_name: a.fatherNameBn !== null || a.fatherNameEn !== null,
    mother_name: a.motherNameBn !== null || a.motherNameEn !== null,
    guardian_occupation: a.guardianOccupation !== null,
  };
}

/** REQUIRED fields left empty. */
export function missingAdmissionFields(
  settings: AdmissionFieldSettings,
  a: AdmissionApplicationFields,
  hasPhoto: boolean,
): AdmissionField[] {
  const g = given(a, hasPhoto);
  return ADMISSION_FIELDS.filter((f) => settings[f] === 'REQUIRED' && !g[f]);
}

/** HIDDEN fields that were filled anyway (the public form refuses them). */
export function hiddenAdmissionFieldsGiven(
  settings: AdmissionFieldSettings,
  a: AdmissionApplicationFields,
  hasPhoto: boolean,
): AdmissionField[] {
  const g = given(a, hasPhoto);
  return ADMISSION_FIELDS.filter((f) => settings[f] === 'HIDDEN' && g[f]);
}

// ─────────────────────────── Numbers and names ───────────────────────────

/** `2027-0001`: the year the cycle's academic year starts, then a counter (more digits past 9999). */
export function formatApplicationNo(year: number, n: number): string {
  return `${year}-${String(n).padStart(4, '0')}`;
}

export const APPLICATION_NO_PATTERN = /^[0-9]{4}-[0-9]{4,6}$/;

/** For duplicate checks: NFC, lower case, no spaces ("  Rahim  Uddin " = "rahimuddin"). */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
}

/** An application's key: its Bangla name, else its English name. */
export function applicationNameKey(a: { nameBn: string | null; nameEn: string | null }): string {
  return nameKey(a.nameBn || a.nameEn || '');
}

// ─────────────────────────── API shapes (staff) ───────────────────────────

export interface AdmissionNamed {
  id: string;
  nameBn: string;
  nameEn: string;
}

export interface AdmissionCycleClassView {
  id: string;
  classLevel: AdmissionNamed;
  studyGroup: AdmissionNamed | null;
  seats: number | null;
  isOpen: boolean;
  /** The published merit list's version (P4; 0: none). */
  resultsVersion: number;
  /** Applications not withdrawn or rejected, and those admitted. */
  applications: number;
  admitted: number;
}

export interface AdmissionCycleView {
  id: string;
  academicYear: { id: string; name: string; startDate: IsoDate };
  nameBn: string;
  nameEn: string | null;
  status: AdmissionCycleStatus;
  /** ISO timestamps (UTC). */
  opensAt: string;
  closesAt: string;
  publicNoteBn: string | null;
  publicNoteEn: string | null;
  requiresTest: boolean;
  collectPhoto: boolean;
  /** The settings as stored (missing keys use the defaults). */
  fields: Partial<AdmissionFieldSettings>;
  /** How equal test scores are ordered (P4-A). */
  meritTieBreak: AdmissionTieBreak;
  /** OPEN and inside its window now: the public form takes applications. */
  takingApplications: boolean;
  classes: AdmissionCycleClassView[];
  counts: Record<AdmissionApplicationStatus, number>;
}

export interface AdmissionApplicationListItem {
  id: string;
  applicationNo: string;
  source: AdmissionSource;
  nameBn: string | null;
  nameEn: string | null;
  dateOfBirth: IsoDate;
  gender: Gender;
  phone: string;
  guardianNameBn: string | null;
  guardianNameEn: string | null;
  status: AdmissionApplicationStatus;
  submittedAt: string;
  cycle: { id: string; nameBn: string; nameEn: string | null };
  cycleClass: { id: string; classLevel: AdmissionNamed; studyGroup: AdmissionNamed | null };
  approvalProblem: AdmissionApprovalProblem | null;
  hasPhoto: boolean;
  /** Changes when the photo does (the web's image cache key). */
  photoVersion: string | null;
  studentId: string | null;
}

export interface AdmissionApplicationsPage {
  items: AdmissionApplicationListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdmissionApplicationDetail
  extends AdmissionApplicationListItem, AdmissionApplicationFields {
  statusReason: string | null;
  statusAt: string | null;
  staffNote: string | null;
  requiresTest: boolean;
  /** May be approved now (status, not yet a student). */
  approvable: boolean;
  student: { id: string; studentCode: string } | null;
  /** Students of the institute with the same birth registration number. */
  possibleDuplicates: {
    id: string;
    studentCode: string;
    nameBn: string | null;
    nameEn: string | null;
  }[];
  /** The cycle's academic year (approval enrols the child there). */
  academicYear: { id: string; name: string };
}

export interface AdmissionBulkApproveStatus {
  running: boolean;
  admitted: number;
  problems: { applicationId: string; applicationNo: string; code: AdmissionApprovalProblem }[];
}

/** GET /admission/options: what the cycle form picks from. */
export interface AdmissionOptions {
  years: { id: string; name: string; startDate: IsoDate; endDate: IsoDate; isCurrent: boolean }[];
  classLevels: (AdmissionNamed & { isActive: boolean })[];
  studyGroups: (AdmissionNamed & { isActive: boolean })[];
}

/** GET /admission/cycle-classes/:id/sections: where an application may be approved into. */
export interface AdmissionSectionOption {
  id: string;
  name: string;
  capacity: number | null;
  enrolled: number;
}

// ─────────────────────────── API shapes (the public form, P3b) ───────────────────────────

export interface AdmissionPublicClass {
  cycleClassId: string;
  classNameBn: string;
  classNameEn: string;
  groupNameBn: string | null;
  groupNameEn: string | null;
}

export interface AdmissionPublicCycle {
  nameBn: string;
  nameEn: string | null;
  closesAt: string;
  noteBn: string | null;
  noteEn: string | null;
  collectPhoto: boolean;
  fields: Partial<AdmissionFieldSettings>;
  classes: AdmissionPublicClass[];
}

/** GET /public/admission/:slug: no person's data, ever. */
export interface AdmissionPublicForm {
  institute: { name: string; nameBn: string | null; nameEn: string | null; locale: 'bn' | 'en' };
  /** Cycles taking applications now (empty: the form is not open). */
  cycles: AdmissionPublicCycle[];
}

/** POST /public/admission/:slug/status (the phone proved by a code first). */
export interface AdmissionPublicStatus {
  applicationNo: string;
  status: AdmissionApplicationStatus;
  nameBn: string | null;
  nameEn: string | null;
  classNameBn: string;
  classNameEn: string;
  groupNameBn: string | null;
  groupNameEn: string | null;
  cycleNameBn: string;
  cycleNameEn: string | null;
  submittedAt: string;
  /** Sprint 1 P4: the test's details once a roll is issued (P4-M). */
  test?: AdmissionPublicTest;
  /** Sprint 1 P4: the published result of this application's class (S13). */
  result?: AdmissionPublicResult;
}
