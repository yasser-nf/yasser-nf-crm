import { describe, expect, it } from "vitest";

import { accountInsertSchema } from "@/modules/accounts";

/**
 * Account creation input.
 *
 * These exist because "Create account" never worked once, in any environment,
 * and the failure was invisible: the schema rejected a field the form does not
 * collect, and the resulting field error had no input to attach to, so the user
 * only ever saw "Could not create account".
 *
 * The first test is the regression. It sends exactly what the create form sends.
 */

/** Precisely the payload `account-form.tsx` submits on create. */
function formPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: "stock01@example.com",
    password: "netflix-password",
    country: "DZ",
    notes: "",
    ...overrides,
  };
}

describe("accountInsertSchema", () => {
  it("accepts what the create form actually sends", () => {
    const parsed = accountInsertSchema.safeParse(formPayload());

    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
  });

  it("defaults healthScore rather than demanding it", () => {
    /*
     * The column is `integer().notNull().default(100)`. drizzle-zod would have
     * generated it optional, but supplying a refinement to createInsertSchema
     * replaces the generated schema *including its optionality* — which is what
     * made it required and broke creation.
     */
    const parsed = accountInsertSchema.safeParse(formPayload());

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.healthScore).toBe(100);
  });

  it("still accepts an explicit healthScore", () => {
    const parsed = accountInsertSchema.safeParse(formPayload({ healthScore: 40 }));

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.healthScore).toBe(40);
  });

  it("still enforces the documented 0–100 range", () => {
    /* 01_MASTER_RULES.md, and a check constraint on the table. */
    expect(accountInsertSchema.safeParse(formPayload({ healthScore: 101 })).success).toBe(false);
    expect(accountInsertSchema.safeParse(formPayload({ healthScore: -1 })).success).toBe(false);
    expect(accountInsertSchema.safeParse(formPayload({ healthScore: 1.5 })).success).toBe(false);
  });

  it("requires an email and a password", () => {
    expect(accountInsertSchema.safeParse(formPayload({ email: "" })).success).toBe(false);
    expect(accountInsertSchema.safeParse(formPayload({ password: "" })).success).toBe(false);
    expect(accountInsertSchema.safeParse(formPayload({ email: "not-an-email" })).success).toBe(
      false,
    );
  });

  it("never accepts ciphertext as input", () => {
    /*
     * The caller supplies plaintext; the repository encrypts. Accepting
     * `passwordEncrypted` would let an unencrypted value be written into a
     * column whose name promises otherwise.
     */
    const parsed = accountInsertSchema.safeParse(
      formPayload({ passwordEncrypted: "pretend-ciphertext" }),
    );

    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("passwordEncrypted");
    }
  });

  it("normalises email casing and country code", () => {
    const parsed = accountInsertSchema.safeParse(
      formPayload({ email: "  Stock01@Example.COM ", country: "dz" }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("stock01@example.com");
      expect(parsed.data.country).toBe("DZ");
    }
  });
});
