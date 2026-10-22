import type {
  AttendanceMode,
  Locale,
  Prisma,
  PrismaClient,
  RoundingMode,
  ThemePreset,
} from '../generated/prisma/client.js';

// Global reference data: institute types and the templates copied into each new tenant.
// Adding an institute type (QAWMI, ALIYA, ENGLISH_MEDIUM, TECHNICAL, ...) means adding an entry
// here (or rows via an admin tool later) — never code branches on the type key.

interface NamePair {
  code: string;
  bn: string;
  en: string;
}

interface SubjectDef extends NamePair {
  group?: string;
  optional?: boolean;
}

interface ClassLevelDef extends NamePair {
  subjects: SubjectDef[];
}

interface InstituteTypeDef {
  key: string;
  bn: string;
  en: string;
  defaultLocale: Locale;
  /** Default attendance_settings.mode for new tenants of this type. */
  attendanceMode: AttendanceMode;
  /** The theme its institutes get until the owner picks another (packages/shared themes). */
  defaultTheme: ThemePreset;
  gradingScheme: string;
  labels: Record<string, [bn: string, en: string]>;
  studyGroups: NamePair[];
  classLevels: ClassLevelDef[];
}

interface GradingSchemeDef {
  key: string;
  bn: string;
  en: string;
  roundingMode: RoundingMode;
  bands: { min: number; max: number; letter: string; point: number }[];
}

export const GRADING_SCHEMES: GradingSchemeDef[] = [
  {
    key: 'BD_GPA_5',
    bn: 'জিপিএ ৫.০ (বাংলাদেশ)',
    en: 'Bangladesh GPA 5.0',
    roundingMode: 'NONE',
    bands: [
      { min: 80, max: 100, letter: 'A+', point: 5 },
      { min: 70, max: 79, letter: 'A', point: 4 },
      { min: 60, max: 69, letter: 'A-', point: 3.5 },
      { min: 50, max: 59, letter: 'B', point: 3 },
      { min: 40, max: 49, letter: 'C', point: 2 },
      { min: 33, max: 39, letter: 'D', point: 1 },
      { min: 0, max: 32, letter: 'F', point: 0 },
    ],
  },
];

const s = (code: string, bn: string, en: string, extra: Partial<SubjectDef> = {}): SubjectDef => ({
  code,
  bn,
  en,
  ...extra,
});

const BAN = s('BAN', 'বাংলা', 'Bangla');
const ENG = s('ENG', 'ইংরেজি', 'English');
const MATH = s('MATH', 'গণিত', 'Mathematics');
const BGS = s('BGS', 'বাংলাদেশ ও বিশ্বপরিচয়', 'Bangladesh and Global Studies');
const SCI = s('SCI', 'বিজ্ঞান', 'Science');
const REL = s('REL', 'ধর্ম ও নৈতিক শিক্ষা', 'Religion and Moral Education');
const ICT = s('ICT', 'তথ্য ও যোগাযোগ প্রযুক্তি', 'Information and Communication Technology');
const PHY = s('PHY', 'পদার্থবিজ্ঞান', 'Physics');
const CHEM = s('CHEM', 'রসায়ন', 'Chemistry');
const BIO = s('BIO', 'জীববিজ্ঞান', 'Biology');
const HMATH = s('HMATH', 'উচ্চতর গণিত', 'Higher Mathematics');

const BN_ORDINALS = [
  'প্রথম',
  'দ্বিতীয়',
  'তৃতীয়',
  'চতুর্থ',
  'পঞ্চম',
  'ষষ্ঠ',
  'সপ্তম',
  'অষ্টম',
  'নবম',
  'দশম',
];

function nctbSubjects(n: number): SubjectDef[] {
  if (n <= 2) return [BAN, ENG, MATH];
  if (n <= 5) return [BAN, ENG, MATH, BGS, SCI, REL];
  if (n <= 8) return [BAN, ENG, MATH, SCI, BGS, ICT, REL];
  return [
    BAN,
    ENG,
    MATH,
    ICT,
    REL,
    // Science group
    { ...PHY, group: 'SCIENCE' },
    { ...CHEM, group: 'SCIENCE' },
    { ...BIO, group: 'SCIENCE' },
    { ...HMATH, group: 'SCIENCE', optional: true },
    { ...BGS, code: 'BGS_SCI', group: 'SCIENCE' },
    // Business Studies group
    s('ACC', 'হিসাববিজ্ঞান', 'Accounting', { group: 'BUSINESS' }),
    s('FIN', 'ফিন্যান্স ও ব্যাংকিং', 'Finance and Banking', { group: 'BUSINESS' }),
    s('BENT', 'ব্যবসায় উদ্যোগ', 'Business Entrepreneurship', { group: 'BUSINESS' }),
    { ...SCI, code: 'SCI_BUS', group: 'BUSINESS' },
    // Humanities group
    s('HIST', 'বাংলাদেশের ইতিহাস ও বিশ্বসভ্যতা', 'History of Bangladesh and World Civilisation', {
      group: 'HUMANITIES',
    }),
    s('GEO', 'ভূগোল ও পরিবেশ', 'Geography and Environment', { group: 'HUMANITIES' }),
    s('CIV', 'পৌরনীতি ও নাগরিকতা', 'Civics and Citizenship', { group: 'HUMANITIES' }),
    s('ECON', 'অর্থনীতি', 'Economics', { group: 'HUMANITIES' }),
    { ...SCI, code: 'SCI_HUM', group: 'HUMANITIES' },
  ];
}

const NCTB_CLASS_LEVELS: ClassLevelDef[] = BN_ORDINALS.map((bn, i) => ({
  code: `CLASS_${i + 1}`,
  bn: `${bn} শ্রেণি`,
  en: `Class ${i + 1}`,
  subjects: nctbSubjects(i + 1),
}));

const NCTB_STUDY_GROUPS: NamePair[] = [
  { code: 'SCIENCE', bn: 'বিজ্ঞান', en: 'Science' },
  { code: 'BUSINESS', bn: 'ব্যবসায় শিক্ষা', en: 'Business Studies' },
  { code: 'HUMANITIES', bn: 'মানবিক', en: 'Humanities' },
];

const SCHOOL_LABELS: InstituteTypeDef['labels'] = {
  class_level: ['শ্রেণি', 'Class'],
  section: ['শাখা', 'Section'],
  academic_year: ['শিক্ষাবর্ষ', 'Academic Year'],
  shift: ['শিফট', 'Shift'],
  study_group: ['বিভাগ', 'Group'],
  student: ['শিক্ষার্থী', 'Student'],
  roll: ['রোল', 'Roll'],
};

export const INSTITUTE_TYPES: InstituteTypeDef[] = [
  {
    key: 'COACHING',
    bn: 'কোচিং সেন্টার',
    en: 'Coaching Centre',
    defaultLocale: 'bn',
    attendanceMode: 'PER_SESSION',
    defaultTheme: 'COACHING',
    gradingScheme: 'BD_GPA_5',
    labels: {
      class_level: ['কোর্স', 'Course'],
      section: ['ব্যাচ', 'Batch'],
      academic_year: ['সেশন', 'Session'],
      shift: ['শিফট', 'Shift'],
      study_group: ['বিভাগ', 'Group'],
      student: ['শিক্ষার্থী', 'Student'],
      roll: ['আইডি', 'ID'],
    },
    studyGroups: [],
    classLevels: [
      ...[6, 7, 8].map((n) => ({
        code: `CLASS_${n}`,
        bn: `${BN_ORDINALS[n - 1]} শ্রেণি`,
        en: `Class ${n}`,
        subjects: [MATH, ENG, SCI],
      })),
      ...[9, 10].map((n) => ({
        code: `CLASS_${n}`,
        bn: `${BN_ORDINALS[n - 1]} শ্রেণি (এসএসসি)`,
        en: `Class ${n} (SSC)`,
        subjects: [MATH, HMATH, PHY, CHEM, BIO, ENG],
      })),
      {
        code: 'HSC_1',
        bn: 'একাদশ শ্রেণি (এইচএসসি)',
        en: 'HSC 1st Year',
        subjects: [PHY, CHEM, BIO, HMATH, ENG, ICT],
      },
      {
        code: 'HSC_2',
        bn: 'দ্বাদশ শ্রেণি (এইচএসসি)',
        en: 'HSC 2nd Year',
        subjects: [PHY, CHEM, BIO, HMATH, ENG, ICT],
      },
    ],
  },
  {
    key: 'NCTB_SCHOOL_BN',
    bn: 'এনসিটিবি স্কুল (বাংলা ভার্সন)',
    en: 'NCTB School (Bangla Version)',
    defaultLocale: 'bn',
    attendanceMode: 'DAILY',
    defaultTheme: 'SCHOOL',
    gradingScheme: 'BD_GPA_5',
    labels: SCHOOL_LABELS,
    studyGroups: NCTB_STUDY_GROUPS,
    classLevels: NCTB_CLASS_LEVELS,
  },
  {
    key: 'NCTB_SCHOOL_EN',
    bn: 'এনসিটিবি স্কুল (ইংলিশ ভার্সন)',
    en: 'NCTB School (English Version)',
    defaultLocale: 'en',
    attendanceMode: 'DAILY',
    defaultTheme: 'ENGLISH_MEDIUM',
    gradingScheme: 'BD_GPA_5',
    labels: SCHOOL_LABELS,
    studyGroups: NCTB_STUDY_GROUPS,
    classLevels: NCTB_CLASS_LEVELS,
  },
];

/**
 * Upsert all global reference data. Idempotent. Must run as the schema owner
 * (the app role has read-only access to these tables). An advisory lock serialises concurrent
 * callers (e.g. the db and api test setups running in parallel).
 */
export async function seedTemplates(client: PrismaClient): Promise<void> {
  await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('jantrik:seed-templates'))`;
      await upsertTemplates(tx);
    },
    { timeout: 120_000 },
  );
}

async function upsertTemplates(owner: Prisma.TransactionClient): Promise<void> {
  const schemeIds = new Map<string, string>();
  for (const def of GRADING_SCHEMES) {
    const scheme = await owner.gradingSchemeTemplate.upsert({
      where: { key: def.key },
      create: { key: def.key, nameBn: def.bn, nameEn: def.en, roundingMode: def.roundingMode },
      update: { nameBn: def.bn, nameEn: def.en, roundingMode: def.roundingMode },
    });
    schemeIds.set(def.key, scheme.id);
    for (const b of def.bands) {
      const data = { minPercent: b.min, maxPercent: b.max, gradePoint: b.point };
      await owner.gradeBandTemplate.upsert({
        where: {
          gradingSchemeTemplateId_letter: { gradingSchemeTemplateId: scheme.id, letter: b.letter },
        },
        create: { gradingSchemeTemplateId: scheme.id, letter: b.letter, ...data },
        update: data,
      });
    }
  }

  for (const [i, def] of INSTITUTE_TYPES.entries()) {
    const typeData = {
      nameBn: def.bn,
      nameEn: def.en,
      defaultLocale: def.defaultLocale,
      attendanceMode: def.attendanceMode,
      defaultTheme: def.defaultTheme,
      sortOrder: i,
      defaultGradingSchemeTemplateId: schemeIds.get(def.gradingScheme) ?? null,
    };
    const type = await owner.instituteType.upsert({
      where: { key: def.key },
      create: { key: def.key, ...typeData },
      update: typeData,
    });
    const instituteTypeId = type.id;

    for (const [key, [valueBn, valueEn]] of Object.entries(def.labels)) {
      await owner.templateLabel.upsert({
        where: { instituteTypeId_key: { instituteTypeId, key } },
        create: { instituteTypeId, key, valueBn, valueEn },
        update: { valueBn, valueEn },
      });
    }

    const groupIds = new Map<string, string>();
    for (const [order, g] of def.studyGroups.entries()) {
      const data = { nameBn: g.bn, nameEn: g.en, sortOrder: order };
      const group = await owner.templateStudyGroup.upsert({
        where: { instituteTypeId_code: { instituteTypeId, code: g.code } },
        create: { instituteTypeId, code: g.code, ...data },
        update: data,
      });
      groupIds.set(g.code, group.id);
    }

    for (const [order, c] of def.classLevels.entries()) {
      const data = { nameBn: c.bn, nameEn: c.en, sortOrder: order };
      const level = await owner.templateClassLevel.upsert({
        where: { instituteTypeId_code: { instituteTypeId, code: c.code } },
        create: { instituteTypeId, code: c.code, ...data },
        update: data,
      });
      for (const [subjectOrder, sub] of c.subjects.entries()) {
        const subjectData = {
          nameBn: sub.bn,
          nameEn: sub.en,
          isOptional: sub.optional ?? false,
          sortOrder: subjectOrder,
          templateStudyGroupId: sub.group ? (groupIds.get(sub.group) ?? null) : null,
        };
        await owner.templateSubject.upsert({
          where: {
            templateClassLevelId_code: { templateClassLevelId: level.id, code: sub.code },
          },
          create: { templateClassLevelId: level.id, code: sub.code, ...subjectData },
          update: subjectData,
        });
      }
    }
  }
}
