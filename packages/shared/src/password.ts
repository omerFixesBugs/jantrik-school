import { toAsciiDigits } from './digits.js';

/**
 * Staff passwords (S26). Lengths count Unicode code points after NFC, so a Bangla password counts
 * what the person typed, whichever keyboard composed it. No composition rules (digits, symbols).
 */
export const PASSWORD_RULES = { min: 10, max: 128 } as const;

/**
 * Institute names shorter than this (in characters, i.e. code points, without spaces) are not
 * checked: such a short name would refuse many passwords.
 */
const MIN_NAME_LENGTH = 4;

/** `TOO_COMMON` is added by the server, which holds the common-password list. */
export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'HAS_PHONE' | 'HAS_INSTITUTE_NAME';

/**
 * The one form a password is hashed and verified in (P1-C): NFC, so composed and decomposed input
 * (e.g. য় as one code point or two) give the same password.
 */
export function normalizePassword(pw: string): string {
  return pw.normalize('NFC');
}

/** Khanda ta in its old encoding (ত + hasant + zero-width joiner), the same letter as ৎ. */
const OLD_KHANDA_TA = /\u09A4\u09CD\u200D/gu;
/** Characters that show nothing (soft hyphen, zero-width space and joiners, word joiner…). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
/** Where an institute name splits into words: spaces, punctuation, symbols, zero-width spaces. */
const WORD_BREAK = /[\p{P}\p{S}\s\u200B]+/u;
/** What a password and a name are compared without, as the phone rule does. */
const NOT_COMPARED = /[\p{P}\p{S}\s\p{Default_Ignorable_Code_Point}]/gu;

/**
 * NFKC (full-width letters and digits become plain ones), khanda ta unified, lower-case, ASCII
 * digits: the form in which passwords and institute names are compared.
 */
function folded(text: string): string {
  return toAsciiDigits(text.normalize('NFKC').replace(OLD_KHANDA_TA, '\u09CE').toLowerCase());
}

/** `folded`, without spaces, punctuation, symbols or invisible characters. */
function comparable(text: string): string {
  return folded(text).replace(NOT_COMPARED, '');
}

/**
 * Words many institutes' names share (P1-I): what kind of institute it is, its level, who it is
 * for, its medium. They say nothing about which institute it is, so a password may contain them;
 * every other word of 4 or more characters in the name is refused. Spelling variants are listed
 * separately; Unicode forms (য় as one code point or two) need not be, `comparable` unifies them.
 * English first (with Bangla words as written in English letters), then Bangla.
 */
export const GENERIC_NAME_WORDS: readonly string[] = `
  school schools college collegiate academy academic university madrasa madrasah madrassa
  madrassah madrasha high higher secondary primary junior senior preparatory model ideal public
  government govt cadet residential girls girl boys boy women womens ladies mohila mahila english
  bangla medium version international coaching centre center institute institution kindergarten
  kinder technical vocational polytechnic training tutorial laboratory islamia islamiya islamic
  alia aliya aliah dakhil alim fazil kamil hafizia hafezia hifz hifzul tahfiz tahfizul quran
  qawmi qaumi kawmi nurani noorani darul uloom ulum jamia jamea bidyalaya bidyaloy biddyaloy
  vidyalaya bidyapith bidyaniketan niketan pathshala shikkha
  balika balok uchcha uccha bidyalay biddyalay vidyalay madhyamik madhyomik maddhomik
  prathomik prathamik adarsha adarsho adarsa sarkari sorkari pilot memorial smriti smrity sriti
  shishu sishu ebtedayee ebtedayi ibtedayee ibtedayi nursery shaheed shahid shohid
  বিদ্যালয় মহাবিদ্যালয় উচ্চ মাধ্যমিক নিম্ন প্রাথমিক জুনিয়র সিনিয়র স্কুল হাই কলেজ মাদ্রাসা
  মাদরাসা একাডেমি একাডেমী বিশ্ববিদ্যালয় সরকারি সরকারী বেসরকারি বেসরকারী মডেল আদর্শ আইডিয়াল
  পাবলিক ক্যাডেট আবাসিক রেসিডেন্সিয়াল বালিকা বালক মহিলা গার্লস বয়েজ ইংলিশ বাংলা মিডিয়াম ভার্সন
  ইন্টারন্যাশনাল আন্তর্জাতিক কোচিং সেন্টার কেন্দ্র ইনস্টিটিউট ইন্সটিটিউট ইনস্টিটিউশন প্রতিষ্ঠান
  কিন্ডারগার্টেন কিন্ডার টেকনিক্যাল কারিগরি ভোকেশনাল পলিটেকনিক প্রশিক্ষণ আলিয়া দাখিল আলিম ফাজিল
  কামিল হাফিজিয়া হাফেজিয়া হিফজ হিফজুল তাহফিজুল কুরআন কোরআন নূরানী নুরানী কওমী কওমি ইসলামিয়া
  ইসলামী ইসলামি দারুল উলুম জামিয়া পাঠশালা বিদ্যানিকেতন বিদ্যাপীঠ বিদ্যামন্দির নিকেতন শিক্ষা
  শিক্ষালয় অ্যান্ড এন্ড এবং
  পাইলট মেমোরিয়াল স্মৃতি শিশু ইবতেদায়ী ইবতেদায়ি নার্সারি নার্সারী শহীদ শহিদ
`
  .split(/\s+/u)
  .filter((w) => w !== '');

const GENERIC = new Set(GENERIC_NAME_WORDS.map(comparable));
const GENERIC_LIST = [...GENERIC];

/**
 * Generic words glued to the end of a word are cut off only when together they are this long (in
 * code points): `শাপলাউচ্চবিদ্যালয়` → `শাপলা`, `kodomtolaschool` → `kodomtola`, but `australia` keeps
 * its `alia`, so no fragment like `austr` becomes a word of the name.
 */
const MIN_GLUED_TAIL = 6;

/**
 * Where the generic words glued to the end of a word start (`কোচিংসেন্টার` → 0,
 * `শাপলাউচ্চবিদ্যালয়` → the index of উচ্চ), so `শাপলা` is found in a name typed without spaces.
 * Only endings: names put the kind of institute last, and a generic word at the start of an
 * ordinary word (`highland`) is not stripped.
 */
function genericTailStart(word: string): number {
  // tail[i]: word.slice(i) is made of generic words only.
  const tail: boolean[] = [];
  tail[word.length] = true;
  let start = word.length;
  for (let i = word.length - 1; i >= 0; i--) {
    tail[i] = GENERIC_LIST.some((g) => word.startsWith(g, i) && tail[i + g.length] === true);
    if (tail[i]) start = i;
  }
  return start;
}

const codePoints = (text: string): number => [...text].length;

/**
 * The words of an institute name that point at that institute (P1-I): split at spaces,
 * punctuation, symbols and zero-width spaces, compared as `comparable` does; generic words and
 * words of digits only are dropped; 4 characters (code points) or more. A word with generic words
 * of `MIN_GLUED_TAIL` or more glued to its end counts twice, whole and without them.
 */
export function distinctiveNameWords(name: string): string[] {
  const words = new Set<string>();
  for (const part of folded(name).split(WORD_BREAK)) {
    const word = part.replace(INVISIBLE, '');
    if (word === '' || /^\d+$/u.test(word)) continue;
    const cut = genericTailStart(word);
    if (cut === 0) continue; // only generic words
    const stem = codePoints(word.slice(cut)) >= MIN_GLUED_TAIL ? word.slice(0, cut) : word;
    for (const w of [word, stem]) if (codePoints(w) >= MIN_NAME_LENGTH) words.add(w);
  }
  return [...words];
}

/** The 10-digit national number (`17XXXXXXXX`) of a Bangladeshi phone, or null if there is none. */
function nationalNumber(phone: string): string | null {
  const digits = toAsciiDigits(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * What is wrong with a password, given who sets it (S26, P1-D). Empty when it may be used. The
 * server passes the names of every institute the person belongs to; the web, the current one.
 */
export function passwordProblems(
  pw: string,
  about: { phone: string; instituteNames: readonly string[] },
): PasswordProblem[] {
  const password = normalizePassword(pw);
  const problems: PasswordProblem[] = [];
  const length = [...password].length;
  if (length < PASSWORD_RULES.min) problems.push('TOO_SHORT');
  if (length > PASSWORD_RULES.max) problems.push('TOO_LONG');

  // The phone in any form: 01…, +8801…, 8801…, Bangla digits, split by spaces, punctuation or
  // symbols (dashes, dots, brackets, slashes, underscores…).
  const national = nationalNumber(about.phone);
  const passwordDigits = toAsciiDigits(password).replace(/[\p{P}\p{S}\s]/gu, '');
  if (national && passwordDigits.includes(national)) problems.push('HAS_PHONE');

  // The whole name (generic words included), or one of its distinctive words (P1-I).
  const passwordText = comparable(password);
  const hasName = about.instituteNames.some((name) => {
    const n = comparable(name);
    if (codePoints(n) >= MIN_NAME_LENGTH && passwordText.includes(n)) return true;
    return distinctiveNameWords(name).some((w) => passwordText.includes(w));
  });
  if (hasName) problems.push('HAS_INSTITUTE_NAME');
  return problems;
}

/** `GET /me/password`. */
export interface PasswordStatus {
  hasPassword: boolean;
  /** ISO time the person last set it themselves; null if never. */
  changedAt: string | null;
  /** The person's own phone (E.164), so the form can check the rules as they type. */
  phone: string;
}

/** `POST /me/password/code` (202). */
export interface PasswordCodeSent {
  /** Seconds the code stays valid. */
  expiresIn: number;
  /** The phone the code went to, mostly hidden, e.g. `017•••••002`. */
  phoneHint: string;
}
