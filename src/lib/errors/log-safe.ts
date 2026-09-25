/**
 * Turning a thrown value into text that is safe to write to a log (M06).
 *
 * THE LEAK THIS CLOSES. When a query fails, Drizzle throws
 * `DrizzleQueryError`, whose message is built as
 *
 *   Failed query: update "profiles" set "pin" = $1 where "id" = $2
 *   params: 4821,5c0e…
 *
 * and the application logged it verbatim, twice over: `AppError.toLogObject`
 * wrote `String(cause)`, and `toAppError` copied the message into a new error's
 * own `message`. So a failed PIN update wrote the PIN to the logs, and a failed
 * audit insert wrote the entire before/after snapshot. Observed in production
 * during the M05 verification.
 *
 * What survives here is what diagnoses a failure: the error names, the SQL
 * TEXT (parameterised — it holds placeholders, not values), the SQLSTATE, and
 * the database's own message. What does not survive is every bound value.
 *
 * Pure and client-safe: no imports, no I/O.
 */

/** How far down a `cause` chain to follow. Deeper chains are a bug, not information. */
const MAX_CAUSE_DEPTH = 4;

/** Longest text kept from any one message. SQL for a bulk insert can be enormous. */
const MAX_MESSAGE_LENGTH = 600;

export const PARAMS_REDACTED = "[redacted]";

/**
 * Values shorter than this are not redacted by value: "1" or "id" would eat the
 * `$1` placeholders and ordinary words out of every message. Every credential
 * this application binds (a PIN is four digits) is at least this long.
 */
const MIN_REDACTED_VALUE_LENGTH = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes bound values from an error message, three ways — each alone would
 * miss something the others catch:
 *
 *   1. Drizzle's `params: …` tail, whatever follows it, to the end of the text.
 *   2. By VALUE: every bound value known from the error chain (`values`), as a
 *      whole token, wherever it appears. This is what makes the guarantee
 *      exact: PostgreSQL phrases echoed input many ways — "value "…" is out of
 *      range", "date/time field value out of range: "…"", "malformed array
 *      literal: "…"" — and no list of phrasings is complete.
 *   3. By CLASS: in a data-exception message (SQLSTATE class 22 — the class
 *      whose messages quote the offending input), every quoted literal. This
 *      covers a value the chain did not carry.
 *
 * Plus the "invalid input syntax/value" form wherever it occurs.
 */
export function scrubErrorText(
  text: string,
  values: readonly string[] = [],
  sqlState?: string,
): string {
  let scrubbed = text.replace(/(\n|^)\s*params:[\s\S]*$/, `$1params: ${PARAMS_REDACTED}`);

  for (const value of values) {
    if (value.length >= MIN_REDACTED_VALUE_LENGTH) {
      scrubbed = scrubbed.replace(
        new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(value)}(?![A-Za-z0-9_])`, "g"),
        PARAMS_REDACTED,
      );
    }
  }

  if (sqlState?.startsWith("22")) {
    scrubbed = scrubbed.replace(/"[^"\n]*"/g, `"${PARAMS_REDACTED}"`);
  }

  scrubbed = scrubbed.replace(
    /(invalid input (?:syntax|value) for [^:\n]*:\s*)"[^"\n]*"/gi,
    `$1"${PARAMS_REDACTED}"`,
  );

  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : scrubbed;
}

function readString(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * Every bound value carried anywhere along a cause chain, as text: Drizzle's
 * `params`, postgres.js's `parameters`. Read only to be REMOVED from messages;
 * never written anywhere.
 */
export function boundValues(cause: unknown, depth = 0): string[] {
  if (cause === null || typeof cause !== "object" || depth >= MAX_CAUSE_DEPTH) {
    return [];
  }

  const found: string[] = [];

  for (const key of ["params", "parameters"]) {
    const list = (cause as Record<string, unknown>)[key];

    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "bigint") {
          found.push(String(item));
        } else if (item instanceof Date) {
          found.push(item.toISOString());
        }
      }
    }
  }

  const inner = (cause as { cause?: unknown }).cause;

  return inner === cause ? found : [...found, ...boundValues(inner, depth + 1)];
}

/**
 * A log-safe description of a cause and the causes behind it.
 *
 * Reads only named, inspected fields — `name`, `message`, `code` — and never
 * spreads or stringifies an unknown object, so a field nobody looked at
 * (`params`, `parameters`, `query` with inlined values) cannot ride along.
 */
export function describeCause(
  cause: unknown,
  depth = 0,
  values: readonly string[] = boundValues(cause),
): string {
  if (cause === null || cause === undefined) {
    return "";
  }

  if (typeof cause === "string") {
    return scrubErrorText(cause, values);
  }

  if (typeof cause !== "object") {
    return scrubErrorText(String(cause), values);
  }

  if (depth >= MAX_CAUSE_DEPTH) {
    return "[cause chain truncated]";
  }

  const name = readString(cause, "name") ?? "Error";
  const message = readString(cause, "message");
  const code = readString(cause, "code");

  const self = [
    name,
    code ? `[${code}]` : undefined,
    message !== undefined ? `: ${scrubErrorText(message, values, code)}` : ": (no message)",
  ]
    .filter(Boolean)
    .join("");

  const inner = (cause as { cause?: unknown }).cause;
  const next =
    inner === undefined || inner === cause ? "" : describeCause(inner, depth + 1, values);

  return next ? `${self} ← ${next}` : self;
}
