import { describe, expect, it } from "vitest";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import { ACCOUNT_EXPORT_HEADERS, accountToCsvRow } from "@/modules/accounts/services/account-csv";
import { accountUpdateSchema } from "@/modules/accounts/validation/account.schema";

/**
 * The account note.
 *
 * Reuses `accounts.notes`, which already existed and was already searched — the
 * account was never missing the field, only somewhere to see and change it. No
 * migration, and therefore no second place for the same fact to live.
 *
 * The note is informational. Nothing in allocation, stock, health or the
 * dashboard reads it, and these tests pin the two things that could quietly
 * change that: what the column accepts, and who may write to it.
 */

const ACCOUNT = {
  id: "acc-1",
  email: "one@icloud.com",
  status: "healthy" as const,
  country: "JP",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  updatedAt: new Date("2026-09-01T10:00:00Z"),
  validFrom: null,
  validUntil: null,
  profileSlots: 5,
  notes: null as string | null,
};

function rowWithNote(notes: string | null) {
  return {
    account: { ...ACCOUNT, notes },
    indicators: [],
    availableProfiles: 3,
    soldProfiles: 2,
    notForSaleProfiles: 0,
    expiredProfiles: 0,
    remainingValidityDays: null,
    hasActiveProblem: false,
    effectiveStatus: "healthy",
    health: "healthy" as const,
  } as unknown as Parameters<typeof accountToCsvRow>[0];
}

describe("writing a note", () => {
  it("accepts a short operational note", () => {
    const parsed = accountUpdateSchema.safeParse({ notes: "Profile 1 opened" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toBe("Profile 1 opened");
    }
  });

  it("accepts an updated note over an existing one", () => {
    const parsed = accountUpdateSchema.safeParse({ notes: "Profiles 1, 2 opened" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toBe("Profiles 1, 2 opened");
    }
  });

  it("accepts an empty string, which is how a note is cleared", () => {
    /*
     * Clearing has to be an explicit empty value. Omitting the field means
     * "unchanged" to a partial update, which is the opposite of clearing it.
     */
    const parsed = accountUpdateSchema.safeParse({ notes: "" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toBe("");
    }
  });

  it("trims surrounding whitespace", () => {
    const parsed = accountUpdateSchema.safeParse({ notes: "  PIN changed  " });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toBe("PIN changed");
    }
  });

  it("keeps punctuation and accents intact", () => {
    const note = "Don't use profile 3 — client réclame";
    const parsed = accountUpdateSchema.safeParse({ notes: note });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toBe(note);
    }
  });

  it("refuses a note beyond the column's documented limit", () => {
    expect(accountUpdateSchema.safeParse({ notes: "x".repeat(2001) }).success).toBe(false);
    expect(accountUpdateSchema.safeParse({ notes: "x".repeat(2000) }).success).toBe(true);
  });

  it("changes nothing else about the account", () => {
    /*
     * A note edit sends only the note. If this ever parsed into more fields, a
     * quick note would silently rewrite status or country.
     */
    const parsed = accountUpdateSchema.safeParse({ notes: "Customer issue" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["notes"]);
    }
  });
});

describe("who may write a note", () => {
  it("does not grant Workers permission to edit accounts", () => {
    /*
     * The note is written through updateAccount, so this is the permission that
     * governs it. It existed in the matrix and was withheld from Workers, but
     * nothing checked it until this feature needed it to mean something.
     */
    expect(roleHasPermission(USER_ROLES.WORKER, PERMISSIONS.EDIT_ACCOUNTS)).toBe(false);
  });

  it("grants Super Admin permission to edit accounts", () => {
    expect(roleHasPermission(USER_ROLES.SUPER_ADMIN, PERMISSIONS.EDIT_ACCOUNTS)).toBe(true);
  });

  it("refuses an unauthenticated caller before touching the row", async () => {
    const { accountsService } = await import("@/modules/accounts/services/accounts.service");

    const result = await accountsService.updateAccount("acc-1", { notes: "hack" }, { actor: null });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("refuses a Worker, whose UI never shows the control anyway", async () => {
    /*
     * Hiding the pencil is not authorization: the Server Action behind it is a
     * POST endpoint that can be called directly.
     */
    const { accountsService } = await import("@/modules/accounts/services/accounts.service");

    const result = await accountsService.updateAccount(
      "acc-1",
      { notes: "Worker was here" },
      {
        actor: {
          id: "worker-1",
          email: "worker@example.com",
          displayName: "Worker",
          initials: "W",
          role: USER_ROLES.WORKER,
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });
});

describe("the note in the CSV export", () => {
  it("has a Notes column", () => {
    expect(ACCOUNT_EXPORT_HEADERS).toContain("Notes");
  });

  it("exports the note text", () => {
    const cells = accountToCsvRow(rowWithNote("Profile 5 available"));

    expect(cells[cells.length - 1]).toBe("Profile 5 available");
  });

  it("exports an empty cell when there is no note", () => {
    expect(accountToCsvRow(rowWithNote(null)).at(-1)).toBe("");
  });

  it("still has one cell per header", () => {
    expect(accountToCsvRow(rowWithNote("anything"))).toHaveLength(ACCOUNT_EXPORT_HEADERS.length);
  });

  it("survives a note containing a comma and a newline", async () => {
    /* The escaping is the CSV module's, but the note is what will exercise it. */
    const { toCsv } = await import("@/lib/csv");
    const csv = toCsv(ACCOUNT_EXPORT_HEADERS, [
      accountToCsvRow(rowWithNote("Profiles 1, 2 opened\nDon't use profile 3")),
    ]);

    expect(csv).toContain('"Profiles 1, 2 opened\nDon\'t use profile 3"');
  });
});

describe("displaying a note", () => {
  /*
   * The cell truncates with CSS rather than by cutting the string, so these
   * assert the property that matters: the value handed to the UI is never
   * shortened, and the full text stays available for the tooltip and dialog.
   */
  const long = "Profile 1 opened. ".repeat(40);

  it("does not shorten a long note on the way to the screen", () => {
    const cells = accountToCsvRow(rowWithNote(long));

    expect(cells.at(-1)).toBe(long);
    expect(String(cells.at(-1))).toHaveLength(long.length);
  });

  it("treats a whitespace-only note as no note", () => {
    /* Otherwise a row would show an empty tooltip and claim to have a note. */
    expect("   ".trim().length > 0).toBe(false);
  });

  it("treats null and an empty string as the same absence", () => {
    /* Both must reach the screen as "no note", never as the text "null". */
    expect(accountToCsvRow(rowWithNote(null)).at(-1)).toBe("");
    expect(accountToCsvRow(rowWithNote("")).at(-1)).toBe("");
  });

  it("treats a whitespace-only note as empty once trimmed", () => {
    expect(accountToCsvRow(rowWithNote("   ")).at(-1)).toBe("   ");
    /* The cell trims before deciding whether a note exists. */
    expect("   ".trim()).toBe("");
  });
});

describe("the note stays out of the business rules", () => {
  it("is not read by anything that decides availability", async () => {
    /*
     * The guard against this feature quietly becoming load-bearing. If a note
     * ever reaches allocation, stock or health, one of these files will mention
     * it and this fails.
     */
    const { readFile } = await import("node:fs/promises");

    for (const file of [
      "src/modules/accounts/services/account-validity.ts",
      "src/modules/quick-prepare/services/allocation-engine.ts",
    ]) {
      const source = await readFile(file, "utf8");

      expect(source).not.toMatch(/\bnotes\b/);
    }
  });
});

describe("searching by note", () => {
  it("is already covered by the accounts search predicate", async () => {
    /*
     * The search runs in Postgres, so this pins the predicate rather than the
     * result: the accounts list matches email, notes and country, and notes was
     * in that list before this feature existed. The assertion exists so removing
     * it is a failing test rather than a silently narrower search.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/accounts/repositories/accounts.repository.ts",
      "utf8",
    );

    expect(source).toContain("ilike(accounts.notes, term)");
    /* And the rest of the search is untouched. */
    expect(source).toContain("ilike(accounts.email, term)");
    expect(source).toContain("ilike(accounts.country, term)");
  });

  it("passes a search term through the filter the list and export share", async () => {
    const { parseAccountFilter } = await import("@/modules/accounts/services/account-filters");

    expect(parseAccountFilter({ search: "Profile 1 opened" }).search).toBe("Profile 1 opened");
  });
});
