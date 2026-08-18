import { describe, expect, it } from "vitest";

import { profileEditSchema } from "@/modules/accounts";

/**
 * The profile editor's input allowlist, pinned at RUNTIME.
 *
 * Not at compile time. TypeScript would happily accept an object carrying
 * `accountId` because structural typing permits extra properties — that is
 * exactly how `BulkCreateResult.created` compiled as `AccountView` while still
 * holding the ciphertext at runtime. A type is a claim; this file is evidence.
 *
 * The browser reaches this schema through a Server Action, which is a POST
 * endpoint anyone holding a session can call directly with any JSON they like.
 * So the question is not "what does the form send" but "what survives the
 * schema", and the answer must be: seven fields and nothing else.
 */

/** Everything the editor is permitted to change. */
const ALLOWED = [
  "profileName",
  "pin",
  "notes",
  "customerPhone",
  "saleDate",
  "expirationDate",
  "durationDays",
] as const;

/** Columns a crafted payload must never be able to reach. */
const FORBIDDEN: Record<string, unknown> = {
  id: "99999999-9999-4999-8999-999999999999",
  accountId: "88888888-8888-4888-8888-888888888888",
  profileNumber: 5,
  status: "available",
  customerId: "77777777-7777-4777-8777-777777777777",
  workerId: "66666666-6666-4666-8666-666666666666",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
  deletedAt: new Date("2020-01-01"),
  password: "some-netflix-password",
  passwordEncrypted: "v1:aaa:bbb:ccc",
  profileSlots: 5,
  validUntil: "2099-01-01",
  healthScore: 0,
};

describe("the allowlist survives a crafted payload", () => {
  it("keeps every permitted field", () => {
    const parsed = profileEditSchema.safeParse({
      profileName: "Living room",
      pin: "1234",
      notes: "a note",
      customerPhone: "0663947116",
      saleDate: "2026-08-01",
      expirationDate: "2026-09-01",
      durationDays: 31,
    });

    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;

    expect(Object.keys(parsed.data).sort()).toEqual([...ALLOWED].sort());
  });

  it("strips every forbidden field from the parsed output", () => {
    /*
     * The whole point. A caller POSTs the union of legitimate and hostile
     * fields; only the legitimate ones may come out the other side.
     */
    const parsed = profileEditSchema.safeParse({ profileName: "Legit", ...FORBIDDEN });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    for (const field of Object.keys(FORBIDDEN)) {
      expect(parsed.data, `${field} survived the schema`).not.toHaveProperty(field);
    }

    expect(Object.keys(parsed.data)).toEqual(["profileName"]);
  });

  it("cannot be used to set a profile status", () => {
    /*
     * ADR-013 D2: expiry is derived from the date. A writable status here would
     * recreate the second source of truth M13 removed.
     */
    for (const status of ["available", "sold", "expired", "reserved", "expiring_soon"]) {
      const parsed = profileEditSchema.safeParse({ status });

      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).not.toHaveProperty("status");
    }
  });

  it("cannot be used to move a profile to another account", () => {
    const parsed = profileEditSchema.safeParse({
      accountId: "88888888-8888-4888-8888-888888888888",
      profileNumber: 1,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("accountId");
      expect(parsed.data).not.toHaveProperty("profileNumber");
    }
  });

  it("cannot carry an account credential in any spelling", () => {
    const parsed = profileEditSchema.safeParse({
      password: "netflix-password",
      passwordEncrypted: "v1:aaa:bbb:ccc",
      accountPassword: "netflix-password",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const serialised = JSON.stringify(parsed.data);
    expect(serialised).not.toContain("netflix-password");
    expect(serialised).not.toContain("v1:");
  });

  it("cannot set a customer by id, only by phone", () => {
    /*
     * 01_MASTER_RULES.md makes the normalized phone the identity key. Accepting
     * an id would let a caller attach a profile to a customer the Phone Engine
     * would have matched to a different, existing record.
     */
    const parsed = profileEditSchema.safeParse({
      customerId: "77777777-7777-4777-8777-777777777777",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty("customerId");
  });
});

describe("field-level validation still bites", () => {
  it("rejects a PIN that is not four digits", () => {
    for (const pin of ["1", "12345", "abcd", "12 34", ""]) {
      expect(profileEditSchema.safeParse({ pin }).success, `pin=${pin}`).toBe(false);
    }
  });

  it("rejects an impossible or malformed date", () => {
    for (const date of ["2026-02-30", "2026-13-01", "31/12/2026", "not-a-date"]) {
      expect(profileEditSchema.safeParse({ expirationDate: date }).success, date).toBe(false);
      expect(profileEditSchema.safeParse({ saleDate: date }).success, date).toBe(false);
    }
  });

  it("rejects a duration outside the permitted range", () => {
    for (const durationDays of [0, -1, 731, 1.5]) {
      expect(
        profileEditSchema.safeParse({ durationDays }).success,
        `durationDays=${durationDays}`,
      ).toBe(false);
    }
  });

  it("rejects an empty customer phone rather than treating it as a release", () => {
    /* Releasing is Quick Replace's job; a blank box must not do it silently. */
    expect(profileEditSchema.safeParse({ customerPhone: "" }).success).toBe(false);
    expect(profileEditSchema.safeParse({ customerPhone: "   " }).success).toBe(false);
  });

  it("accepts an empty object, because every field is optional", () => {
    /* A no-op edit is legal; the service decides nothing changed. */
    expect(profileEditSchema.safeParse({}).success).toBe(true);
  });
});
