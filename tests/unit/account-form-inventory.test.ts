import { describe, expect, it } from "vitest";

import {
  MAX_PROFILE_SLOTS,
  MIN_PROFILE_SLOTS,
  accountInsertSchema,
  resolveValidity,
} from "@/modules/accounts";

/**
 * The New Account form's contract with the server.
 *
 * The form does no date arithmetic and no slot validation of its own — it
 * collects a mode and some fields, and the service decides. These tests pin the
 * payloads the form actually emits for each of its three validity modes, so a
 * change to the form that starts sending something the schema rejects fails
 * here rather than in a browser.
 *
 * The form's own client-side bounds (1..5) are asserted against the schema
 * constants rather than restated, so the two cannot drift apart.
 */

/** Exactly what `account-form.tsx` builds for a create submission. */
function formPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: "stock@example.com",
    password: "netflix-password",
    country: "DZ",
    profileSlots: 5,
    ...overrides,
  };
}

describe("the form's slot bounds match the schema's", () => {
  it("uses the same 1..5 range the server enforces", () => {
    /* The <select> renders [1,2,3,4,5]. If these constants move, it must too. */
    expect(MIN_PROFILE_SLOTS).toBe(1);
    expect(MAX_PROFILE_SLOTS).toBe(5);
  });

  it("accepts every slot count the select offers", () => {
    for (const profileSlots of [1, 2, 3, 4, 5]) {
      const parsed = accountInsertSchema.safeParse(formPayload({ profileSlots }));

      expect(parsed.success, `slots=${profileSlots}`).toBe(true);
      if (parsed.success) expect(parsed.data.profileSlots).toBe(profileSlots);
    }
  });

  it("rejects counts outside it", () => {
    for (const profileSlots of [0, 6, -1, 2.5]) {
      expect(accountInsertSchema.safeParse(formPayload({ profileSlots })).success).toBe(false);
    }
  });

  it("defaults to five when the field is absent", () => {
    /* Edit mode never sends it, and neither did any caller before M13. */
    const withoutSlots = formPayload();
    delete (withoutSlots as Record<string, unknown>)["profileSlots"];

    const parsed = accountInsertSchema.safeParse(withoutSlots);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.profileSlots).toBe(5);
  });
});

describe("validity mode: open-ended", () => {
  it("sends neither a duration nor a boundary", () => {
    /* The form omits both fields entirely, which is how the model spells it. */
    const parsed = accountInsertSchema.safeParse(formPayload());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.validUntil).toBeUndefined();
      expect(parsed.data.durationDays).toBeUndefined();
    }
  });

  it("resolves to two nulls rather than a date", () => {
    expect(resolveValidity({}, new Date("2026-08-13T00:00:00Z"))).toEqual({
      validFrom: null,
      validUntil: null,
    });
  });
});

describe("validity mode: duration", () => {
  it("accepts a duration and lets the server compute the boundary", () => {
    const parsed = accountInsertSchema.safeParse(formPayload({ durationDays: 90 }));

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.durationDays).toBe(90);
      /* The form never sends this — resolveValidity derives it. */
      expect(parsed.data.validUntil).toBeUndefined();
    }
  });

  it("rejects a duration the account model cannot express", () => {
    for (const durationDays of [0, -30, 731]) {
      expect(
        accountInsertSchema.safeParse(formPayload({ durationDays })).success,
        `durationDays=${durationDays}`,
      ).toBe(false);
    }
  });

  it("rejects a non-numeric duration with a message naming the field", () => {
    /* The form forwards an unparseable value as typed, so the error is honest. */
    const parsed = accountInsertSchema.safeParse(formPayload({ durationDays: "ninety" }));

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "durationDays")).toBe(true);
    }
  });

  it("counts from valid_from when the form supplies one", () => {
    expect(
      resolveValidity(
        { validFrom: "2026-09-01", durationDays: 30 },
        new Date("2026-08-13T00:00:00Z"),
      ),
    ).toEqual({ validFrom: "2026-09-01", validUntil: "2026-10-01" });
  });
});

describe("validity mode: explicit date", () => {
  it("accepts a calendar boundary", () => {
    const parsed = accountInsertSchema.safeParse(formPayload({ validUntil: "2026-12-31" }));

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.validUntil).toBe("2026-12-31");
  });

  it("rejects a boundary before the start", () => {
    /* Mirrors the accounts_validity_order check constraint. */
    const parsed = accountInsertSchema.safeParse(
      formPayload({ validFrom: "2026-12-01", validUntil: "2026-01-01" }),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "validUntil")).toBe(true);
    }
  });

  it("rejects a date that is not a real calendar day", () => {
    for (const validUntil of ["2026-02-30", "not-a-date", "2026-13-01", "31/12/2026"]) {
      expect(accountInsertSchema.safeParse(formPayload({ validUntil })).success, validUntil).toBe(
        false,
      );
    }
  });

  it("lets an explicit boundary win over a duration", () => {
    /* The form never sends both, but the rule is the server's, not the form's. */
    expect(
      resolveValidity(
        { validUntil: "2026-12-25", durationDays: 5 },
        new Date("2026-08-13T00:00:00Z"),
      ).validUntil,
    ).toBe("2026-12-25");
  });
});

describe("the credential path is unchanged", () => {
  it("still requires a plaintext password and never accepts ciphertext", () => {
    expect(accountInsertSchema.safeParse(formPayload({ password: "" })).success).toBe(false);

    const parsed = accountInsertSchema.safeParse(
      formPayload({ passwordEncrypted: "v1:pretend:cipher:text" }),
    );

    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("passwordEncrypted");
    }
  });
});
