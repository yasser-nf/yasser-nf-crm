import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OMITTED_KEY,
  REDACTION_MARKER,
  isSensitiveKey,
  keyWords,
  redactDeep,
  sanitizeAuditSnapshot,
} from "@/modules/audit/services/audit-redaction";
import { SETTING_DEFINITIONS } from "@/modules/settings/services/settings-definitions";
import { configurationSchema } from "@/modules/settings/validation/configuration.schema";

/**
 * What may be written into audit_logs.
 *
 * M01 found 243 audit rows holding a live customer PIN. The guard was a
 * three-name deny-list, applied to top-level keys only; `pin` was not on it and
 * anything nested was never examined. These tests pin down the replacement: an
 * allow-list per entity, then redaction of sensitive keys at every depth.
 */

describe("the cases M01 asked for", () => {
  it("redacts a top-level PIN", () => {
    expect(redactDeep({ pin: "1234" })).toEqual({ pin: REDACTION_MARKER });
  });

  it("redacts a nested PIN", () => {
    expect(redactDeep({ profile: { pin: "1234", profileNumber: 3 } })).toEqual({
      profile: { pin: REDACTION_MARKER, profileNumber: 3 },
    });
  });

  it("redacts a password", () => {
    expect(redactDeep({ password: "hunter2" })).toEqual({ password: REDACTION_MARKER });
  });

  it("redacts passwordEncrypted in both spellings", () => {
    expect(redactDeep({ passwordEncrypted: "v1:a:b:c", password_encrypted: "v1:d:e:f" })).toEqual({
      passwordEncrypted: REDACTION_MARKER,
      password_encrypted: REDACTION_MARKER,
    });
  });

  it("redacts a token", () => {
    expect(redactDeep({ token: "abc" })).toEqual({ token: REDACTION_MARKER });
  });

  it("redacts a nested token", () => {
    expect(redactDeep({ profile: { customer: { token: "abc", name: "Amina" } } })).toEqual({
      profile: { customer: { token: REDACTION_MARKER, name: "Amina" } },
    });
  });

  it("keeps safe fields visible", () => {
    const snapshot = { status: "sold", profileNumber: 3, profileName: "Kids", durationDays: 30 };

    expect(redactDeep(snapshot)).toEqual(snapshot);
  });

  it("handles the exact shape from the brief", () => {
    expect(redactDeep({ profile: { pin: "1234", customer: { token: "t" } } })).toEqual({
      profile: { pin: REDACTION_MARKER, customer: { token: REDACTION_MARKER } },
    });
  });
});

describe("every sensitive name on the M01.5 list", () => {
  it.each([
    "pin",
    "password",
    "passwordEncrypted",
    "password_encrypted",
    "token",
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "token_hash",
    "session",
    "cookie",
    "cookies",
    "secret",
    "clientSecret",
    "verificationCode",
    "verification_code",
    "otp",
    "otpCode",
    "code",
    "serviceRoleKey",
    "service_role",
    "SUPABASE_SERVICE_ROLE_KEY",
    "apiKey",
    "api_key",
    "x-api-key",
    "authorization",
    "privateKey",
    "credentials",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });
});

describe("word matching does not misfire", () => {
  it("splits keys into words whatever their convention", () => {
    expect(keyWords("passwordEncrypted")).toEqual(["password", "encrypted"]);
    expect(keyWords("password_encrypted")).toEqual(["password", "encrypted"]);
    expect(keyWords("SUPABASE_SERVICE_ROLE_KEY")).toEqual(["supabase", "service", "role", "key"]);
    expect(keyWords("x-api-key")).toEqual(["x", "api", "key"]);
  });

  it.each([
    /* would be caught by a substring rule for "otp" or "pin" */
    "footprint",
    "spinner",
    "shipping",
    "opinion",
    /* ordinary audit vocabulary */
    "profileNumber",
    "customerId",
    "status",
    "expirationDate",
    "checksum",
    "keepLast",
    "reopenCount",
    "assignedTo",
  ])("does not treat %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it("keeps a session ID, which identifies but cannot authenticate", () => {
    expect(isSensitiveKey("sessionId")).toBe(false);
    expect(redactDeep({ event: "session_revoked", sessionId: "s-1" })).toEqual({
      event: "session_revoked",
      sessionId: "s-1",
    });
  });
});

describe("depth and shape", () => {
  it("walks into arrays", () => {
    expect(redactDeep({ profiles: [{ pin: "1" }, { pin: "2", profileNumber: 2 }] })).toEqual({
      profiles: [{ pin: REDACTION_MARKER }, { pin: REDACTION_MARKER, profileNumber: 2 }],
    });
  });

  it("walks several levels down", () => {
    const deep = { a: { b: { c: { d: { refresh_token: "r", ok: true } } } } };

    expect(redactDeep(deep)).toEqual({
      a: { b: { c: { d: { refresh_token: REDACTION_MARKER, ok: true } } } },
    });
  });

  it("cuts a cycle instead of looping", () => {
    const node: Record<string, unknown> = { name: "loop" };
    node["self"] = node;

    expect(redactDeep(node)).toEqual({ name: "loop", self: "[circular]" });
  });

  it("serialises dates the way jsonb would", () => {
    expect(redactDeep({ updatedAt: new Date("2026-09-01T10:00:00Z") })).toEqual({
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
  });

  it("drops functions rather than serialising them", () => {
    expect(redactDeep({ status: "ok", fn: () => 1 })).toEqual({ status: "ok" });
  });

  it("redacts a secret even when its value is an object", () => {
    /* A `session` object is dangerous whole, not field by field. */
    expect(redactDeep({ session: { access_token: "a", user: { id: "u" } } })).toEqual({
      session: REDACTION_MARKER,
    });
  });
});

describe("the per-entity allow-list", () => {
  it("drops a profile PIN and records only that it was dropped", () => {
    const safe = sanitizeAuditSnapshot("profile", {
      id: "p1",
      profileNumber: 3,
      pin: "4821",
      status: "sold",
    });

    expect(safe).toEqual({ id: "p1", profileNumber: 3, status: "sold", [OMITTED_KEY]: ["pin"] });
    expect(JSON.stringify(safe)).not.toContain("4821");
  });

  it("drops an account's ciphertext", () => {
    const safe = sanitizeAuditSnapshot("account", {
      id: "a1",
      email: "one@icloud.com",
      passwordEncrypted: "v1:iv:tag:body",
    });

    expect(JSON.stringify(safe)).not.toContain("v1:iv:tag:body");
    expect(safe?.[OMITTED_KEY]).toEqual(["passwordEncrypted"]);
  });

  it("drops an unknown column by default — the safe failure mode", () => {
    /*
     * A column added to a table does not enter its audit trail until someone
     * approves it. What leaks through is the column's NAME, so the gap shows up
     * in review instead of vanishing.
     */
    const safe = sanitizeAuditSnapshot("user", { id: "u1", brandNewColumn: "value" });

    expect(safe).toEqual({ id: "u1", [OMITTED_KEY]: ["brandNewColumn"] });
  });

  it("still redacts inside an allowed key", () => {
    /* The allow-list is not trusted alone: an approved key can carry a nested secret. */
    const safe = sanitizeAuditSnapshot("backup", {
      id: "b1",
      tableCounts: { accounts: 3, secret: "nope" },
    });

    expect(safe).toEqual({ id: "b1", tableCounts: { accounts: 3, secret: REDACTION_MARKER } });
  });

  it("allows the event vocabulary on any entity", () => {
    expect(
      sanitizeAuditSnapshot("account", { event: "password_changed", confirmedByOperator: true }),
    ).toEqual({ event: "password_changed", confirmedByOperator: true });
  });

  it("keeps what the problem timeline reads from issue snapshots", () => {
    /* problem-timeline.service.ts reads these four; dropping them breaks the timeline. */
    const snapshot = { status: "resolved", assignedTo: "u2", severity: "high", reopenCount: 1 };

    expect(sanitizeAuditSnapshot("issue", snapshot)).toEqual(snapshot);
  });

  it("returns null for an absent snapshot", () => {
    expect(sanitizeAuditSnapshot("profile", null)).toBeNull();
    expect(sanitizeAuditSnapshot("profile", undefined)).toBeNull();
  });

  it("does not let a caller forge the omitted list", () => {
    const safe = sanitizeAuditSnapshot("user", { id: "u1", [OMITTED_KEY]: ["nothing to see"] });

    expect(safe).toEqual({ id: "u1" });
  });
});

describe("settings history still says what changed", () => {
  /*
   * THE REAL SHAPE. settings.service audits `{ [category]: categoryObject }` —
   * `{ security: { passwordMinLength: 12, ... } }` — not dotted keys.
   *
   * The first version of these tests asserted `{ "security.passwordMinLength":
   * 12 }`, a shape the application never writes. They passed while the real
   * path was broken: every settings audit came out as `{ "_omitted":
   * ["security"] }`. The isolated integration suite caught it
   * (settings-module.test.ts). These now build the snapshot exactly as the
   * service does, from the real definitions and the real schema.
   */
  const categories = Object.keys(configurationSchema.shape);

  it("allows every configuration category as a top-level key", () => {
    for (const category of categories) {
      const safe = sanitizeAuditSnapshot("settings", { [category]: { anything: 1 } });

      expect(safe, category).toEqual({ [category]: { anything: 1 } });
    }
  });

  it.each(SETTING_DEFINITIONS.map((definition) => definition.key))(
    "keeps %s readable in the shape settings.service writes",
    (dotted) => {
      /*
       * Derived from the real definitions, so a setting added later is covered
       * without anyone remembering. An administrator lowering the minimum
       * password length is precisely the change a security review needs to see;
       * a naive "password" rule would have hidden it.
       */
      const [category, ...rest] = dotted.split(".");
      const field = rest.join(".");
      const snapshot = { [category!]: { [field]: 12 } };

      expect(sanitizeAuditSnapshot("settings", snapshot)).toEqual(snapshot);
    },
  );

  it("still redacts a secret that turns up inside a category", () => {
    const safe = sanitizeAuditSnapshot("settings", {
      notifications: { smtpPassword: "hunter2", from: "crm@example.com" },
    });

    expect(safe).toEqual({
      notifications: { smtpPassword: REDACTION_MARKER, from: "crm@example.com" },
    });
  });
});

describe("the audit service applies it centrally", () => {
  const record = vi.fn();

  beforeEach(() => {
    record.mockReset().mockResolvedValue({ ok: true, value: {} });
  });

  it("writes no PIN whatever a caller passes", async () => {
    vi.doMock("@/modules/audit/repositories/audit.repository", () => ({
      auditRepository: { record: (input: unknown) => record(input) },
    }));

    const { auditService } = await import("@/modules/audit/services/audit.service");

    await auditService.record(
      {
        entity: "profile",
        entityId: "p1",
        action: "update",
        before: { id: "p1", pin: "1111", nested: { pin: "2222" } },
        after: { id: "p1", pin: "3333", status: "sold" },
      },
      { actor: null },
    );

    const written = JSON.stringify(record.mock.calls[0]?.[0]);

    for (const pin of ["1111", "2222", "3333"]) {
      expect(written).not.toContain(pin);
    }

    vi.doUnmock("@/modules/audit/repositories/audit.repository");
  });
});

describe("the profile call sites no longer hand over whole rows", () => {
  it("builds profile audit payloads without the PIN column", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/accounts/services/profiles.service.ts", "utf8");

    const helper = source.slice(
      source.indexOf("function profileAuditSnapshot"),
      source.indexOf("function changedProfileFields"),
    );

    expect(helper).not.toMatch(/\bpin\b/);
    /* and neither call site passes a raw row any more */
    expect(source).not.toContain("before: previous, after: next");
    expect(source).not.toMatch(/action: "update", before, after \}/);
  });

  it("still records THAT the PIN changed, as a field name", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/accounts/services/profiles.service.ts", "utf8");

    expect(source).toContain("changedFields: changedProfileFields(previous, next)");
  });
});
