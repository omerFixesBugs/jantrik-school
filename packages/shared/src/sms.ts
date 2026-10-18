/**
 * SMS length and templates. Segments decide the price, so they are counted the way gateways do:
 * GSM-7 text fits 160 characters in one SMS (153 per part when split); anything else, including
 * all Bangla text, is sent as UCS-2: 70 in one SMS, 67 per part.
 */

// GSM 03.38 basic character set, and the extension table (each costs two characters).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';
const BASIC = new Set(GSM7_BASIC);
const EXTENDED = new Set(GSM7_EXTENDED);

export interface SmsLength {
  encoding: 'GSM7' | 'UCS2';
  /** Characters as the gateway counts them (GSM-7 septets, or UTF-16 code units). */
  length: number;
  segments: number;
}

export function smsLength(text: string): SmsLength {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXTENDED.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: 'GSM7', length: septets, segments: segmentCount(septets, 160, 153) };
  }
  // UCS-2 counts UTF-16 code units (an emoji is two).
  return { encoding: 'UCS2', length: text.length, segments: segmentCount(text.length, 70, 67) };
}

function segmentCount(length: number, single: number, perPart: number): number {
  if (length === 0) return 1;
  return length <= single ? 1 : Math.ceil(length / perPart);
}

/** Variables a tenant SMS template may use. */
export const SMS_TEMPLATE_VARIABLES = ['student', 'date', 'institute'] as const;
export type SmsTemplateVariable = (typeof SMS_TEMPLATE_VARIABLES)[number];

/** Built-in absent SMS (Bangla). Used when the tenant has not written its own. */
export const DEFAULT_ABSENT_SMS_TEMPLATE =
  'প্রিয় অভিভাবক, আজ {date} তারিখে {student} {institute}-এ অনুপস্থিত।';

/** Longest template allowed, in SMS segments, with long sample values filled in. */
export const MAX_TEMPLATE_SEGMENTS = 3;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Problems with a template, or an empty list. Unknown or malformed `{…}` are rejected. */
export function validateSmsTemplate(template: string): string[] {
  const problems: string[] = [];
  if (!template.trim()) problems.push('Template is empty');
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!SMS_TEMPLATE_VARIABLES.includes(name as SmsTemplateVariable)) {
      problems.push(`Unknown variable {${name}}`);
    }
  }
  const stripped = template.replace(PLACEHOLDER, '');
  if (/[{}]/.test(stripped)) problems.push('Unmatched { or }');
  // Worst case lengths: a long student name, a long Bangla date, a long institute name.
  const sample = renderSmsTemplate(template, {
    student: 'মোছাম্মৎ তাসনিম রহমান চৌধুরী',
    date: '৩০ সেপ্টেম্বর ২০২৬',
    institute: 'শাপলা উচ্চ বিদ্যালয় ও কলেজ',
  });
  if (smsLength(sample).segments > MAX_TEMPLATE_SEGMENTS) {
    problems.push(`Too long: more than ${MAX_TEMPLATE_SEGMENTS} SMS with long names`);
  }
  return [...new Set(problems)];
}

/** Fill `{student}` etc. Unknown placeholders are left as they are (validate first). */
export function renderSmsTemplate(
  template: string,
  values: Record<SmsTemplateVariable, string>,
): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    SMS_TEMPLATE_VARIABLES.includes(name as SmsTemplateVariable)
      ? values[name as SmsTemplateVariable]
      : match,
  );
}
