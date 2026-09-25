import { ROUTES } from "@/config/constants";
import { escapeLike } from "@/utils/like";
import { REDACTION_MARKER, isSensitiveKey } from "./audit-redaction";

/**
 * The Logs page's view of an audit entry (M06). Pure and client-safe.
 *
 * An audit row stores whole before/after snapshots as jsonb. The Logs page never
 * receives them. It receives a `LogEntry`, built here on the server, which holds
 * only what a person needs to read the entry — and every value in it has been
 * through three filters, whatever the row itself contains:
 *
 *   1. SENSITIVE KEYS are hidden again on read, at every depth, by the same
 *      rule that redacts them on write (`isSensitiveKey`). Rows written before
 *      that rule existed are therefore still safe to show.
 *   2. CIPHERTEXT-SHAPED VALUES (`v1:iv:tag:data`) are hidden whatever key they
 *      sit under — a value test, for anything a key test could miss.
 *   3. FREE TEXT — notes, problem descriptions, resolution notes, reasons,
 *      backup error messages — is shown as "changed" with its length, never
 *      its content. Operators type into those fields, and a password pasted
 *      into one would otherwise be displayed to everyone who reads the log.
 *
 * Nothing stored is renamed. Historical actions and events are mapped to labels
 * here; the rows keep the words they were written with.
 */

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "restore",
  "archive",
  "login",
  "logout",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITIES = [
  "account",
  "profile",
  "customer",
  "issue",
  "user",
  "backup",
  "settings",
] as const;
export type AuditEntityName = (typeof AUDIT_ENTITIES)[number];

export const ACTION_LABELS: Record<AuditAction, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  restore: "Restored",
  archive: "Archived",
  login: "Signed in",
  logout: "Signed out",
};

export const ENTITY_LABELS: Record<AuditEntityName, string> = {
  account: "Account",
  profile: "Profile",
  customer: "Customer",
  issue: "Problem",
  user: "User",
  backup: "Backup",
  settings: "Settings",
};

/**
 * Named events the services record inside a snapshot (`after.event`).
 * An event missing here still displays, humanised from its stored name.
 */
export const EVENT_LABELS: Record<string, string> = {
  password_changed: "Account password changed",
  password_revealed: "Account password revealed",
  password_change_confirmed: "Password change confirmed in Quick Prepare",
  quick_prepare_allocation: "Quick Prepare allocation",
  quick_prepare_replacement: "Quick Replace",
  profile_slots_changed: "Profile slots changed",
  sale_unassigned: "Sale unassigned",
  session_revoked: "Session revoked",
  all_sessions_revoked: "All sessions revoked",
  invitation_resent: "Invitation resent",
  user_created: "User created",
  restored: "Backup restored",
};

/** Page size, the application's own. */
export const LOGS_PAGE_SIZE = 25;

/** Search is refused below this: one character matches most of the log. */
export const LOGS_SEARCH_MIN_LENGTH = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FRAGMENT = /^[0-9a-f]{8}(?:-[0-9a-f-]{0,28})?$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CIPHERTEXT = /^v\d+:[^:\s]+:[^:\s]+:[^:\s]+$/;

/** Fields whose content is operator-typed text: shown as changed, never shown. */
const FREE_TEXT_FIELDS = new Set([
  "notes",
  "description",
  "resolutionNote",
  "reason",
  "errorMessage",
]);

/** Snapshot keys that are bookkeeping, not a change anybody made. */
const BOOKKEEPING_FIELDS = new Set(["id", "createdAt", "updatedAt", "_omitted", "event"]);

/** Event metadata shown as details rather than as a before → after change. */
const DETAIL_FIELDS = new Set([
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
  "invitationState",
  "sessionId",
  "count",
]);

/** Values that name a CRM user; shown as the person's name when it is known. */
export const USER_ID_FIELDS = new Set([
  "assignedTo",
  "reportedBy",
  "resolvedBy",
  "createdBy",
  "workerId",
]);

const MAX_VALUE_LENGTH = 120;
const MAX_CHANGES = 30;

/* ------------------------------------------------------------------ filters */

export interface LogsFilterInput {
  readonly userId: string | undefined;
  readonly entity: AuditEntityName | undefined;
  readonly action: AuditAction | undefined;
  /** YYYY-MM-DD, a UTC day, inclusive. */
  readonly from: string | undefined;
  /** YYYY-MM-DD, a UTC day, inclusive. */
  readonly to: string | undefined;
  readonly search: string | undefined;
  readonly offset: number;
}

type RawParams = Readonly<Record<string, string | string[] | undefined>>;

function read(params: RawParams, key: string): string | undefined {
  const value = params[key];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single.trim() === "" ? undefined : single.trim();
}

/** Query strings are user input: every value is checked against a known shape. */
export function parseLogsFilter(params: RawParams): LogsFilterInput {
  const offsetRaw = Number.parseInt(read(params, "offset") ?? "0", 10);
  const userId = read(params, "actor");
  const from = read(params, "from");
  const to = read(params, "to");

  return {
    userId: userId && UUID.test(userId) ? userId : undefined,
    entity: AUDIT_ENTITIES.find((entity) => entity === read(params, "entity")),
    action: AUDIT_ACTIONS.find((action) => action === read(params, "action")),
    from: from && utcDayStart(from) ? from : undefined,
    to: to && utcDayStart(to) ? to : undefined,
    search: read(params, "search")?.slice(0, 100),
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
  };
}

export function hasActiveFilters(filter: LogsFilterInput): boolean {
  return Boolean(
    filter.userId || filter.entity || filter.action || filter.from || filter.to || filter.search,
  );
}

/**
 * The instant a UTC day begins, or null for anything that is not a real date.
 *
 * Built with Date.UTC, never `new Date("YYYY-MM-DD")` in local terms, so which
 * entries belong to a day does not depend on the server's or anybody's clock.
 */
export function utcDayStart(day: string): Date | null {
  const match = DATE.exec(day);

  if (!match) {
    return null;
  }

  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = new Date(Date.UTC(year, month - 1, date));

  /* Rejects 2026-02-30, which Date.UTC would silently roll into March. */
  return instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === date
    ? instant
    : null;
}

/**
 * A from/to pair of UTC days as a half-open instant range: [from 00:00Z,
 * the day after `to` 00:00Z). Both days are included in full, and an entry at
 * 23:59:59.999Z on `to` is in while one at 00:00:00Z the next day is out.
 */
export function utcDayRange(
  from: string | undefined,
  to: string | undefined,
): { readonly start: Date | undefined; readonly end: Date | undefined } {
  const start = from ? (utcDayStart(from) ?? undefined) : undefined;
  const toStart = to ? utcDayStart(to) : null;

  return {
    start,
    end: toStart ? new Date(toStart.getTime() + 24 * 60 * 60 * 1000) : undefined,
  };
}

/* ------------------------------------------------------------------- search */

export interface LogsSearchTerms {
  /** `%text%`, wildcards escaped. */
  readonly contains: string;
  /** `fragment%` when the text looks like the start of an id. */
  readonly idPrefix: string | null;
  readonly actions: readonly AuditAction[];
  readonly entities: readonly AuditEntityName[];
  readonly events: readonly string[];
}

function labelMatches(needle: string, key: string, label: string): boolean {
  return label.toLowerCase().includes(needle) || key.replace(/_/g, " ").includes(needle);
}

/** Null when the text is too short to be a search. */
export function buildLogsSearch(text: string | undefined): LogsSearchTerms | null {
  const trimmed = text?.trim().replace(/\s+/g, " ") ?? "";

  if (trimmed.length < LOGS_SEARCH_MIN_LENGTH) {
    return null;
  }

  const needle = trimmed.toLowerCase();

  return {
    contains: `%${escapeLike(trimmed)}%`,
    idPrefix: ID_FRAGMENT.test(trimmed) ? `${needle}%` : null,
    actions: AUDIT_ACTIONS.filter((action) => labelMatches(needle, action, ACTION_LABELS[action])),
    entities: AUDIT_ENTITIES.filter((entity) =>
      labelMatches(needle, entity, ENTITY_LABELS[entity]),
    ),
    events: Object.entries(EVENT_LABELS)
      .filter(([event, label]) => labelMatches(needle, event, label))
      .map(([event]) => event),
  };
}

/* ---------------------------------------------------------------------- DTO */

/** The columns the Logs page reads from a row. Snapshots stay on the server. */
export interface AuditLogViewRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly entity: string;
  readonly entityId: string;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly userId: string | null;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
  readonly actorCurrentEmail: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface LogChange {
  readonly field: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface LogDetail {
  readonly label: string;
  readonly value: string;
}

export interface LogEntry {
  readonly id: string;
  /** ISO, for machines. */
  readonly createdAt: string;
  /** "2026-09-25 14:42:31 UTC": the same for every viewer, wherever they are. */
  readonly createdAtDisplay: string;
  readonly actor: {
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly action: string;
  readonly actionLabel: string;
  readonly entity: string;
  readonly entityLabel: string;
  readonly entityId: string;
  /** The entity's page, from a closed map — never a stored URL. */
  readonly href: string | null;
  readonly event: string | null;
  readonly eventLabel: string | null;
  /** What the entry is about in words: an account's email, a user's name. */
  readonly subject: string | null;
  readonly summary: string;
  readonly changes: readonly LogChange[];
  readonly details: readonly LogDetail[];
  readonly source: { readonly ipAddress: string | null; readonly userAgent: string | null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clip(text: string): string {
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

/**
 * One value, as text a person may read — or "Hidden".
 *
 * `key` is the field it sits under; sensitive and free-text keys never show
 * their content. Objects are not dumped: arrays of plain values are listed,
 * anything deeper is summarised.
 */
export function displayValue(
  key: string,
  value: unknown,
  userNames: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (isSensitiveKey(key) || value === REDACTION_MARKER) {
    return "Hidden";
  }

  if (FREE_TEXT_FIELDS.has(key)) {
    const length = typeof value === "string" ? value.length : String(value).length;
    return `Text hidden (${length} characters)`;
  }

  if (typeof value === "string") {
    if (CIPHERTEXT.test(value)) {
      return "Hidden";
    }

    if (USER_ID_FIELDS.has(key) && userNames.has(value)) {
      return userNames.get(value) ?? value;
    }

    return clip(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const plain = value.filter(
      (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );

    if (plain.length !== value.length) {
      return `${value.length} items`;
    }

    return clip(
      plain
        .map((item) => (typeof item === "string" && CIPHERTEXT.test(item) ? "Hidden" : item))
        .join(", "),
    );
  }

  return "Structured value";
}

/**
 * Flattens one level of nesting — settings snapshots are `{ security: {…} }` —
 * into dotted keys, so a settings change reads "Security · password min length".
 * Sensitive keys at either level are kept (to be shown as Hidden), never skipped
 * silently.
 */
function flatten(snapshot: Record<string, unknown> | null): Map<string, unknown> {
  const flat = new Map<string, unknown>();

  for (const [key, value] of Object.entries(snapshot ?? {})) {
    const nested = asRecord(value);

    if (nested && !isSensitiveKey(key)) {
      for (const [inner, innerValue] of Object.entries(nested)) {
        flat.set(`${key}.${inner}`, innerValue);
      }
    } else {
      flat.set(key, value);
    }
  }

  return flat;
}

function fieldLabel(path: string): string {
  return path.split(".").map(humanise).join(" · ");
}

function leafKey(path: string): string {
  return path.split(".").at(-1) ?? path;
}

/** The changes an entry records, as before → after pairs of display strings. */
export function describeChanges(
  action: string,
  before: unknown,
  after: unknown,
  userNames: ReadonlyMap<string, string> = new Map(),
): LogChange[] {
  const previous = flatten(asRecord(before));
  const next = flatten(asRecord(after));
  const keys = [...new Set([...previous.keys(), ...next.keys()])];
  const changes: LogChange[] = [];

  for (const path of keys) {
    const top = path.split(".")[0] ?? path;

    if (BOOKKEEPING_FIELDS.has(top) || DETAIL_FIELDS.has(top)) {
      continue;
    }

    const was = previous.get(path);
    const is = next.get(path);

    /* Creates list what was set; everything else lists what differs. */
    const differs =
      action === "create"
        ? is !== null && is !== undefined
        : JSON.stringify(was ?? null) !== JSON.stringify(is ?? null);

    if (!differs) {
      continue;
    }

    const key = leafKey(path);

    changes.push({
      field: path,
      label: fieldLabel(path),
      before: previous.has(path) ? displayValue(key, was, userNames) : null,
      after: next.has(path) ? displayValue(key, is, userNames) : null,
    });

    if (changes.length >= MAX_CHANGES) {
      break;
    }
  }

  return changes;
}

function describeDetails(
  before: unknown,
  after: unknown,
  userNames: ReadonlyMap<string, string>,
): LogDetail[] {
  const source = { ...asRecord(before), ...asRecord(after) };

  return [...DETAIL_FIELDS]
    .filter((field) => source[field] !== undefined && source[field] !== null)
    .map((field) => ({
      label: humanise(field),
      value: displayValue(field, source[field], userNames) ?? "—",
    }));
}

/** A readable name for what the entry is about, from safe identifying fields only. */
function describeSubject(entity: string, before: unknown, after: unknown): string | null {
  const snapshot = { ...asRecord(before), ...asRecord(after) };
  const pick = (key: string): string | null => {
    const value = snapshot[key];
    return typeof value === "string" && value.trim() !== "" && !CIPHERTEXT.test(value)
      ? clip(value)
      : null;
  };

  switch (entity) {
    case "account":
      return pick("email");
    case "user":
      return pick("name") ?? pick("email");
    case "customer":
      return pick("name") ?? pick("phoneOriginal");
    case "profile": {
      const number = snapshot["profileNumber"];
      return pick("profileName") ?? (typeof number === "number" ? `Profile ${number}` : null);
    }
    case "issue": {
      const type = pick("issueType");
      return type ? humanise(type) : null;
    }
    case "backup":
      return pick("name") ?? pick("filename");
    default:
      return null;
  }
}

/** The page an entry's entity lives on. A deleted thing has no page to open. */
export function entityHref(
  entity: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): string | null {
  if (action === "delete" || !UUID.test(entityId)) {
    return entity === "settings" ? ROUTES.SETTINGS : null;
  }

  switch (entity) {
    case "account":
      return `${ROUTES.ACCOUNTS}/${entityId}`;
    case "customer":
      return `${ROUTES.CUSTOMERS}/${entityId}`;
    case "issue":
      return `${ROUTES.PROBLEMS}/${entityId}`;
    case "user":
      return `${ROUTES.USERS}/${entityId}`;
    case "backup":
      return `${ROUTES.BACKUPS}/${entityId}`;
    case "settings":
      return ROUTES.SETTINGS;
    case "profile": {
      /* A profile lives on its account's page. */
      const accountId = { ...asRecord(before), ...asRecord(after) }["accountId"];
      return typeof accountId === "string" && UUID.test(accountId)
        ? `${ROUTES.ACCOUNTS}/${accountId}`
        : null;
    }
    default:
      return null;
  }
}

/** "2026-09-25 14:42:31 UTC". */
export function formatUtc(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function toLogEntry(
  row: AuditLogViewRow,
  userNames: ReadonlyMap<string, string> = new Map(),
): LogEntry {
  const after = asRecord(row.after);
  const rawEvent = after?.["event"];
  const event = typeof rawEvent === "string" && /^[a-z_]{1,64}$/.test(rawEvent) ? rawEvent : null;
  const eventLabel = event ? (EVENT_LABELS[event] ?? humanise(event)) : null;

  const actionLabel = ACTION_LABELS[row.action as AuditAction] ?? humanise(row.action);
  const entityLabel = ENTITY_LABELS[row.entity as AuditEntityName] ?? humanise(row.entity);
  const changes = describeChanges(row.action, row.before, row.after, userNames);

  const headline = eventLabel ?? `${actionLabel} ${entityLabel.toLowerCase()}`;
  const changedNames = changes.map((change) => change.label.toLowerCase());
  const summary =
    row.action === "update" && !eventLabel && changedNames.length > 0
      ? `${headline}: ${changedNames.slice(0, 4).join(", ")}${changedNames.length > 4 ? "…" : ""}`
      : headline;

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    createdAtDisplay: formatUtc(row.createdAt),
    actor: {
      id: row.userId,
      name: row.actorName,
      email: row.actorCurrentEmail ?? row.actorEmail,
    },
    action: row.action,
    actionLabel,
    entity: row.entity,
    entityLabel,
    entityId: row.entityId,
    href: entityHref(row.entity, row.entityId, row.action, row.before, row.after),
    event,
    eventLabel,
    subject: describeSubject(row.entity, row.before, row.after),
    summary,
    changes,
    details: describeDetails(row.before, row.after, userNames),
    source: {
      ipAddress: row.ipAddress ? clip(row.ipAddress) : null,
      userAgent: row.userAgent ? clip(row.userAgent) : null,
    },
  };
}

/** Every user id an entry's changes mention, so names can be read in one query. */
export function referencedUserIds(rows: readonly AuditLogViewRow[]): string[] {
  const ids = new Set<string>();

  for (const row of rows) {
    for (const snapshot of [asRecord(row.before), asRecord(row.after)]) {
      for (const field of USER_ID_FIELDS) {
        const value = snapshot?.[field];
        if (typeof value === "string" && UUID.test(value)) ids.add(value);
      }
    }
  }

  return [...ids];
}
