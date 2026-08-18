import { parseDelimited, toRecord } from "@/lib/tabular";
import type { AccountInsert } from "../validation/account.schema";
import { accountInsertSchema } from "../validation/account.schema";

/**
 * Bulk account import — parsing and validation.
 *
 * Deliberately free of `server-only`, a database and an audit context. This
 * half is pure: text in, a verdict per row out. The writing half lives in
 * accountsService.createAccountsInBulk, which calls this first and refuses to
 * write anything if a single row failed.
 *
 * Splitting it that way is what makes "no silent partial creation" testable
 * without a database, and it is why the same pipeline will serve a file upload
 * later — an uploaded CSV becomes a string and enters here unchanged.
 *
 * Every row goes through `accountInsertSchema`, the SAME schema a single
 * creation uses. A second, laxer schema for imports would be a way to get rows
 * into the table that the normal form would have rejected.
 */

/** The column order an operator pastes, and the header row we recognise. */
export const BULK_COLUMNS = [
  "email",
  "password",
  "country",
  "durationDays",
  "profileSlots",
] as const;

/** Shown above the textarea, and used by the header-detection in the parser. */
export const BULK_TEMPLATE = "email,password,country,duration,profiles";

/**
 * Header aliases.
 *
 * An operator's spreadsheet says "duration" and "profiles"; the schema calls
 * them durationDays and profileSlots. Accepting both means a paste from either
 * source works without asking anyone to rename a column.
 */
const HEADER_ALIASES: readonly string[] = [
  ...BULK_COLUMNS,
  "duration",
  "profiles",
  "e-mail",
  "mail",
];

export interface BulkRowError {
  /** 1-based line number in the text the operator pasted. */
  readonly line: number;
  /** The email if it parsed, so an operator can find the row. Never the password. */
  readonly email: string | null;
  /** Field name to message. Empty when the row failed for a non-field reason. */
  readonly fieldErrors: Record<string, string>;
  readonly message: string;
}

export interface BulkParseResult {
  /** Rows that passed validation, ready to insert. */
  readonly valid: readonly AccountInsert[];
  /** Rows that did not, each with its line number and reasons. */
  readonly errors: readonly BulkRowError[];
  /** What the parser assumed, so the UI can say "read as tab-separated". */
  readonly delimiter: string;
  readonly headerDropped: boolean;
  /**
   * The line an accepted email came from.
   *
   * Needed because a row can still be rejected AFTER parsing — the database
   * refuses an email that already exists — and that rejection must be reported
   * against the line the operator typed, not an array index they never saw.
   */
  lineForEmail(email: string): number | undefined;
}

/**
 * One row as the operator is shown it BEFORE anything is written.
 *
 * Deliberately carries no password — not even a masked one. The operator pasted
 * the text and can still see it in the textarea; echoing it back into a second
 * rendered surface would put credentials into the RSC payload of a preview that
 * may never be submitted, for no information they do not already have.
 *
 * `hasPassword` is the only thing said about it, because "row 4 has no
 * password" is genuinely useful and reveals nothing.
 */
export interface BulkPreviewRow {
  readonly line: number;
  readonly email: string | null;
  readonly country: string | null;
  readonly durationDays: number | null;
  readonly profileSlots: number | null;
  readonly hasPassword: boolean;
  readonly valid: boolean;
  /** Field name to message, for an invalid row. Never contains a value. */
  readonly fieldErrors: Record<string, string>;
  readonly message: string | null;
}

export interface BulkPreview {
  readonly rows: readonly BulkPreviewRow[];
  /** What the parser detected, so the UI can say "read as tab-separated". */
  readonly delimiter: string;
  readonly headerDropped: boolean;
  readonly validCount: number;
  readonly invalidCount: number;
  readonly submitted: number;
}

/**
 * Parses pasted text for display, writing nothing.
 *
 * A projection over `parseBulkAccounts` — the SAME parser and the SAME schema
 * the submit path uses. It deliberately re-runs rather than caching, so the
 * preview an operator approves and the batch the server validates cannot come
 * from two different code paths.
 *
 * Exists because the parser is server-only in practice: it lives behind a module
 * barrel that re-exports `server-only` code, and duplicating it into the browser
 * to render a preview is exactly what M13 forbids.
 */
export function previewBulkAccounts(input: string): BulkPreview {
  const parsed = parseBulkAccounts(input);

  /* Valid rows carry no line number of their own, so recover it by email. */
  const rows: BulkPreviewRow[] = [
    ...parsed.valid.map((account) => ({
      line: parsed.lineForEmail(account.email) ?? 0,
      email: account.email,
      country: account.country ?? null,
      durationDays: account.durationDays ?? null,
      profileSlots: account.profileSlots,
      hasPassword: account.password.length > 0,
      valid: true,
      fieldErrors: {},
      message: null,
    })),
    ...parsed.errors.map((error) => ({
      line: error.line,
      email: error.email,
      country: null,
      durationDays: null,
      profileSlots: null,
      /* Unknown for a row that failed to parse; never guessed. */
      hasPassword: false,
      valid: false,
      fieldErrors: error.fieldErrors,
      message: error.message,
    })),
  ].sort((left, right) => left.line - right.line);

  return {
    rows,
    delimiter: parsed.delimiter,
    headerDropped: parsed.headerDropped,
    validCount: parsed.valid.length,
    invalidCount: parsed.errors.length,
    submitted: parsed.valid.length + parsed.errors.length,
  };
}

/** Turns a numeric cell into a number, or undefined when absent. */
function toNumber(value: string | undefined): number | string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  /*
   * A non-numeric cell is passed through as the original string so the schema
   * reports "expected number" against the real input. Converting it to NaN here
   * would produce a confusing message about a value the operator never typed.
   */
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Parses and validates pasted text without writing anything.
 *
 * Duplicate emails WITHIN the batch are caught here, before the database sees
 * them. The unique index would catch them too, but only by failing the whole
 * transaction with one opaque error — this reports both offending line numbers.
 *
 * Duplicates against emails ALREADY in the table are not checked here, because
 * that requires a query. The unique index remains the real guarantee, and the
 * service turns its failure into a message.
 */
export function parseBulkAccounts(input: string): BulkParseResult {
  const parsed = parseDelimited(input, { headers: HEADER_ALIASES });

  const valid: AccountInsert[] = [];
  const errors: BulkRowError[] = [];

  /** email → the first line that claimed it. */
  const seen = new Map<string, number>();

  for (const row of parsed.rows) {
    const record = toRecord(row, BULK_COLUMNS);

    const candidate = {
      email: record["email"],
      password: record["password"],
      country: record["country"],
      durationDays: toNumber(record["durationDays"]),
      profileSlots: toNumber(record["profileSlots"]),
    };

    const result = accountInsertSchema.safeParse(candidate);

    if (!result.success) {
      const fieldErrors: Record<string, string> = {};

      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string" && !(field in fieldErrors)) {
          fieldErrors[field] = issue.message;
        }
      }

      errors.push({
        line: row.line,
        /* Only echoed back when it is a string; never the password, ever. */
        email: typeof candidate.email === "string" ? candidate.email : null,
        fieldErrors,
        message: "This row could not be read",
      });

      continue;
    }

    const email = result.data.email;
    const firstSeenAt = seen.get(email);

    if (firstSeenAt !== undefined) {
      errors.push({
        line: row.line,
        email,
        fieldErrors: { email: `Already used on line ${firstSeenAt}` },
        message: "Duplicate email within this import",
      });

      continue;
    }

    seen.set(email, row.line);
    valid.push(result.data);
  }

  return {
    valid,
    errors,
    delimiter: parsed.delimiter,
    headerDropped: parsed.headerDropped,
    lineForEmail: (email) => seen.get(email.trim().toLowerCase()),
  };
}
