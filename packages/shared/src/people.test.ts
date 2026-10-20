import { describe, expect, it } from 'vitest';
import {
  lookalikeKeys,
  planImportGuardian,
  type ImportGuardian,
  type KnownGuardian,
} from './import.js';
import { generatedGuardianName, normalizePersonName, sameName } from './people.js';
import { guardianInputSchema } from './students.js';

describe('person names', () => {
  it('normalizes case, spaces, dots and zero-width characters', () => {
    expect(normalizePersonName('  Md.  Karim\u200D Uddin ')).toBe('md karim uddin');
    expect(normalizePersonName('MD KARIM UDDIN')).toBe('md karim uddin');
    expect(normalizePersonName('করিম\u200C উদ্দিন')).toBe('করিম উদ্দিন');
    expect(normalizePersonName(null)).toBe('');
  });

  it('matches any name against any name; empty names never match', () => {
    expect(sameName({ nameBn: null, nameEn: 'karim' }, { nameBn: null, nameEn: 'Karim' })).toBe(
      true,
    );
    expect(sameName({ nameBn: 'করিম', nameEn: null }, { nameBn: null, nameEn: 'করিম' })).toBe(true);
    expect(sameName({ nameBn: null, nameEn: 'Karim' }, { nameBn: 'করিম', nameEn: null })).toBe(
      false,
    );
    expect(sameName({ nameBn: null, nameEn: null }, { nameBn: null, nameEn: null })).toBe(false);
  });

  it('generates "<student>-এর অভিভাবক" / "Guardian of <student>", within 120 characters', () => {
    expect(generatedGuardianName({ nameBn: 'রাফি', nameEn: 'Rafi' })).toEqual({
      nameBn: 'রাফি-এর অভিভাবক',
      nameEn: 'Guardian of Rafi',
    });
    expect(generatedGuardianName({ nameBn: null, nameEn: 'Joy' })).toEqual({
      nameBn: 'Joy-এর অভিভাবক',
      nameEn: 'Guardian of Joy',
    });
    const long = generatedGuardianName({ nameBn: null, nameEn: 'x'.repeat(120) });
    expect(long.nameEn!.length).toBeLessThanOrEqual(120);
    expect(long.nameBn!.length).toBeLessThanOrEqual(120);
  });
});

describe('planImportGuardian (decision #6)', () => {
  const phone = '+8801711000001';
  const g = (names: Partial<ImportGuardian> = {}): ImportGuardian => ({
    phone,
    nameBn: null,
    nameEn: null,
    relation: 'FATHER',
    isPrimary: true,
    occupation: null,
    ...names,
  });
  const known = (nameEn: string, id: string | null = 'g1'): KnownGuardian => ({
    id,
    phone,
    nameBn: null,
    nameEn,
  });
  const student = { nameBn: null, nameEn: 'Rafi' };

  it('with a name: links only when the name matches; otherwise a new guardian', () => {
    expect(planImportGuardian(g({ nameEn: 'KARIM' }), student, [known('Karim')])).toMatchObject({
      kind: 'link',
      guardian: { id: 'g1' },
      note: 'GUARDIAN_LINKED',
    });
    expect(planImportGuardian(g({ nameEn: 'Rahim' }), student, [known('Karim')])).toEqual({
      kind: 'new',
      nameBn: null,
      nameEn: 'Rahim',
      note: 'GUARDIAN_NEW_SAME_PHONE',
    });
    expect(planImportGuardian(g({ nameEn: 'Rahim' }), student, [])).toMatchObject({
      kind: 'new',
      note: null,
    });
  });

  it('without a name: one guardian on the phone links, several is an error, none is generated', () => {
    expect(planImportGuardian(g(), student, [known('Karim')])).toMatchObject({
      kind: 'link',
      note: 'GUARDIAN_LINKED_BY_PHONE_ONLY',
    });
    expect(planImportGuardian(g(), student, [known('A', 'a'), known('B', 'b')])).toEqual({
      kind: 'ambiguous',
    });
    expect(planImportGuardian(g(), student, [])).toEqual({
      kind: 'new',
      nameBn: 'Rafi-এর অভিভাবক',
      nameEn: 'Guardian of Rafi',
      note: 'GUARDIAN_NAME_GENERATED',
    });
  });

  it('a name that is only dots or blanks counts as no name', () => {
    expect(planImportGuardian(g({ nameEn: ' . ' }), student, [known('Karim')])).toMatchObject({
      kind: 'link',
      note: 'GUARDIAN_LINKED_BY_PHONE_ONLY',
    });
  });

  it('only guardians with the same phone count', () => {
    const elsewhere = { ...known('Karim'), phone: '+8801711000002' };
    expect(planImportGuardian(g(), student, [elsewhere])).toMatchObject({
      kind: 'new',
      note: 'GUARDIAN_NAME_GENERATED',
    });
  });
});

describe('guardian input: pick an existing guardian or add a new one', () => {
  const base = { phone: '01711000001', relation: 'FATHER', isPrimary: true };
  it('accepts one choice, not both', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(guardianInputSchema.parse({ ...base, guardianId: id })).toMatchObject({
      guardianId: id,
      createNew: false,
    });
    expect(guardianInputSchema.parse(base)).toMatchObject({ guardianId: null, createNew: false });
    expect(
      guardianInputSchema.safeParse({ ...base, guardianId: id, createNew: true }).success,
    ).toBe(false);
  });
});

describe('lookalikeKeys (possible duplicates, decision #22)', () => {
  const base = {
    nameBn: 'রাফি',
    nameEn: 'Rafi Ahmed',
    classLevelId: 'c6',
    phones: ['+8801711000001'],
  };
  const shares = (a: string[], b: string[]) => a.some((k) => b.includes(k));
  it('the same child: name (either script, any case or spacing), class and a guardian phone', () => {
    expect(
      shares(lookalikeKeys(base), lookalikeKeys({ ...base, nameBn: null, nameEn: 'RAFI  ahmed' })),
    ).toBe(true);
    expect(
      shares(
        lookalikeKeys(base),
        lookalikeKeys({ ...base, nameEn: null, phones: ['+8801711000002', '+8801711000001'] }),
      ),
    ).toBe(true);
  });
  it('another class, another phone or another name is not', () => {
    expect(shares(lookalikeKeys(base), lookalikeKeys({ ...base, classLevelId: 'c7' }))).toBe(false);
    expect(
      shares(lookalikeKeys(base), lookalikeKeys({ ...base, phones: ['+8801711000009'] })),
    ).toBe(false);
    expect(
      shares(lookalikeKeys(base), lookalikeKeys({ ...base, nameBn: 'রিফাত', nameEn: 'Rifat' })),
    ).toBe(false);
    expect(lookalikeKeys({ ...base, nameBn: null, nameEn: null })).toEqual([]);
  });
});
