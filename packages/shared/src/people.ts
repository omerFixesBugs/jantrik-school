// Person names as an institute stores them (students, guardians): comparing and generating.

export interface PersonNames {
  nameBn: string | null;
  nameEn: string | null;
}

/** For comparing names: NFC, zero-width characters dropped, dots and spaces collapsed, lowercase. */
export function normalizePersonName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\s.]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when a name of `a` equals a name of `b` (Bangla or English, in either field). */
export function sameName(a: PersonNames, b: PersonNames): boolean {
  const right = new Set([b.nameBn, b.nameEn].map(normalizePersonName).filter(Boolean));
  return [a.nameBn, a.nameEn].map(normalizePersonName).some((n) => n && right.has(n));
}

const GENERATED_BN = '-এর অভিভাবক';
const GENERATED_EN = 'Guardian of ';

/** True when at least one name is left after normalising ("." or blanks are no name). */
export const hasPersonName = (n: PersonNames): boolean =>
  Boolean(normalizePersonName(n.nameBn) || normalizePersonName(n.nameEn));

/** A name made by `generatedGuardianName` (never used as the person's own login name). */
export const isGeneratedGuardianName = (n: PersonNames): boolean =>
  Boolean(n.nameEn?.startsWith(GENERATED_EN) && n.nameBn?.endsWith(GENERATED_BN));

/**
 * A display name for a guardian a list did not name: "<student>-এর অভিভাবক" / "Guardian of
 * <student>" (the student's name shortened so the result fits the 120-character limit).
 */
export function generatedGuardianName(student: PersonNames): PersonNames {
  const cut = (s: string | null) => (s && s.length > 100 ? `${s.slice(0, 100)}…` : s);
  const bn = cut(student.nameBn ?? student.nameEn);
  const en = cut(student.nameEn ?? student.nameBn);
  return {
    nameBn: bn ? `${bn}${GENERATED_BN}` : null,
    nameEn: en ? `${GENERATED_EN}${en}` : null,
  };
}
