import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { fail, ok } from "@/utils/result";

/**
 * M06: safe error logging, the Logs DTO, UTC date ranges and the service's
 * promises — all without a database.
 */

const repo = { listForLogs: vi.fn(), userNames: vi.fn(), record: vi.fn(), list: vi.fn() };
vi.mock("@/modules/audit/repositories/audit.repository", () => ({ auditRepository: repo }));

const { DatabaseError, UnexpectedError, describeCause, scrubErrorText, toAppError } =
  await import("@/lib/errors");
const { logger } = await import("@/lib/logger");
const {
  buildLogsSearch,
  describeChanges,
  displayValue,
  entityHref,
  parseLogsFilter,
  toLogEntry,
  utcDayRange,
  utcDayStart,
} = await import("@/modules/audit/services/log-view");
const { logsService } = await import("@/modules/audit/services/logs.service");

const PIN = "4821";
const PROFILE = "5c0e0000-0000-4000-8000-000000000001";

function failedPinUpdate(): DrizzleQueryError {
  const driver = Object.assign(new Error('new row for relation "profiles" violates check'), {
    name: "PostgresError",
    code: "23514",
  });
  return new DrizzleQueryError(
    'update "profiles" set "pin" = $1 where "profiles"."id" = $2',
    [PIN, PROFILE],
    driver,
  );
}

afterEach(() => vi.restoreAllMocks());

/* ----------------------------------------------------- failed query logging */

describe("a failed query never writes its bound values to the logs", () => {
  it("DatabaseError.toLogObject keeps the SQL and SQLSTATE, drops the PIN", () => {
    const error = new DatabaseError("Database operation failed: profiles.update", {
      cause: failedPinUpdate(),
      context: { operation: "profiles.update", sqlState: "23514" },
    });

    const logged = JSON.stringify(error.toLogObject());

    expect(logged).not.toContain(PIN);
    expect(logged).not.toContain(PROFILE);
    expect(logged).toContain('Failed query: update \\"profiles\\" set \\"pin\\" = $1');
    expect(logged).toContain("params: [redacted]");
    expect(logged).toContain("PostgresError[23514]");
    expect(logged).toContain("profiles.update");
  });

  it("toAppError (the path for failures without a SQLSTATE) scrubs the copied message", () => {
    const wrapped = toAppError(failedPinUpdate());

    expect(wrapped).toBeInstanceOf(UnexpectedError);
    expect(wrapped.message).not.toContain(PIN);
    expect(JSON.stringify(wrapped.toLogObject())).not.toContain(PIN);
  });

  it("logger.error with a raw thrown value describes it instead of stringifying it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.error("Unhandled failure", failedPinUpdate());

    const written = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(written).not.toContain(PIN);
    expect(written).toContain("Failed query:");
  });

  it("logger.error with a DatabaseError is safe end to end", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.error(
      "Database operation failed",
      new DatabaseError("Database operation failed: audit.record", { cause: failedPinUpdate() }),
    );

    expect(String(spy.mock.calls[0]?.[0])).not.toContain(PIN);
  });

  it("scrubs values PostgreSQL echoes back in its own message", () => {
    expect(scrubErrorText('invalid input syntax for type integer: "4821"')).toBe(
      'invalid input syntax for type integer: "[redacted]"',
    );
    expect(scrubErrorText('invalid input value for enum audit_action: "x"')).not.toContain('"x"');
  });

  it("never spreads an unknown object: its fields cannot ride along", () => {
    const described = describeCause({ params: [PIN], query: "q", secret: "s3cr3t" });

    expect(described).not.toContain(PIN);
    expect(described).not.toContain("s3cr3t");
  });

  it("follows a cause chain safely, cutting cycles and depth", () => {
    const loop: { name: string; message: string; cause?: unknown } = { name: "E", message: "m" };
    loop.cause = loop;
    const deep = {
      name: "A",
      message: "a",
      cause: { name: "B", message: "b", cause: failedPinUpdate() },
    };

    expect(describeCause(loop)).toBe("E: m");
    expect(describeCause(deep)).not.toContain(PIN);
    expect(describeCause(deep)).toContain("A: a ← B: b ← Error: Failed query:");
  });
});

/* -------------------------------------------------------------- the entry DTO */

const BASE = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-09-25T14:42:31.123Z"),
  entity: "profile",
  entityId: PROFILE,
  action: "update",
  userId: "22222222-2222-4222-8222-222222222222",
  actorEmail: "old@example.com",
  actorName: "Yasser",
  actorCurrentEmail: "yasser@example.com",
  ipAddress: "10.0.0.1",
  userAgent: "Mozilla/5.0",
};

describe("a log entry never carries a secret", () => {
  const hostile = toLogEntry({
    ...BASE,
    before: {
      accountId: "33333333-3333-4333-8333-333333333333",
      pin: "7093",
      notes: "old note",
      profileName: "Kids",
    },
    after: {
      accountId: "33333333-3333-4333-8333-333333333333",
      pin: PIN,
      notes: "customer password is Hunter2",
      profileName: "Kids room",
      passwordEncrypted: "v1:aaa:bbb:ccc",
      innocent: "v1:ddd:eee:fff",
      nested: { apiToken: "tok_live_123", ok: 1 },
      list: [{ pin: "9999" }],
      _omitted: ["pin"],
    },
  });
  const serialised = JSON.stringify(hostile);

  it.each([PIN, "7093", "Hunter2", "v1:aaa:bbb:ccc", "v1:ddd:eee:fff", "tok_live_123", "9999"])(
    "does not contain %s",
    (secret) => expect(serialised).not.toContain(secret),
  );

  it("shows sensitive keys and ciphertext as Hidden, and free text by length only", () => {
    const byField = Object.fromEntries(hostile.changes.map((change) => [change.field, change]));

    expect(byField["pin"]?.after).toBe("Hidden");
    expect(byField["passwordEncrypted"]?.after).toBe("Hidden");
    expect(byField["innocent"]?.after).toBe("Hidden");
    expect(byField["notes"]?.after).toBe("Text hidden (28 characters)");
    expect(byField["profileName"]).toMatchObject({ before: "Kids", after: "Kids room" });
    expect(byField["list"]?.after).toBe("1 items");
    expect(byField["_omitted"]).toBeUndefined();
  });

  it("reads who, what, which entity and when", () => {
    expect(hostile).toMatchObject({
      createdAtDisplay: "2026-09-25 14:42:31 UTC",
      actor: { name: "Yasser", email: "yasser@example.com" },
      actionLabel: "Updated",
      entityLabel: "Profile",
      subject: "Kids room",
      href: "/accounts/33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("display mapping keeps stored words and adds labels", () => {
  it("labels a known event and humanises an unknown one, without renaming either", () => {
    const known = toLogEntry({
      ...BASE,
      entity: "account",
      before: null,
      after: { event: "password_revealed" },
    });
    const unknown = toLogEntry({
      ...BASE,
      entity: "account",
      before: null,
      after: { event: "some_new_thing" },
    });

    expect(known).toMatchObject({
      event: "password_revealed",
      eventLabel: "Account password revealed",
    });
    expect(unknown).toMatchObject({ event: "some_new_thing", eventLabel: "Some new thing" });
  });

  it("summarises an update by the fields that changed", () => {
    const entry = toLogEntry({
      ...BASE,
      entity: "issue",
      before: { status: "open", assignedTo: null },
      after: { status: "resolved", assignedTo: BASE.userId },
    });

    expect(entry.summary).toBe("Updated problem: status, assigned to");
  });

  it("names people in changes from one lookup, never per row", () => {
    const names = new Map([[BASE.userId, "Yasser"]]);
    const changes = describeChanges(
      "update",
      { assignedTo: null },
      { assignedTo: BASE.userId },
      names,
    );

    expect(changes[0]?.after).toBe("Yasser");
  });

  it("shows a settings change inside its category, a safe override included", () => {
    const changes = describeChanges(
      "update",
      { security: { passwordMinLength: 8 } },
      { security: { passwordMinLength: 12 } },
    );

    expect(changes).toEqual([
      {
        field: "security.passwordMinLength",
        label: "Security · Password min length",
        before: "8",
        after: "12",
      },
    ]);
  });

  it("links only through a closed map", () => {
    expect(entityHref("issue", PROFILE, "update", null, null)).toBe(`/problems/${PROFILE}`);
    expect(entityHref("issue", PROFILE, "delete", null, null)).toBeNull();
    expect(entityHref("account", "../../admin", "update", null, null)).toBeNull();
    expect(
      entityHref("profile", PROFILE, "update", null, { accountId: "javascript:alert(1)" }),
    ).toBeNull();
  });

  it("never dumps an object", () => {
    expect(displayValue("config", { a: 1 })).toBe("Structured value");
  });
});

/* ------------------------------------------------------------------- filters */

describe("filters are validated and dates are UTC days", () => {
  it("drops anything that is not a known value", () => {
    expect(
      parseLogsFilter({
        actor: "not-a-uuid",
        entity: "audit_logs",
        action: "drop",
        from: "2026-02-30",
        to: "yesterday",
        offset: "-5",
      }),
    ).toEqual({
      userId: undefined,
      entity: undefined,
      action: undefined,
      from: undefined,
      to: undefined,
      search: undefined,
      offset: 0,
    });
  });

  it("keeps valid values", () => {
    expect(
      parseLogsFilter({
        actor: BASE.userId,
        entity: "issue",
        action: "archive",
        from: "2026-09-01",
        offset: "25",
      }),
    ).toMatchObject({
      userId: BASE.userId,
      entity: "issue",
      action: "archive",
      from: "2026-09-01",
      offset: 25,
    });
  });

  function inRange(instant: string, from?: string, to?: string): boolean {
    const { start, end } = utcDayRange(from, to);
    const time = new Date(instant).getTime();
    return (!start || time >= start.getTime()) && (!end || time < end.getTime());
  }

  it("includes the whole of both days: 00:00:00Z in, 23:59:59.999Z in, next 00:00:00Z out", () => {
    expect(inRange("2026-09-25T00:00:00.000Z", "2026-09-25", "2026-09-25")).toBe(true);
    expect(inRange("2026-09-25T23:59:59.999Z", "2026-09-25", "2026-09-25")).toBe(true);
    expect(inRange("2026-09-26T00:00:00.000Z", "2026-09-25", "2026-09-25")).toBe(false);
    expect(inRange("2026-09-24T23:59:59.999Z", "2026-09-25", "2026-09-25")).toBe(false);
  });

  it("crosses a month end", () => {
    expect(utcDayRange(undefined, "2026-09-30").end?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(utcDayRange(undefined, "2026-12-31").end?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(inRange("2026-09-30T23:59:59Z", "2026-09-30", "2026-09-30")).toBe(true);
    expect(inRange("2026-10-01T00:00:00Z", "2026-09-30", "2026-09-30")).toBe(false);
  });

  it("does not depend on a local clock: 00:30 in Algiers is the previous UTC day", () => {
    expect(utcDayStart("2026-09-25")?.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(inRange("2026-09-25T00:30:00+01:00", "2026-09-25", "2026-09-25")).toBe(false);
    expect(inRange("2026-09-25T00:30:00+01:00", "2026-09-24", "2026-09-24")).toBe(true);
  });
});

describe("search terms", () => {
  it("refuses one character and escapes wildcards", () => {
    expect(buildLogsSearch("a")).toBeNull();
    expect(buildLogsSearch("50%_x")?.contains).toBe("%50\\%\\_x%");
  });

  it("matches actions, entities and events by their labels", () => {
    expect(buildLogsSearch("archiv")?.actions).toEqual(["archive"]);
    expect(buildLogsSearch("problem")?.entities).toEqual(["issue"]);
    expect(buildLogsSearch("quick")?.events).toEqual([
      "password_change_confirmed",
      "quick_prepare_allocation",
      "quick_prepare_replacement",
    ]);
  });

  it("recognises an id fragment from a full first group", () => {
    expect(buildLogsSearch("5c0e0000")?.idPrefix).toBe("5c0e0000%");
    expect(buildLogsSearch("5c0e")?.idPrefix).toBeNull();
  });
});

/* ------------------------------------------------------------------- service */

const ADMIN: AppUser = {
  id: BASE.userId,
  email: "a@x",
  displayName: "A",
  initials: "A",
  role: "super_admin",
};
const WORKER: AppUser = { ...ADMIN, role: "worker" };
const EMPTY = {
  userId: undefined,
  entity: undefined,
  action: undefined,
  from: undefined,
  to: undefined,
  search: undefined,
  offset: 0,
};

describe("the logs service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.listForLogs.mockResolvedValue(ok({ items: [], total: 0, limit: 25, offset: 0 }));
    repo.userNames.mockResolvedValue(ok(new Map()));
  });

  it("refuses a Worker before any query", async () => {
    const result = await logsService.list(EMPTY, WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(repo.listForLogs).not.toHaveBeenCalled();
  });

  it("refuses the signed-out", async () => {
    const result = await logsService.list(EMPTY, null);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses an inverted date range", async () => {
    const result = await logsService.list(
      { ...EMPTY, from: "2026-09-26", to: "2026-09-25" },
      ADMIN,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("passes UTC bounds and the page size to the query", async () => {
    await logsService.list({ ...EMPTY, from: "2026-09-01", to: "2026-09-30" }, ADMIN);

    expect(repo.listForLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        start: new Date("2026-09-01T00:00:00Z"),
        end: new Date("2026-10-01T00:00:00Z"),
        limit: 25,
      }),
    );
  });

  it("a failed read is a failure, never an empty page", async () => {
    repo.listForLogs.mockResolvedValue(fail(new DatabaseError("down")));

    expect((await logsService.list(EMPTY, ADMIN)).ok).toBe(false);
  });

  it("looks up every mentioned person in ONE query for the whole page", async () => {
    const row = (assignedTo: string) => ({
      ...BASE,
      entity: "issue",
      before: { assignedTo: null },
      after: { assignedTo },
    });
    repo.listForLogs.mockResolvedValue(
      ok({
        items: [
          row("aaaaaaaa-0000-4000-8000-000000000001"),
          row("aaaaaaaa-0000-4000-8000-000000000002"),
        ],
        total: 2,
        limit: 25,
        offset: 0,
      }),
    );

    await logsService.list(EMPTY, ADMIN);

    expect(repo.userNames).toHaveBeenCalledOnce();
    expect(repo.userNames.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("still shows the page when only the name lookup fails", async () => {
    repo.listForLogs.mockResolvedValue(
      ok({ items: [{ ...BASE, before: null, after: {} }], total: 1, limit: 25, offset: 0 }),
    );
    repo.userNames.mockResolvedValue(fail(new DatabaseError("down")));

    const result = await logsService.list(EMPTY, ADMIN);

    expect(result.ok && result.value.items).toHaveLength(1);
  });
});
