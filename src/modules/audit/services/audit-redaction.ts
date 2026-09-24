/**
 * What an audit snapshot is allowed to contain.
 *
 * M01 found customer profile PINs stored verbatim in `audit_logs` — 243 rows —
 * because the previous guard was a three-name deny-list applied to top-level
 * keys only. `pin` was not on it, and anything nested was never looked at. This
 * module replaces it with two layers, both applied centrally by the audit
 * service so no call site can forget them:
 *
 *   1. ALLOW-LIST (top level, per entity). Only keys explicitly approved for an
 *      entity are written. Anything else is dropped, and its NAME — never its
 *      value — is listed under `_omitted`, so a new column shows up in review as
 *      "not audited" instead of silently leaking or silently vanishing.
 *
 *   2. SENSITIVE-KEY REDACTION (every depth). Walks the whole value, objects
 *      and arrays alike, and replaces the value of any key that names a secret
 *      with `[redacted]`. It runs on allow-listed keys too, and it is the reason
 *      the allow-list alone is not trusted: an approved key can still carry a
 *      nested object with a token inside.
 *
 * Kept free of `server-only` and of I/O, so it can be tested as a pure function.
 */

import type { AuditLogInsert } from "../validation/audit-log.schema";

export type AuditEntity = AuditLogInsert["entity"];

export const REDACTION_MARKER = "[redacted]";

/** The key under which the names of dropped, non-approved keys are listed. */
export const OMITTED_KEY = "_omitted";

/** Nesting beyond this is cut off. Audit snapshots are shallow; deep ones are a bug. */
const MAX_DEPTH = 8;

/* ------------------------------------------------------------------------- */
/* Layer 2 — sensitive keys                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Splits a key into lower-case words, whatever its convention.
 *
 * `passwordEncrypted`, `password_encrypted`, `access-token`, `security.pinCode`
 * all become word lists. Matching on WORDS rather than substrings is what keeps
 * this from misfiring: a substring rule for "otp" would redact `footprint`.
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** A key containing any of these words names a secret, wherever it appears. */
const SENSITIVE_WORDS = new Set([
  "pin",
  "pins",
  "password",
  "passwords",
  "passwd",
  "passcode",
  "secret",
  "secrets",
  "token",
  "tokens",
  "cookie",
  "cookies",
  "otp",
  "jwt",
  "credential",
  "credentials",
  "authorization",
  "apikey",
  "ciphertext",
]);

/** Adjacent word pairs that name a secret even though neither word alone does. */
const SENSITIVE_PAIRS: readonly (readonly [string, string])[] = [
  ["api", "key"],
  ["private", "key"],
  ["secret", "key"],
  ["service", "role"],
  ["verification", "code"],
  ["auth", "code"],
  ["one", "time"],
];

/**
 * Whole keys that are secrets in their own right.
 *
 * `session` alone is a session object — tokens and all — so it is refused. But
 * `sessionId` is not: it identifies which session an administrator revoked and
 * cannot authenticate anybody, so it stays readable (see the overrides below).
 * `code` alone is refused because a bare "code" in an auth context is a
 * verification code; nothing in the audit trail uses it for anything else.
 */
const SENSITIVE_WHOLE_KEYS = new Set(["session", "sessions", "code", "hash", "salt", "key"]);

/**
 * Keys that LOOK sensitive by the rules above but are not, stated one by one.
 *
 * Every entry is configuration or an identifier, never a credential. Settings
 * history is the reason this list exists: an administrator lowering the minimum
 * password length is exactly the change a security review wants to see, and a
 * word-based rule would otherwise hide it as `[redacted]`.
 *
 * Adding to this list is a security decision. It is kept short and explicit so
 * that anyone doing it has to read why the others are here.
 */
export const SAFE_KEY_OVERRIDES: ReadonlySet<string> = new Set([
  /*
   * Settings history — a configuration value, displayed on the Settings page.
   * Keyed by the field name as it actually occurs, nested inside its category:
   * settings.service audits `{ security: { passwordMinLength: 12 } }`.
   */
  "passwordMinLength",
  /* Identifiers: name the session an administrator revoked; authenticate nobody. */
  "sessionId",
  "session_id",
]);

/** True when the value stored under this key must never be written. */
export function isSensitiveKey(key: string): boolean {
  if (SAFE_KEY_OVERRIDES.has(key)) {
    return false;
  }

  const words = keyWords(key);
  const joined = words.join("");

  if (SENSITIVE_WHOLE_KEYS.has(joined)) {
    return true;
  }

  if (words.some((word) => SENSITIVE_WORDS.has(word))) {
    return true;
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const pair: readonly [string, string] = [words[index] ?? "", words[index + 1] ?? ""];

    if (SENSITIVE_PAIRS.some(([first, second]) => first === pair[0] && second === pair[1])) {
      return true;
    }
  }

  return false;
}

/**
 * Walks a value and replaces every sensitive key's value, at any depth.
 *
 * Arrays are walked element by element, so `[{ pin: "1234" }]` is caught.
 * Dates become ISO strings because that is how jsonb would have stored them
 * anyway, and it keeps the output a plain JSON tree. Anything that is not plain
 * data — functions, symbols, class instances with behaviour — is dropped rather
 * than serialised into something unpredictable. Cycles are cut.
 */
export function redactDeep(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value !== "object") {
    /* functions and symbols carry no audit meaning */
    return undefined;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "[binary]";
  }

  if (Array.isArray(value)) {
    return value.map((element) => {
      const walked = redactDeep(element, depth + 1, seen);
      return walked === undefined ? null : walked;
    });
  }

  const safe: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      safe[key] = REDACTION_MARKER;
      continue;
    }

    const walked = redactDeep(entry, depth + 1, seen);

    if (walked !== undefined) {
      safe[key] = walked;
    }
  }

  return safe;
}

/* ------------------------------------------------------------------------- */
/* Layer 1 — per-entity allow-list                                            */
/* ------------------------------------------------------------------------- */

/**
 * Fields an audit event may carry regardless of entity.
 *
 * These are the "what happened" vocabulary the services already use when they
 * record an action rather than a row: `{ event: "password_changed" }` and the
 * like. None of them holds a secret; the values are enum-like strings, ids,
 * counts and dates.
 */
const EVENT_FIELDS = [
  "event",
  "changedFields",
  "confirmedByOperator",
  "importedInBulk",
  "customerId",
  "profileNumbers",
  "durationDays",
  "expirationDate",
  "reason",
  "replacedWith",
  "orphans",
  "nulledReferences",
  "profileSlots",
  "invitationState",
  "sessionId",
  "count",
] as const;

/**
 * Top-level fields each entity may record, in addition to EVENT_FIELDS.
 *
 * Derived from the table columns, minus the ones that must never be copied into
 * a second place. Deliberately absent:
 *
 *   accounts.passwordEncrypted   ciphertext; storing it here spreads the secret
 *   profiles.pin                 the customer's PIN — the M01 finding
 *
 * A column added to a table does not appear in its audit trail until it is
 * added here. That is the intended failure mode: a gap in history is visible
 * (see OMITTED_KEY) and recoverable; a leaked credential is neither.
 */
const ENTITY_FIELDS: Record<AuditEntity, readonly string[]> = {
  account: [
    "id",
    "email",
    "status",
    "profileSlots",
    "validFrom",
    "validUntil",
    "country",
    "notes",
    "createdBy",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "deletedAt",
  ],
  profile: [
    "id",
    "accountId",
    "profileNumber",
    "profileName",
    "status",
    "customerId",
    "workerId",
    "saleDate",
    "expirationDate",
    "durationDays",
    "notes",
    "createdAt",
    "updatedAt",
  ],
  customer: [
    "id",
    "name",
    "phoneOriginal",
    "phoneNormalized",
    "whatsappUrl",
    "notes",
    "firstPurchaseAt",
    "lastPurchaseAt",
    "createdAt",
    "updatedAt",
    "blockedAt",
    "deletedAt",
  ],
  /*
   * Issues: the problem timeline reads status, assignedTo, severity and
   * reopenCount out of these snapshots (problem-timeline.service.ts), so those
   * four are load-bearing, not merely informative.
   */
  issue: [
    "id",
    "accountId",
    "issueType",
    "status",
    "severity",
    "description",
    "assignedTo",
    "reportedBy",
    "resolvedBy",
    "resolutionNote",
    "reopenCount",
    "createdAt",
    "updatedAt",
    "resolvedAt",
    "closedAt",
  ],
  backup: [
    "id",
    "name",
    "type",
    "status",
    "filename",
    "sizeBytes",
    "checksum",
    "isRestorePoint",
    "formatVersion",
    "appVersion",
    "databaseVersion",
    "tableCounts",
    "createdBy",
    "errorMessage",
    "createdAt",
    "completedAt",
    "verifiedAt",
  ],
  user: [
    "id",
    "name",
    "email",
    "role",
    "status",
    "lastLoginAt",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ],
  /*
   * Settings snapshots are `{ [category]: categoryObject }` — settings.service
   * writes `before: { [key]: before[key] }` where key is one of the five
   * configuration categories. Layer 2 then walks each category object, which is
   * what stops a secret nested inside one from getting through.
   *
   * Kept in step with configurationSchema by a test rather than an import: the
   * settings module imports this one, so importing back would be a cycle.
   */
  settings: ["general", "company", "security", "notifications", "backup"],
};

function isAllowedKey(entity: AuditEntity, key: string): boolean {
  if ((EVENT_FIELDS as readonly string[]).includes(key)) {
    return true;
  }

  return ENTITY_FIELDS[entity].includes(key);
}

/**
 * The only function the audit service calls: allow-list, then deep redaction.
 *
 * Returns null for an absent snapshot so the column stays null rather than `{}`.
 */
export function sanitizeAuditSnapshot(
  entity: AuditEntity,
  snapshot: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }

  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];

  for (const [key, value] of Object.entries(snapshot)) {
    if (key === OMITTED_KEY) {
      continue;
    }

    if (isAllowedKey(entity, key)) {
      kept[key] = value;
    } else {
      omitted.push(key);
    }
  }

  const safe = redactDeep(kept) as Record<string, unknown>;

  if (omitted.length > 0) {
    /*
     * Names only. A key name that is itself sensitive-looking is still just a
     * name — `pin` appearing here tells a reviewer the PIN was deliberately not
     * recorded, which is the point.
     */
    safe[OMITTED_KEY] = omitted.toSorted();
  }

  return safe;
}
