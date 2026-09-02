/**
 * CSV encoding, to RFC 4180.
 *
 * Pure and dependency-free, so the escaping rules can be asserted directly
 * rather than inferred from a file someone opened once in Excel.
 *
 * Three decisions here exist purely because the file is opened by a spreadsheet
 * rather than parsed by a program: the byte order mark, the CRLF line ending,
 * and the formula guard below. All three are documented where they happen.
 */

/**
 * UTF-8 byte order mark.
 *
 * Excel does not detect UTF-8 in a .csv without it — it falls back to the
 * system code page, and every accented name and Arabic identifier arrives as
 * mojibake. Google Sheets and every sane parser skip it silently, so the cost
 * of including it is nothing and the cost of omitting it is unreadable data.
 */
export const CSV_BOM = "﻿";

/**
 * RFC 4180 says CRLF, and Excel on Windows is the reason to care.
 *
 * A lone LF inside a quoted field is still handled correctly by both Excel and
 * Sheets, which is what makes multi-line notes safe.
 */
const ROW_SEPARATOR = "\r\n";

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than text.
 *
 * The classic CSV injection vector: a note reading `=HYPERLINK("http://evil",…)`
 * becomes a live link the moment somebody opens the export.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@"];

/**
 * Structure that only appears in a formula, never in this CRM's data.
 *
 * The prefix alone is not enough to judge by, and this is the reason the guard
 * is written this way rather than as the usual blanket rule. Two of the four
 * prefixes are ordinary here: international identifiers are displayed as
 * `+213…`, and a customer identifier may legitimately be an `@handle`. Prefixing
 * those with an apostrophe would corrupt the most common values in the file to
 * defend against a string that cannot execute anything.
 *
 * A formula needs a call or a reference. Requiring one of these alongside the
 * prefix keeps `+213456789012` and `@yasser` exact while still catching
 * `+HYPERLINK(…)`, `=cmd|'…'!A1` and `@SUM(…)`.
 */
const FORMULA_STRUCTURE = /[(!|]/;

/**
 * Neutralises a cell a spreadsheet would otherwise execute.
 *
 * A leading apostrophe is the conventional marker for "this is text". It is
 * applied only to values that both start like a formula and contain the
 * structure of one — see FORMULA_STRUCTURE for why that pair, and not the
 * prefix alone.
 */
function guardFormula(value: string): string {
  const startsLikeFormula = FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));

  if (startsLikeFormula && FORMULA_STRUCTURE.test(value)) {
    return `'${value}`;
  }

  /*
   * A leading tab or carriage return is stripped by some parsers and shifts the
   * cell in others. Neither ever appears legitimately at the start of a value
   * here, so it is guarded unconditionally.
   */
  if (value.startsWith("\t") || value.startsWith("\r")) {
    return `'${value}`;
  }

  return value;
}

/**
 * One cell, escaped.
 *
 * Quoting is required when the value contains a comma, a quote, or a line
 * break; inside quotes, a quote is doubled. Null and undefined become empty
 * rather than the strings "null" and "undefined", which is what a spreadsheet
 * reader expects a blank to look like.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = guardFormula(String(value));

  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }

  return raw;
}

/** One row, joined. */
export function toCsvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCsvCell).join(",");
}

/**
 * A complete CSV document, ready to be written to a file.
 *
 * Headers are escaped exactly like data: a column could one day contain a
 * comma, and a header row that is escaped by a different set of rules is a
 * whole class of off-by-one-column bug.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return CSV_BOM + [toCsvRow(headers), ...rows.map(toCsvRow)].join(ROW_SEPARATOR) + ROW_SEPARATOR;
}

/**
 * `accounts-2026-09-02.csv`.
 *
 * Local date rather than UTC: the operator naming a file means the day they are
 * having, not the day in Greenwich.
 */
export function timestampedFilename(prefix: string, now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${prefix}-${year}-${month}-${day}.csv`;
}
