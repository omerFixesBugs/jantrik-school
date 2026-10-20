import { parse as parseCsv } from 'csv-parse/sync';
import {
  IMPORT_FIELDS,
  IMPORT_HEADERS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  templateHeader,
  toCsv,
  type ImportField,
} from '@jantrik/shared';
import { Unzip, UnzipInflate } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { apiError } from '../common/api-error.js';

/** Unpacked size limit for an .xlsx (it is a zip): a small file must not expand into gigabytes. */
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
const MAX_COLUMNS = 60;
const MAX_CELL_CHARS = 500;
/** All cells together: what we store and re-read while importing. */
const MAX_TOTAL_CHARS = 5_000_000;
/** Inflate in slices this big, so one step can produce at most ~1000× of it. */
const INFLATE_SLICE = 16 * 1024;

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

/**
 * An uploaded .xlsx or .csv → header row + data rows, all as text. Formulas are never
 * evaluated: read-excel-file returns the value Excel saved for a formula cell. Numbers are kept as
 * their stored text (so 17-digit numbers and phones are not reformatted); dates become
 * YYYY-MM-DD. Fully empty rows are dropped.
 */
export async function parseUpload(buffer: Buffer, fileName: string): Promise<ParsedSheet> {
  if (buffer.length === 0) throw apiError(422, 'FILE_EMPTY', 'The file is empty');
  if (buffer.length > IMPORT_MAX_BYTES) throw apiError(413, 'FILE_TOO_LARGE', 'At most 5 MB');
  const lower = fileName.toLowerCase();
  const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  let grid: string[][];
  if (lower.endsWith('.xlsx')) {
    if (!isZip) throw apiError(422, 'FILE_INVALID', 'Not an .xlsx file');
    assertZipSize(buffer);
    assertInflatedSize(buffer);
    try {
      const data = await readSheet(buffer, { parseNumber: (s: string) => s });
      grid = data.map((row) => row.map(cellText));
    } catch {
      throw apiError(422, 'FILE_INVALID', 'Could not read the spreadsheet');
    }
  } else if (lower.endsWith('.csv')) {
    if (isZip) throw apiError(422, 'FILE_INVALID', 'This looks like an .xlsx file');
    try {
      grid = parseCsv(stripBom(buffer.toString('utf8')), {
        relax_column_count: true,
        skip_empty_lines: true,
        bom: true,
        // Stop early instead of parsing millions of records/fields.
        to_line: IMPORT_MAX_ROWS + 50,
        max_record_size: MAX_COLUMNS * MAX_CELL_CHARS * 4,
      }) as string[][];
    } catch {
      throw apiError(422, 'FILE_INVALID', 'Could not read the CSV file');
    }
  } else {
    throw apiError(422, 'FILE_TYPE', 'Upload an .xlsx or .csv file');
  }

  const nonEmpty = grid
    .map((r) => r.slice(0, MAX_COLUMNS).map((c) => (c ?? '').toString().slice(0, MAX_CELL_CHARS)))
    .filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) throw apiError(422, 'FILE_EMPTY', 'No rows in the file');
  // Only columns with a header are kept (the rest cannot be mapped anyway).
  const width = Math.max(
    1,
    nonEmpty[0]!.reduce((w, h, i) => (h.trim() ? i + 1 : w), 0),
  );
  let chars = 0;
  for (const r of nonEmpty) {
    r.length = Math.min(r.length, width);
    for (const c of r) chars += c.length;
  }
  if (chars > MAX_TOTAL_CHARS) throw apiError(413, 'FILE_TOO_LARGE', 'Too much data in the file');
  const [headers, ...rows] = nonEmpty as [string[], ...string[][]];
  if (rows.length === 0) throw apiError(422, 'NO_DATA_ROWS', 'Only a header row');
  if (rows.length > IMPORT_MAX_ROWS) {
    throw apiError(422, 'TOO_MANY_ROWS', `At most ${IMPORT_MAX_ROWS} rows`, {
      max: IMPORT_MAX_ROWS,
      rows: rows.length,
    });
  }
  return { headers: headers.map((h) => h.trim()), rows };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Sum the uncompressed sizes in the zip's central directory (without unpacking anything) and
 * refuse archives that would expand beyond MAX_UNZIPPED_BYTES, or that use ZIP64 / are corrupt.
 */
export function assertZipSize(buf: Buffer): void {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw apiError(422, 'FILE_INVALID', 'Not a valid .xlsx file');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff || entries > 10_000) {
    throw apiError(422, 'FILE_INVALID', 'Unsupported .xlsx file');
  }
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw apiError(422, 'FILE_INVALID', 'Not a valid .xlsx file');
    }
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) throw apiError(422, 'FILE_INVALID', 'Unsupported .xlsx file');
    total += size;
    if (total > MAX_UNZIPPED_BYTES)
      throw apiError(422, 'FILE_TOO_LARGE', 'The file unpacks too large');
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

/**
 * Inflate the archive the way the parser will (local headers in order, ignoring the central
 * directory), counting the bytes that really come out, and stop past MAX_UNZIPPED_BYTES. The
 * input is fed in small slices so no single step can expand into a huge buffer.
 */
export function assertInflatedSize(buf: Buffer): void {
  let total = 0;
  let failed: Error | null = null;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    file.ondata = (err, data) => {
      if (failed) return;
      if (err) failed = err;
      else if ((total += data.length) > MAX_UNZIPPED_BYTES) {
        failed = new Error('too large');
        file.terminate();
      }
    };
    file.start();
  };
  try {
    for (let i = 0; i < buf.length && !failed; i += INFLATE_SLICE) {
      unzip.push(buf.subarray(i, i + INFLATE_SLICE), i + INFLATE_SLICE >= buf.length);
    }
  } catch {
    throw apiError(422, 'FILE_INVALID', 'Not a valid .xlsx file');
  }
  if (failed) {
    throw (failed as Error).message === 'too large'
      ? apiError(422, 'FILE_TOO_LARGE', 'The file unpacks too large')
      : apiError(422, 'FILE_INVALID', 'Not a valid .xlsx file');
  }
}

/** Columns kept as text in the template so Excel does not turn them into numbers. */
const TEXT_FIELDS = new Set<ImportField>([
  'studentCode',
  'roll',
  'dateOfBirth',
  'birthRegistrationNo',
  'guardianPhone',
  'guardian2Phone',
]);

export interface TemplateHints {
  classLevels: string[];
  sections: string[];
}

/** The import template: a header row (Bangla / English) and an instructions sheet. */
export async function templateXlsx(hints: TemplateHints): Promise<Buffer> {
  const header = IMPORT_FIELDS.map((f) => ({
    value: templateHeader(f),
    fontWeight: 'bold' as const,
    type: String,
  }));
  const blank = IMPORT_FIELDS.map((f) =>
    TEXT_FIELDS.has(f) ? { value: '', type: String, format: '@' } : null,
  );
  const data = [header, ...Array.from({ length: 200 }, () => blank)];
  const instructions = [
    [
      { value: 'কলাম / Column', fontWeight: 'bold' as const },
      { value: 'নিয়ম / Rule', fontWeight: 'bold' as const },
    ],
    ...IMPORT_FIELDS.map((f) => [templateHeader(f), RULES[f] ?? '']),
    [''],
    ['শ্রেণি / Classes', hints.classLevels.join(', ')],
    ['শাখা / Sections', hints.sections.join(', ')],
  ];
  return writeXlsxFile([
    {
      sheet: 'Students',
      data,
      columns: IMPORT_FIELDS.map((f) => ({ width: Math.max(14, templateHeader(f).length + 2) })),
      stickyRowsCount: 1,
    },
    { sheet: 'Instructions', data: instructions, columns: [{ width: 48 }, { width: 90 }] },
  ]).toBuffer();
}

export function templateCsv(): string {
  return toCsv([IMPORT_FIELDS.map(templateHeader)]);
}

const RULES: Partial<Record<ImportField, string>> = {
  studentCode: 'ঐচ্ছিক; খালি রাখলে তৈরি হবে / Optional; generated when empty',
  nameBn: 'বাংলা বা ইংরেজি, অন্তত একটি নাম / A name in Bangla or English is required',
  classLevel: `আবশ্যিক: শ্রেণির নাম বা কোড / Required: class name or code (${IMPORT_HEADERS.classLevel.en})`,
  section: 'ঐচ্ছিক; রোল দিলে আবশ্যিক / Optional; required with a roll',
  roll: '১–৯৯৯৯, শাখায় একটিই / 1–9999, unique in the section',
  dateOfBirth: 'YYYY-MM-DD বা DD/MM/YYYY',
  gender: 'ছেলে/মেয়ে/অন্যান্য or Male/Female/Other',
  religion: 'ইসলাম/হিন্দু/খ্রিস্টান/বৌদ্ধ/অন্যান্য or Islam/Hindu/…',
  bloodGroup: 'A+, A-, B+, B-, AB+, AB-, O+, O-',
  birthRegistrationNo: '১৭ অঙ্ক / 17 digits',
  guardianPhone: 'আবশ্যিক: 01XXXXXXXXX / Required',
  guardianRelation: 'পিতা/মাতা/… or Father/Mother/…; খালি = পিতা / empty = Father',
  guardian2Phone: 'ঐচ্ছিক / Optional',
};
