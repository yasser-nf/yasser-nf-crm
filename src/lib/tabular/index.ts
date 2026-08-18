/**
 * Delimited text parser.
 *
 * One parser for pasted text, CSV and TSV, because they are the same format
 * with a different separator and pretending otherwise produces three parsers
 * that disagree about quoting. The M13 Phase B approval requires exactly this:
 * a reusable parser, so a future file upload reuses the identical validation
 * pipeline rather than growing a second one.
 *
 * Pure and synchronous. It takes a string and returns rows; it does not read
 * files, does not touch the network, and knows nothing about accounts. The
 * caller supplies the column names and validates the result — that separation
 * is what makes it reusable for the next importer.
 *
 * RFC 4180 quoting is supported, because a Netflix password may legitimately
 * contain a comma:
 *
 *   user@example.com,"pa,ss""word",DZ,90,3
 *
 * A doubled quote inside a quoted field is one literal quote.
 */

/** One parsed line, with the source line number kept for error reporting. */
export interface TabularRow {
  /** 1-based line number in the ORIGINAL input, blank lines included. */
  readonly line: number;
  readonly cells: readonly string[];
}

export interface ParseOptions {
  /** Defaults to auto-detection. */
  readonly delimiter?: "," | "\t" | ";" | "auto";
  /**
   * Column names. When given, a first row matching these is treated as a header
   * and dropped, so a spreadsheet paste works whether or not it kept its header.
   */
  readonly headers?: readonly string[];
}

export interface ParseResult {
  readonly rows: readonly TabularRow[];
  /** The delimiter actually used, so a caller can report what it assumed. */
  readonly delimiter: string;
  /** True when the first line was recognised as a header and dropped. */
  readonly headerDropped: boolean;
}

const CANDIDATE_DELIMITERS = [",", "\t", ";"] as const;

/**
 * Picks the delimiter by counting candidates outside quotes.
 *
 * Counting inside quotes would let one address containing a comma outvote the
 * tabs that actually separate the columns.
 */
function detectDelimiter(input: string): string {
  const firstLine = input.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";

  let best = ",";
  let bestCount = 0;

  for (const candidate of CANDIDATE_DELIMITERS) {
    let count = 0;
    let inQuotes = false;

    for (let index = 0; index < firstLine.length; index += 1) {
      const char = firstLine[index];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === candidate && !inQuotes) {
        count += 1;
      }
    }

    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Splits one line into cells, honouring quotes.
 *
 * Written as an explicit scan rather than a regex. A regex that handles escaped
 * quotes correctly is unreadable, and this one has to be auditable — it decides
 * where a password ends.
 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          /* A doubled quote is one literal quote, not the end of the field. */
          current += '"';
          index += 2;
          continue;
        }

        inQuotes = false;
        index += 1;
        continue;
      }

      current += char;
      index += 1;
      continue;
    }

    if (char === '"' && current.trim() === "") {
      /* A quote only opens a field at its start; mid-field it is literal. */
      inQuotes = true;
      current = "";
      index += 1;
      continue;
    }

    if (char === delimiter) {
      cells.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  cells.push(current.trim());

  return cells;
}

/** True when a row looks like the header rather than data. */
function looksLikeHeader(cells: readonly string[], headers: readonly string[]): boolean {
  if (cells.length === 0) {
    return false;
  }

  const normalized = cells.map((cell) => cell.toLowerCase().replace(/[\s_-]/g, ""));
  const expected = headers.map((header) => header.toLowerCase().replace(/[\s_-]/g, ""));

  /*
   * Matching the FIRST cell only. A paste may carry more or fewer columns than
   * expected, and demanding a full match would make a header row silently
   * import as an account called "email".
   */
  return normalized[0] !== undefined && expected.includes(normalized[0]);
}

/**
 * Parses delimited text into rows.
 *
 * Blank lines are skipped but still consume a line number, so the number in an
 * error message matches what the operator sees in their editor. That mapping is
 * the entire point of tracking lines rather than array indices.
 */
export function parseDelimited(input: string, options: ParseOptions = {}): ParseResult {
  const delimiter =
    options.delimiter === undefined || options.delimiter === "auto"
      ? detectDelimiter(input)
      : options.delimiter;

  /* Strips a UTF-8 BOM, which a spreadsheet export puts before the first header. */
  const cleaned = input.replace(/^﻿/, "");

  const lines = cleaned.split(/\r?\n/);
  const rows: TabularRow[] = [];
  let headerDropped = false;

  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === "") {
      continue;
    }

    const cells = splitLine(raw, delimiter);

    if (
      rows.length === 0 &&
      !headerDropped &&
      options.headers !== undefined &&
      looksLikeHeader(cells, options.headers)
    ) {
      headerDropped = true;
      continue;
    }

    rows.push({ line: index + 1, cells });
  }

  return { rows, delimiter, headerDropped };
}

/**
 * Maps a row's cells onto named fields.
 *
 * Missing trailing cells become undefined rather than empty string, so an
 * omitted optional column is genuinely absent and a schema default applies.
 * An empty cell that WAS typed also becomes undefined — a spreadsheet cannot
 * express the difference, and treating `a,,c` as an empty country would fail
 * validation for a field the operator meant to leave blank.
 */
export function toRecord(
  row: TabularRow,
  headers: readonly string[],
): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};

  for (const [index, header] of headers.entries()) {
    const cell = row.cells[index];
    record[header] = cell === undefined || cell === "" ? undefined : cell;
  }

  return record;
}
