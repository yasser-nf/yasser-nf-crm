import type { ReportColumn } from "./report-definitions";

/**
 * CSV serialisation.
 *
 * Pure, dependency-free and streamable a row at a time. RFC 4180 quoting, which
 * is four rules and does not justify a package — ADR-011 Decision 1.
 *
 * The escaping matters more than it looks: a customer note containing a comma,
 * a quote or a newline is ordinary, and getting any of the three wrong shifts
 * every following column into the wrong field without erroring.
 */

export const CSV_MIME = "text/csv; charset=utf-8";

/**
 * A UTF-8 byte-order mark.
 *
 * Excel on Windows assumes the system codepage for a .csv without one, so an
 * Arabic or accented name arrives as mojibake. Three bytes to prevent the most
 * common complaint about CSV exports.
 */
export const UTF8_BOM = "﻿";

/**
 * Quotes a single field.
 *
 * A field is quoted when it contains a comma, a quote, a carriage return or a
 * newline. Inner quotes are doubled. Everything else is written bare, which
 * keeps the output readable.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  /*
   * A leading =, +, - or @ makes Excel treat the cell as a formula. That is the
   * CSV injection vector: a customer named `=cmd|...` becomes executable when
   * somebody opens the export. Prefixing a quote-escaped tab neutralises it
   * while still displaying the original text.
   */
  if (/^[=+\-@\t\r]/.test(text)) {
    return `"\t${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(",");
}

export function csvHeader(columns: readonly ReportColumn[]): string {
  return csvRow(columns.map((column) => column.label));
}

/** One row of a dataset, projected onto the report's columns. */
export function csvRowFor(row: Record<string, unknown>, columns: readonly ReportColumn[]): string {
  return csvRow(columns.map((column) => row[column.key]));
}

export const csvService = {
  mime: CSV_MIME,
  bom: UTF8_BOM,
  field: csvField,
  row: csvRow,
  header: csvHeader,
  rowFor: csvRowFor,
  extension: "csv",
} as const;
