import { describe, expect, it } from "vitest";

import {
  cleanSupplierName,
  isSameSupplierName,
  isValidSupplierName,
  normalizeSupplierName,
  MAX_SUPPLIER_NAME_LENGTH,
} from "@/modules/suppliers";

/**
 * Supplier name identity. M10 §5.
 *
 * The rule the brief states by example: "Supplier A" and " supplier a " are one
 * supplier, not two. These tests are the rule; the unique index on
 * `name_normalized` is what makes it a guarantee.
 */

describe("normalizing a supplier name", () => {
  it("treats case, padding and inner runs as one identity — M10 §5's example", () => {
    const forms = ["Supplier A", " supplier a ", "SUPPLIER A", "Supplier  A", "\tSupplier\tA\n"];

    for (const form of forms) {
      expect(normalizeSupplierName(form)).toBe("supplier a");
    }
  });

  it("collapses every kind of whitespace, not only the space character", () => {
    /* Pasted out of a spreadsheet: tabs and non-breaking spaces arrive too. */
    expect(normalizeSupplierName("Net Store\tDZ")).toBe("net store dz");
  });

  it("keeps everything that is part of the name", () => {
    expect(normalizeSupplierName("Netflix-Store (DZ) #2")).toBe("netflix-store (dz) #2");
  });

  it("is idempotent, so a stored value re-normalizes to itself", () => {
    const once = normalizeSupplierName("  Supplier   A  ");

    expect(normalizeSupplierName(once)).toBe(once);
  });

  it("does not depend on the server's locale", () => {
    /*
     * `toLowerCase`, never `toLocaleLowerCase`: the result is a database key,
     * and Turkish dotless i would otherwise make the same name normalize two
     * ways on two machines.
     */
    expect(normalizeSupplierName("ISTANBUL")).toBe("istanbul");
  });
});

describe("the name as it is stored and shown", () => {
  it("trims and collapses but preserves case", () => {
    expect(cleanSupplierName("  NetStore   DZ ")).toBe("NetStore DZ");
  });

  it("leaves an already-clean name untouched", () => {
    expect(cleanSupplierName("NetStore DZ")).toBe("NetStore DZ");
  });
});

describe("whether a name is usable", () => {
  it.each([["Supplier A"], ["A"], ["Néo Store"], ["x".repeat(MAX_SUPPLIER_NAME_LENGTH)]])(
    "accepts %s",
    (name) => {
      expect(isValidSupplierName(name)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["one space", " "],
    ["only whitespace", "   \t\n "],
    ["too long", "x".repeat(MAX_SUPPLIER_NAME_LENGTH + 1)],
  ])("refuses %s", (_label, name) => {
    expect(isValidSupplierName(name)).toBe(false);
  });

  it("measures the CLEANED name, so padding cannot push it over the bound", () => {
    expect(isValidSupplierName(`  ${"x".repeat(MAX_SUPPLIER_NAME_LENGTH)}  `)).toBe(true);
  });
});

describe("comparing two names", () => {
  it("is true for the same supplier typed differently", () => {
    expect(isSameSupplierName("Supplier A", " supplier  a ")).toBe(true);
  });

  it("is false for genuinely different suppliers", () => {
    expect(isSameSupplierName("Supplier A", "Supplier B")).toBe(false);
    expect(isSameSupplierName("NetStore", "NetStore DZ")).toBe(false);
  });
});
