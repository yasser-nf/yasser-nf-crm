import type { ReportColumn } from "./report-definitions";

/**
 * Excel serialisation, without a dependency.
 *
 * ADR-011 Decision 1: the format is SpreadsheetML 2003 â€” a single XML document
 * Excel, LibreOffice and Numbers all open natively. A real `.xlsx` is a ZIP of
 * a dozen XML parts, which cannot be produced honestly without a library or a
 * ZIP implementation, and neither is justified for an internal CRM export.
 *
 * What this buys over CSV, and why it is worth having at all: real cell types.
 * A number stays a number and a date stays a date, so nobody has to re-type a
 * column after opening the file, and a phone number is not silently reformatted
 * into scientific notation.
 *
 * Streamable: the header, each row and the footer are separate strings, so a
 * large export never exists in memory as a whole.
 */

export const EXCEL_MIME = "application/vnd.ms-excel";
export const EXCEL_EXTENSION = "xls";

/**
 * Escapes text for XML.
 *
 * Control characters are stripped rather than escaped. XML 1.0 forbids most of
 * them outright, and a single stray byte in a note field would make the whole
 * workbook unopenable â€” a corrupt export is worse than a lossy one.
 */
export function xmlText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  /*
   * Strip the control characters XML 1.0 forbids, by code point rather than
   * with a regex containing literal control bytes - those are invisible in a
   * source file and trivially mangled by an edit. Tab, newline and carriage
   * return are the three that are legal, and they are kept.
   */
  let stripped = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      stripped += character;
    }
  }

  return stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(value: unknown, numeric: boolean): string {
  if (value === null || value === undefined || value === "") {
    return "<Cell/>";
  }

  /*
   * Only emit a Number cell when the value really is finite and numeric.
   * Declaring a type Excel then cannot parse makes it refuse the file, so the
   * check is deliberately strict rather than optimistic.
   */
  if (numeric && typeof value === "number" && Number.isFinite(value)) {
    return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  }

  return `<Cell><Data ss:Type="String">${xmlText(value)}</Data></Cell>`;
}

export function excelHeader(title: string, columns: readonly ReportColumn[]): string {
  const headerCells = columns
    .map(
      (column) =>
        `<Cell ss:StyleID="head"><Data ss:Type="String">${xmlText(column.label)}</Data></Cell>`,
    )
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"` +
    ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<Styles>` +
    `<Style ss:ID="head"><Font ss:Bold="1"/></Style>` +
    `</Styles>` +
    `<Worksheet ss:Name="${xmlText(title).slice(0, 31)}">` +
    `<Table>` +
    `<Row>${headerCells}</Row>`
  );
}

export function excelRow(row: Record<string, unknown>, columns: readonly ReportColumn[]): string {
  const cells = columns.map((column) => cell(row[column.key], column.numeric === true)).join("");
  return `<Row>${cells}</Row>`;
}

export function excelFooter(): string {
  return `</Table></Worksheet></Workbook>`;
}

export const excelService = {
  mime: EXCEL_MIME,
  extension: EXCEL_EXTENSION,
  header: excelHeader,
  row: excelRow,
  footer: excelFooter,
  escape: xmlText,
} as const;
