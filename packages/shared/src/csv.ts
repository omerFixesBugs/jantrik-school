/**
 * One CSV cell, safe to open in Excel/Sheets.
 * - Quoted when it contains a comma, quote or line break (quotes doubled).
 * - Formula injection: a cell starting with = + - @ (or a tab/CR) would be run as a formula by
 *   spreadsheet apps, so it gets a leading apostrophe and is shown as text.
 *   (OWASP "CSV Injection". Phones are exported as 01…, so they never start with +.)
 */
export function csvCell(value: string | number | null | undefined): string {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const BOM = String.fromCharCode(0xfeff);

/** Rows → CSV text: UTF-8 BOM (so Excel shows Bangla), CRLF line ends. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `${BOM}${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
