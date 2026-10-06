import { describe, expect, it } from "vitest";

import {
  accountSupplierSchema,
  supplierCreateSchema,
  supplierFilterSchema,
  supplierUpdateSchema,
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLIER_NOTES_LENGTH,
} from "@/modules/suppliers";
import { parseAccountFilter } from "@/modules/accounts";

/**
 * Supplier input contracts. M10 §5, §7 and §17.
 */

const UUID = "aaaaaaaa-0000-4000-8000-000000000001";

describe("creating a supplier", () => {
  it("cleans the name it accepts, so the stored form is the submitted form", () => {
    const parsed = supplierCreateSchema.safeParse({ name: "  NetStore   DZ " });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe("NetStore DZ");
  });

  it.each([
    ["empty", ""],
    ["a single space", " "],
    ["only whitespace", "  \t\n "],
    ["only a newline", "\n"],
  ])("refuses %s as a name — M10 §5", (_label, name) => {
    const parsed = supplierCreateSchema.safeParse({ name });

    expect(parsed.success).toBe(false);
    /* Reported as required rather than as a length problem on its spaces. */
    expect(parsed.error?.issues[0]?.message).toMatch(/required/i);
  });

  it("refuses a name past the bound, measured after cleaning", () => {
    expect(
      supplierCreateSchema.safeParse({ name: "x".repeat(MAX_SUPPLIER_NAME_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      supplierCreateSchema.safeParse({ name: `  ${"x".repeat(MAX_SUPPLIER_NAME_LENGTH)}  ` })
        .success,
    ).toBe(true);
  });

  it.each([[undefined], [null], [42], [{}]])("refuses %s as a name", (name) => {
    expect(supplierCreateSchema.safeParse({ name }).success).toBe(false);
  });

  it("accepts an optional note and bounds it", () => {
    expect(supplierCreateSchema.safeParse({ name: "A", notes: "pays monthly" }).success).toBe(true);
    expect(
      supplierCreateSchema.safeParse({
        name: "A",
        notes: "x".repeat(MAX_SUPPLIER_NOTES_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("updating a supplier", () => {
  it("accepts a name alone, a note alone, or both", () => {
    expect(supplierUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(supplierUpdateSchema.safeParse({ notes: "new note" }).success).toBe(true);
    expect(supplierUpdateSchema.safeParse({ name: "R", notes: "n" }).success).toBe(true);
  });

  it("accepts an empty note, which clears it", () => {
    const parsed = supplierUpdateSchema.safeParse({ notes: "" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.notes).toBe("");
  });

  it("refuses an update that changes nothing", () => {
    expect(supplierUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a blank name on a rename", () => {
    expect(supplierUpdateSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("has no status field — activation is its own operation", () => {
    /*
     * M10 §21 audits deactivation as its own event, and §23 gives it a
     * consequence a generic update has no place deciding. So the field is
     * absent and a caller sending it changes nothing.
     */
    const parsed = supplierUpdateSchema.safeParse({ name: "A", status: "inactive" });

    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("status");
  });
});

describe("the supplier filter", () => {
  it("defaults to all suppliers", () => {
    const parsed = supplierFilterSchema.safeParse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data?.status).toBe("all");
  });

  it.each([["all"], ["active"], ["inactive"]])("accepts %s", (status) => {
    expect(supplierFilterSchema.safeParse({ status }).success).toBe(true);
  });

  it.each([["archived"], ["deleted"], [""], ["ACTIVE"]])("refuses %s", (status) => {
    expect(supplierFilterSchema.safeParse({ status }).success).toBe(false);
  });
});

describe("assigning an account's supplier — M10 §7", () => {
  it("accepts a supplier id", () => {
    expect(accountSupplierSchema.safeParse({ accountId: UUID, supplierId: UUID }).success).toBe(
      true,
    );
  });

  it("accepts null, which is My Account", () => {
    const parsed = accountSupplierSchema.safeParse({ accountId: UUID, supplierId: null });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.supplierId).toBeNull();
  });

  it("refuses a MISSING supplierId, so a malformed request cannot read as My Account", () => {
    expect(accountSupplierSchema.safeParse({ accountId: UUID }).success).toBe(false);
  });

  it.each([["mine"], ["__mine__"], [""], ["not-a-uuid"]])("refuses %s as a supplier", (value) => {
    expect(accountSupplierSchema.safeParse({ accountId: UUID, supplierId: value }).success).toBe(
      false,
    );
  });
});

describe("the accounts list's supplier filter — M10 §9", () => {
  it("reads a uuid", () => {
    expect(parseAccountFilter({ supplier: UUID }).supplierId).toBe(UUID);
  });

  it("reads the My Accounts sentinel", () => {
    expect(parseAccountFilter({ supplier: "mine" }).supplierId).toBe("mine");
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a uuid", "netstore"],
    ["an injection attempt", "' or 1=1 --"],
    ["a near-uuid", "aaaaaaaa-0000-4000-8000"],
  ])("drops %s rather than passing it to a uuid comparison", (_label, supplier) => {
    expect(parseAccountFilter({ supplier }).supplierId).toBeUndefined();
  });

  it("is dropped by withoutNarrowing, because 'all' means all", async () => {
    const { withoutNarrowing } = await import("@/modules/accounts/services/account-filters");

    expect(withoutNarrowing(parseAccountFilter({ supplier: UUID })).supplierId).toBeUndefined();
  });
});

describe("the supplier model's place in a backup", () => {
  it("is captured, and BEFORE accounts so a restore can point at it", async () => {
    /*
     * A new table is not backed up until it is named in the manifest, and the
     * order is load-bearing: restore inserts in this order, so `suppliers` must
     * precede `accounts` or every supplier_id would reference a row that does
     * not exist yet. The backup suite asserts the manifest covers every public
     * table; this asserts the ORDER, which that check cannot see.
     */
    const { BACKUP_TABLE_NAMES } = await import("@/modules/backups");

    expect(BACKUP_TABLE_NAMES).toContain("suppliers");
    expect(BACKUP_TABLE_NAMES.indexOf("suppliers")).toBeLessThan(
      BACKUP_TABLE_NAMES.indexOf("accounts"),
    );
  });

  it("declares the account relationship as nullable, because My Account is null", async () => {
    const { RELATIONSHIPS } = await import("@/modules/backups");

    expect(RELATIONSHIPS).toEqual(
      expect.arrayContaining([
        { table: "accounts", column: "supplier_id", parent: "suppliers", nullable: true },
      ]),
    );
  });
});
