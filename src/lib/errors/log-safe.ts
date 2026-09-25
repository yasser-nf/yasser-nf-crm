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
 * Removes bound values from an error message.
 *
 *   - Drizzle's `params: …` tail, whatever follows it, to the end of the text.
 *   - PostgreSQL's "invalid input syntax for type X: "value"" and its siblings,
 *     which quote the offending value back — a mistyped PIN would be echoed.
 */
export function scrubErrorText(text: string): string {
  const withoutParams = text.replace(/(\n|^)\s*params:[\s\S]*$/, `$1params: ${PARAMS_REDACTED}`);

  const withoutEchoedValues = withoutParams.replace(
    /(invalid input (?:syntax|value) for [^:\n]*:\s*)"[^"\n]*"/gi,
    `$1"${PARAMS_REDACTED}"`,
  );

  return withoutEchoedValues.length > MAX_MESSAGE_LENGTH
    ? `${withoutEchoedValues.slice(0, MAX_MESSAGE_LENGTH)}…`
    : withoutEchoedValues;
}

function readString(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * A log-safe description of a cause and the causes behind it.
 *
 * Reads only named, inspected fields — `name`, `message`, `code` — and never
 * spreads or stringifies an unknown object, so a field nobody looked at
 * (`params`, `parameters`, `query` with inlined values) cannot ride along.
 */
export function describeCause(cause: unknown, depth = 0): string {
  if (cause === null || cause === undefined) {
    return "";
  }

  if (typeof cause === "string") {
    return scrubErrorText(cause);
  }

  if (typeof cause !== "object") {
    return String(cause);
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
    message !== undefined ? `: ${scrubErrorText(message)}` : ": (no message)",
  ]
    .filter(Boolean)
    .join("");

  const inner = (cause as { cause?: unknown }).cause;
  const next = inner === undefined || inner === cause ? "" : describeCause(inner, depth + 1);

  return next ? `${self} ← ${next}` : self;
}
