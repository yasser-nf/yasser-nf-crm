import { describe, expect, it } from "vitest";

import { CSV_BOM, escapeCsvCell, timestampedFilename, toCsv, toCsvRow } from "@/lib/csv";
import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import { ACCOUNT_EXPORT_HEADERS, accountToCsvRow } from "@/modules/accounts/services/account-csv";
import { parseAccountFilter, withoutNarrowing } from "@/modules/accounts/services/account-filters";
import {
  CUSTOMER_EXPORT_HEADERS,
  customerToCsvRow,
} from "@/modules/customers/services/customer-csv";
import { parseCustomerFilter } from "@/modules/customers/services/customer-filters";

/**
 * CSV export.
 *
 * Two things can go wrong here and only one of them is obvious. The obvious one
 * is malformed CSV — a comma in a note shifting every column after it. The
 * quiet one is an export that disagrees with the screen, or that carries a
 * field nobody meant to publish.
 */

describe("escaping one cell", () => {
  it("leaves a plain value alone", () => {
    expect(escapeCsvCell("hello")).toBe("hello");
  });

  it("quotes a value containing a comma", () => {
    expect(escapeCsvCell("Doe, John")).toBe('"Doe, John"');
  });

  it("doubles quotes and wraps the value", () => {
    expect(escapeCsvCell('He said "no"')).toBe('"He said ""no"""');
  });

  it("keeps a newline inside one quoted cell", () => {
    /* A note spanning lines must not become two rows. */
    expect(escapeCsvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("handles a carriage return the same way", () => {
    expect(escapeCsvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("writes an empty cell for null and undefined", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    /* Never the strings "null" or "undefined", which read as data. */
    expect(escapeCsvCell(null)).not.toBe("null");
  });

  it("keeps zero, which is a number and not an absence", () => {
    expect(escapeCsvCell(0)).toBe("0");
  });

  it("preserves UTF-8 exactly", () => {
    expect(escapeCsvCell("محمد")).toBe("محمد");
    expect(escapeCsvCell("Zoë Müller")).toBe("Zoë Müller");
    expect(escapeCsvCell("北京")).toBe("北京");
  });
});

describe("the spreadsheet formula guard", () => {
  it("neutralises a formula hidden in a note", () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil","click")')).toMatch(/^"?'=/);
  });

  it("neutralises the DDE form", () => {
    expect(escapeCsvCell("=cmd|'/c calc'!A1")).toContain("'=cmd");
  });

  it("neutralises a formula that starts with a plus", () => {
    expect(escapeCsvCell("+SUM(A1:A9)")).toBe("'+SUM(A1:A9)");
  });

  it("leaves an international identifier exactly as it is", () => {
    /*
     * The reason the guard tests for formula structure rather than the prefix
     * alone. Identifiers are displayed as +213…, and prefixing them would
     * corrupt the commonest value in the customers file to defend against a
     * string that cannot execute anything.
     */
    expect(escapeCsvCell("+213456789012")).toBe("+213456789012");
  });

  it("leaves an @handle identifier exactly as it is", () => {
    expect(escapeCsvCell("@yasser")).toBe("@yasser");
  });

  it("leaves an ordinary negative number alone", () => {
    expect(escapeCsvCell(-5)).toBe("-5");
  });
});

describe("assembling a document", () => {
  it("starts with the byte order mark Excel needs to read UTF-8", () => {
    expect(toCsv(["A"], [["x"]]).startsWith(CSV_BOM)).toBe(true);
  });

  it("separates rows with CRLF", () => {
    const csv = toCsv(["A", "B"], [["1", "2"]]);

    expect(csv).toBe(`${CSV_BOM}A,B\r\n1,2\r\n`);
  });

  it("writes a header row even when there are no data rows", () => {
    /* An empty export is still a valid file; the UI decides not to offer it. */
    expect(toCsv(["A", "B"], [])).toBe(`${CSV_BOM}A,B\r\n`);
  });

  it("escapes headers by the same rules as data", () => {
    expect(toCsvRow(["Name, full"])).toBe('"Name, full"');
  });

  it("keeps a multi-line note from breaking the row count", () => {
    const csv = toCsv(["Note"], [["first\nsecond"]]);

    /* Two logical rows: the header and one record, whatever the line count. */
    expect(csv).toBe(`${CSV_BOM}Note\r\n"first\nsecond"\r\n`);
  });
});

describe("the filename", () => {
  it("is prefixed and dated", () => {
    expect(timestampedFilename("accounts", new Date(2026, 8, 2))).toBe("accounts-2026-09-02.csv");
  });

  it("pads single digits", () => {
    expect(timestampedFilename("customers", new Date(2026, 0, 5))).toBe("customers-2026-01-05.csv");
  });
});

describe("the account row", () => {
  const row = {
    account: {
      id: "acc-1",
      email: "one@icloud.com",
      status: "healthy" as const,
      healthScore: 100,
      country: "JP",
      createdAt: new Date("2026-09-01T10:00:00Z"),
      updatedAt: new Date("2026-09-01T10:00:00Z"),
      validFrom: null,
      validUntil: null,
      profileSlots: 5,
      notes: null,
    },
    indicators: [
      { profileId: "p1", profileNumber: 1, state: "sold" as const, expirationDate: null },
      { profileId: "p2", profileNumber: 2, state: "available" as const, expirationDate: null },
      { profileId: "p3", profileNumber: 3, state: "available" as const, expirationDate: null },
      { profileId: "p4", profileNumber: 4, state: "expired" as const, expirationDate: null },
      { profileId: "p5", profileNumber: 5, state: "not_for_sale" as const, expirationDate: null },
    ],
    availableProfiles: 2,
    soldProfiles: 1,
    notForSaleProfiles: 1,
    expiredProfiles: 1,
    remainingValidityDays: null,
    hasActiveProblem: false,
  } as unknown as Parameters<typeof accountToCsvRow>[0];

  it("has one cell per header", () => {
    /* The bug this catches is a column added to one list and not the other. */
    expect(accountToCsvRow(row)).toHaveLength(ACCOUNT_EXPORT_HEADERS.length);
  });

  it("carries no credential of any kind", () => {
    const serialised = JSON.stringify(accountToCsvRow(row)).toLowerCase();

    for (const forbidden of ["password", "pin", "token", "cookie", "secret", "encrypted"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("names the headers the operator asked for, and nothing else", () => {
    expect([...ACCOUNT_EXPORT_HEADERS]).toEqual([
      "Email",
      "Status",
      "Health",
      "Country",
      "Created",
      "Profile 1",
      "Profile 2",
      "Profile 3",
      "Profile 4",
      "Profile 5",
      "Total profiles",
      "Available profiles",
      "Sold profiles",
      "Validity",
    ]);
  });

  it("uses the tallies it was given rather than recounting", () => {
    const cells = accountToCsvRow(row);

    expect(cells[11]).toBe(2);
    expect(cells[12]).toBe(1);
  });

  it("shows Problem instead of Healthy when a problem is open", () => {
    /* The same override the badge applies, so the file cannot say Healthy. */
    const flagged = { ...row, hasActiveProblem: true } as typeof row;

    expect(accountToCsvRow(flagged)[1]).toBe("Problem");
    expect(accountToCsvRow(row)[1]).toBe("Healthy");
  });

  it("writes the validity in the same words as the table", () => {
    expect(accountToCsvRow(row)[13]).toBe("Open-ended");
  });
});

describe("the customer row", () => {
  const row = {
    customer: {
      id: "cus-1",
      phoneNormalized: "512345678",
      lastPurchaseAt: new Date("2026-08-20T10:00:00Z"),
      createdAt: new Date("2026-07-01T10:00:00Z"),
      blockedAt: null,
      deletedAt: null,
      notes: "Prefers WhatsApp,\nmornings only",
    },
    activeProfiles: 2,
    expiredProfiles: 1,
  } as unknown as Parameters<typeof customerToCsvRow>[0];

  it("has one cell per header", () => {
    expect(customerToCsvRow(row)).toHaveLength(CUSTOMER_EXPORT_HEADERS.length);
  });

  it("keeps a note containing a comma and a newline in one cell", () => {
    const csv = toCsv(CUSTOMER_EXPORT_HEADERS, [customerToCsvRow(row)]);

    expect(csv).toContain('"Prefers WhatsApp,\nmornings only"');
  });

  it("reports the status the badge would show", () => {
    expect(customerToCsvRow(row)[3]).toBe("Active");
    expect(customerToCsvRow({ ...row, activeProfiles: 0 } as typeof row)[3]).toBe("Inactive");
  });

  it("reports Blocked ahead of activity", () => {
    const blocked = {
      ...row,
      customer: { ...row.customer, blockedAt: new Date() },
    } as typeof row;

    expect(customerToCsvRow(blocked)[3]).toBe("Blocked");
  });

  it("carries no credential of any kind", () => {
    const serialised = JSON.stringify(customerToCsvRow(row)).toLowerCase();

    for (const forbidden of ["password", "pin", "token", "cookie", "secret"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("the filter the export runs", () => {
  it("reads the same query string the accounts page reads", () => {
    const filter = parseAccountFilter({ search: "netflix", status: "archived", sortBy: "email" });

    expect(filter.search).toBe("netflix");
    expect(filter.status).toBe("archived");
    expect(filter.sortBy).toBe("email");
  });

  it("refuses a status that is not a real status", () => {
    /* Query strings reach the export from a browser, not from the router. */
    expect(parseAccountFilter({ status: "'; drop table accounts--" }).status).toBeUndefined();
  });

  it("refuses a sort column that is not sortable", () => {
    expect(parseAccountFilter({ sortBy: "passwordEncrypted" }).sortBy).toBe("createdAt");
  });

  it("drops search and status for an export of everything", () => {
    const filtered = parseAccountFilter({ search: "netflix", status: "archived" });
    const all = withoutNarrowing(filtered);

    expect(all.search).toBeUndefined();
    expect(all.status).toBeUndefined();
    expect(all.offset).toBe(0);
  });

  it("reads the customer toggles the way the customers page does", () => {
    const filter = parseCustomerFilter({ search: "05", active: "1", blocked: "1" });

    expect(filter.search).toBe("05");
    expect(filter.onlyActive).toBe(true);
    expect(filter.onlyBlocked).toBe(true);
  });

  it("treats an absent customer toggle as off", () => {
    const filter = parseCustomerFilter({});

    expect(filter.onlyActive).toBe(false);
    expect(filter.onlyBlocked).toBe(false);
  });
});

describe("authorization", () => {
  it("requires the same permission the accounts page requires", () => {
    expect(roleHasPermission(USER_ROLES.WORKER, PERMISSIONS.VIEW_ACCOUNTS)).toBe(true);
    expect(roleHasPermission(USER_ROLES.SUPER_ADMIN, PERMISSIONS.VIEW_ACCOUNTS)).toBe(true);
  });

  it("requires the same permission the customers page requires", () => {
    expect(roleHasPermission(USER_ROLES.WORKER, PERMISSIONS.VIEW_CUSTOMERS)).toBe(true);
  });

  it("refuses an account export with no signed-in user", async () => {
    /*
     * Calls the real service. The permission check runs before the repository
     * is touched, so an unauthorized call never reaches the database.
     */
    const { accountExportService } =
      await import("@/modules/accounts/services/account-export.service");

    const result = await accountExportService.exportAccounts(null, "all", {}, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("refuses a customer export with no signed-in user", async () => {
    const { customerExportService } =
      await import("@/modules/customers/services/customer-export.service");

    const result = await customerExportService.exportCustomers(null, "all", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("refuses an export scope it does not recognise", async () => {
    const { accountExportService } =
      await import("@/modules/accounts/services/account-export.service");

    const actor = {
      id: "u1",
      email: "a@b.c",
      displayName: "A",
      initials: "A",
      role: USER_ROLES.SUPER_ADMIN,
    };

    const result = await accountExportService.exportAccounts(actor, "everything", {}, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
