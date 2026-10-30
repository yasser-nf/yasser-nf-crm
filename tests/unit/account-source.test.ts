import { describe, expect, it } from "vitest";

import {
  accountSourceOptions,
  parseAccountSource,
  supplierSourceValue,
} from "@/lib/account-source";

/**
 * The `source` query parameter (M09B).
 *
 * The parser is the boundary between a URL anyone can type and a uuid
 * comparison in SQL, so what it refuses matters as much as what it accepts.
 */

const SUPPLIER = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

describe("parseAccountSource", () => {
  it("accepts each broad answer", () => {
    for (const kind of ["owned", "supplied", "unassigned", "unknown"] as const) {
      expect(parseAccountSource(kind)).toEqual({ kind });
    }
  });

  it("accepts one named supplier", () => {
    expect(parseAccountSource(`supplier:${SUPPLIER}`)).toEqual({
      kind: "supplier",
      supplierId: SUPPLIER,
    });
  });

  it("ignores anything else rather than failing the page", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "OWNED",
      "all",
      "supplier:",
      "supplier:not-a-uuid",
      `supplier:${SUPPLIER}'; drop table accounts; --`,
      SUPPLIER,
    ]) {
      expect(parseAccountSource(raw), String(raw)).toBeUndefined();
    }
  });

  it("round-trips every option a control offers", () => {
    const options = accountSourceOptions([{ id: SUPPLIER, name: "Karim" }]);

    /* Whatever the browser can send, the server understands. */
    for (const option of options) {
      expect(parseAccountSource(option.value), option.value).toBeDefined();
    }

    expect(options.map((option) => option.value)).toContain(supplierSourceValue(SUPPLIER));
    expect(options.at(-1)?.label).toBe("Supplier: Karim");
  });
});
