import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLE_NAMES,
  NULLABLE_USER_REFERENCES,
  REQUIRED_USER_REFERENCES,
  canonicalJson,
  checkCompatibility,
  validateAgainstSchema,
  validateBackupStructure,
  type BackupManifest,
} from "@/modules/backups/services/backup-format";
import { contentSha256 } from "@/modules/backups/services/checksum.service";
import { planRetention } from "@/modules/backups/services/retention";
import { isScheduledBackupDue, latestSlot, nextSlot } from "@/modules/backups/services/schedule";

/**
 * M07 backups, without a database: the v2 format's canonical serialisation
 * and content hash, the validators that run before any write, compatibility,
 * the slot scheduler at its UTC boundaries, retention's floor, safe failure
 * reasons and the scheduler endpoint's authentication.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000001";
const U = "cccccccc-0000-4000-8000-000000000001";
const P = "dddddddd-0000-4000-8000-000000000001";

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-09-26T00:00:00.000Z",
    createdBy: null,
    appVersion: "0.1.0",
    databaseVersion: "PostgreSQL 17",
    type: "manual",
    tables: ["users", "accounts", "profiles"],
    rowCounts: { users: 1, accounts: 1, profiles: 1 },
    contentSha256: "0".repeat(64),
    ...overrides,
  };
}

function data() {
  return {
    users: [{ id: U, email: "a@x", role: "super_admin" }],
    accounts: [{ id: A, email: "acc@x", created_by: U }],
    profiles: [{ id: P, account_id: A, worker_id: null, customer_id: null }],
  };
}

afterEach(() => vi.restoreAllMocks());

/* ---------------------------------------------------- canonical + content hash */

describe("deterministic serialisation", () => {
  it("does not depend on key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it("keeps array order, and writes absent values as null", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson(null)).toBe("null");
  });

  it("gives equal data an equal content hash, whatever the key order", () => {
    const reordered = {
      users: [{ role: "super_admin", email: "a@x", id: U }],
      accounts: [{ created_by: U, email: "acc@x", id: A }],
      profiles: [{ customer_id: null, worker_id: null, account_id: A, id: P }],
    };

    expect(contentSha256(["users", "accounts", "profiles"], data())).toBe(
      contentSha256(["users", "accounts", "profiles"], reordered),
    );
  });

  it("changes the hash when any value changes", () => {
    const edited = { ...data(), accounts: [{ id: A, email: "other@x", created_by: U }] };

    expect(contentSha256(["users", "accounts", "profiles"], edited)).not.toBe(
      contentSha256(["users", "accounts", "profiles"], data()),
    );
  });

  it("binds rows to their table: moving a row changes the hash", () => {
    expect(contentSha256(["users", "accounts"], { users: [], accounts: [{ id: A }] })).not.toBe(
      contentSha256(["users", "accounts"], { users: [{ id: A }], accounts: [] }),
    );
  });
});

/* ------------------------------------------------------------ validation */

describe("structure is proven before any write", () => {
  it("accepts a consistent backup", () => {
    expect(validateBackupStructure(manifest(), data())).toEqual([]);
  });

  it.each([
    [
      "a table the manifest lists but the data lacks",
      manifest(),
      { users: data().users, accounts: data().accounts },
      /no data/,
    ],
    [
      "a row count that does not match",
      manifest({ rowCounts: { users: 2, accounts: 1, profiles: 1 } }),
      data(),
      /declares 2 rows/,
    ],
    [
      "a row without a valid id",
      manifest(),
      { ...data(), accounts: [{ id: "not-a-uuid", created_by: U }] },
      /invalid id/,
    ],
    [
      "a duplicate id",
      manifest({ rowCounts: { users: 1, accounts: 2, profiles: 1 } }),
      {
        ...data(),
        accounts: [
          { id: A, created_by: U },
          { id: A, created_by: U },
        ],
      },
      /duplicate id/,
    ],
    [
      "a child pointing at a parent the backup does not contain",
      manifest(),
      { ...data(), profiles: [{ id: P, account_id: B }] },
      /account_id refers to a accounts row/,
    ],
    [
      "a nullable reference to a missing row",
      manifest(),
      { ...data(), accounts: [{ id: A, created_by: B }] },
      /created_by refers to a users row/,
    ],
    [
      "a required reference left empty",
      manifest(),
      { ...data(), profiles: [{ id: P, account_id: null }] },
      /account_id is required/,
    ],
  ])("refuses %s", (_label, m, d, problem) => {
    const problems = validateBackupStructure(m, d);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(problem);
  });

  it("checks against the current schema: required columns and enum values", () => {
    const columns = new Map([
      [
        "users",
        [
          { name: "id", required: false, enumLabels: null },
          { name: "email", required: true, enumLabels: null },
          { name: "role", required: false, enumLabels: ["super_admin", "worker"] },
        ],
      ],
    ]);

    expect(
      validateAgainstSchema({ users: [{ id: U, email: "a@x", role: "worker" }] }, columns),
    ).toEqual({ problems: [], warnings: [] });
    expect(
      validateAgainstSchema({ users: [{ id: U, role: "worker" }] }, columns).problems.join(),
    ).toMatch(/required column email/);
    expect(
      validateAgainstSchema(
        { users: [{ id: U, email: "a@x", role: "owner" }] },
        columns,
      ).problems.join(),
    ).toMatch(/role holds a value/);
    expect(
      validateAgainstSchema(
        { users: [{ id: U, email: "a@x", legacy: 1 }] },
        columns,
      ).warnings.join(),
    ).toMatch(/legacy no longer exist/);
  });

  it("splits user references into nullable (cleared) and required (row skipped)", () => {
    expect(REQUIRED_USER_REFERENCES).toEqual([
      { table: "notifications", column: "recipient_id" },
      { table: "report_presets", column: "user_id" },
    ]);
    expect(NULLABLE_USER_REFERENCES).toContainEqual({ table: "issues", column: "assigned_to" });
    expect(NULLABLE_USER_REFERENCES).toContainEqual({ table: "audit_logs", column: "user_id" });
  });

  it("captures every business table M01–M06 created", () => {
    for (const table of ["issues", "issue_notes", "notifications", "report_presets"]) {
      expect(BACKUP_TABLE_NAMES).toContain(table);
    }
  });
});

describe("compatibility", () => {
  it("refuses a version 2 manifest without a content hash", () => {
    expect(checkCompatibility(manifest({ contentSha256: undefined })).compatible).toBe(false);
  });

  it("refuses a backup from a newer schema, warns on an older one", () => {
    expect(checkCompatibility(manifest({ schemaVersion: 16 }), 15).compatible).toBe(false);

    const older = checkCompatibility(manifest({ schemaVersion: 12 }), 15);
    expect(older.compatible && older.warnings.join()).toMatch(/older schema/);
  });

  it("accepts a version 1 backup, with a warning that its content cannot be proven", () => {
    const v1 = checkCompatibility(manifest({ formatVersion: 1, contentSha256: undefined }));

    expect(v1.compatible && v1.warnings.join()).toMatch(/no content hash/);
  });
});

/* ------------------------------------------------------------ scheduling */

describe("the schedule is slot-based and UTC", () => {
  const at = (iso: string) => new Date(iso);

  it("is off when off", () => {
    expect(latestSlot("off", 2, at("2026-09-26T12:00:00Z"))).toBeNull();
    expect(isScheduledBackupDue("off", 2, null, at("2026-09-26T12:00:00Z"))).toBe(false);
  });

  it("daily: the slot turns at the configured UTC hour, not before", () => {
    expect(latestSlot("daily", 2, at("2026-09-26T01:59:59Z"))?.toISOString()).toBe(
      "2026-09-25T02:00:00.000Z",
    );
    expect(latestSlot("daily", 2, at("2026-09-26T02:00:00Z"))?.toISOString()).toBe(
      "2026-09-26T02:00:00.000Z",
    );
  });

  it("daily at midnight: 23:59:59 belongs to the previous day's slot", () => {
    expect(latestSlot("daily", 0, at("2026-09-25T23:59:59Z"))?.toISOString()).toBe(
      "2026-09-25T00:00:00.000Z",
    );
    expect(latestSlot("daily", 0, at("2026-09-26T00:00:00Z"))?.toISOString()).toBe(
      "2026-09-26T00:00:00.000Z",
    );
  });

  it("is idempotent within a slot, due again in the next", () => {
    const taken = at("2026-09-26T02:05:00Z");

    expect(isScheduledBackupDue("daily", 2, null, at("2026-09-26T02:01:00Z"))).toBe(true);
    expect(isScheduledBackupDue("daily", 2, taken, at("2026-09-26T09:00:00Z"))).toBe(false);
    expect(isScheduledBackupDue("daily", 2, taken, at("2026-09-27T01:59:59Z"))).toBe(false);
    expect(isScheduledBackupDue("daily", 2, taken, at("2026-09-27T02:00:00Z"))).toBe(true);
  });

  it("hourly: one per clock hour", () => {
    expect(
      isScheduledBackupDue("hourly", 0, at("2026-09-26T10:00:01Z"), at("2026-09-26T10:59:59Z")),
    ).toBe(false);
    expect(
      isScheduledBackupDue("hourly", 0, at("2026-09-26T10:00:01Z"), at("2026-09-26T11:00:00Z")),
    ).toBe(true);
  });

  it("weekly: Mondays at the hour, across a month boundary", () => {
    /* 2026-09-28 is a Monday; 2026-10-01 is a Thursday. */
    expect(latestSlot("weekly", 3, at("2026-10-01T12:00:00Z"))?.toISOString()).toBe(
      "2026-09-28T03:00:00.000Z",
    );
    expect(latestSlot("weekly", 3, at("2026-09-28T02:59:59Z"))?.toISOString()).toBe(
      "2026-09-21T03:00:00.000Z",
    );
  });

  it("monthly: the 1st at the hour, across a year boundary", () => {
    expect(latestSlot("monthly", 4, at("2027-01-01T03:59:59Z"))?.toISOString()).toBe(
      "2026-12-01T04:00:00.000Z",
    );
    expect(latestSlot("monthly", 4, at("2027-01-01T04:00:00Z"))?.toISOString()).toBe(
      "2027-01-01T04:00:00.000Z",
    );
    expect(nextSlot("monthly", 4, at("2026-12-15T00:00:00Z"))?.toISOString()).toBe(
      "2027-01-01T04:00:00.000Z",
    );
  });

  it("does not follow the process time zone", () => {
    /* A non-UTC offset in the input is the same instant, and the same slot. */
    expect(latestSlot("daily", 0, at("2026-09-26T00:30:00+01:00"))?.toISOString()).toBe(
      "2026-09-25T00:00:00.000Z",
    );
  });
});

/* --------------------------------------------------------------- retention */

describe("retention never deletes the last good backup", () => {
  const backup = (
    id: string,
    day: number,
    extra: Partial<{ type: string; isRestorePoint: boolean }> = {},
  ) => ({
    id,
    createdAt: new Date(Date.UTC(2026, 8, day)),
    type: extra.type ?? "manual",
    isRestorePoint: extra.isRestorePoint ?? false,
  });

  it("keepLast 0 (or garbage) still keeps the newest", () => {
    const candidates = [backup("old", 1), backup("new", 2)];

    expect(planRetention(candidates, 0).keep).toEqual(["new"]);
    expect(planRetention(candidates, Number.NaN).prune).toEqual([]);
  });

  it("a single successful backup is never pruned", () => {
    expect(planRetention([backup("only", 1)], 1)).toEqual({ keep: ["only"], prune: [] });
  });

  it("restore points and snapshots are never pruned and never counted", () => {
    const plan = planRetention(
      [
        backup("restored-from", 1, { isRestorePoint: true }),
        backup("snap", 2, { type: "snapshot" }),
        backup("a", 3),
        backup("b", 4),
      ],
      1,
    );

    expect(plan.prune).toEqual(["a"]);
    expect(plan.keep).toEqual(expect.arrayContaining(["restored-from", "snap", "b"]));
  });
});

/* ------------------------------------------------------ safe failure reasons */

describe("a failed backup's stored reason never carries bound values", () => {
  it("scrubs a failed query through the M06 path", async () => {
    vi.doMock("server-only", () => ({}));
    const { safeFailureReason } = await import("@/modules/backups/services/backup.service");
    const { DatabaseError } = await import("@/lib/errors");

    const cause = new DrizzleQueryError(
      'update "profiles" set "pin" = $1',
      ["4821"],
      Object.assign(new Error('value "4821" is out of range'), { code: "22003" }),
    );
    const reason = safeFailureReason(
      new DatabaseError("Database operation failed: backups.writeArtifact", { cause }),
    );

    expect(reason).toMatch(/^DATABASE_ERROR: /);
    expect(reason).not.toContain("4821");
  });
});

/* --------------------------------------------------- the scheduler endpoint */

describe("the scheduler endpoint authenticates its caller", () => {
  const SECRET = "s".repeat(40);
  const tick = vi.fn();

  async function route(secret: string | undefined) {
    vi.resetModules();
    vi.doMock("@/config/env.server", () => ({
      serverEnv: { CRON_SECRET: secret },
      isBackupStorageConfigured: () => true,
    }));
    vi.doMock("@/modules/backups", () => ({ backupScheduler: { tick } }));
    return import("@/app/api/cron/backups/route");
  }

  function call(authorization?: string) {
    return new Request("http://localhost/api/cron/backups", {
      headers: authorization ? { authorization } : {},
    });
  }

  it("refuses everything when no secret is configured (503), running nothing", async () => {
    const { GET } = await route(undefined);
    const response = await GET(call(`Bearer ${SECRET}`));

    expect(response.status).toBe(503);
    expect(tick).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", `Bearer ${SECRET}x`, SECRET])(
    "refuses a wrong or missing bearer (%s) with 401",
    async (header) => {
      const { GET } = await route(SECRET);
      const response = await GET(call(header));

      expect(response.status).toBe(401);
      expect(tick).not.toHaveBeenCalled();
    },
  );

  it("runs one tick for the right bearer and reports only what happened", async () => {
    tick.mockResolvedValue({
      ok: true,
      value: { ran: false, reason: "not_due", interruptedMarkedFailed: 0 },
    });
    const { GET } = await route(SECRET);
    const response = await GET(call(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ran: false,
      reason: "not_due",
      interruptedMarkedFailed: 0,
    });
    expect(tick).toHaveBeenCalledOnce();
  });
});
