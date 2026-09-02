import { beforeEach, describe, expect, it, vi } from "vitest";

import { USER_ROLES } from "@/config/roles";
import { DatabaseError } from "@/lib/errors";
import { fail, ok } from "@/utils/result";

/**
 * What each export scope actually asks the database for.
 *
 * The list services are mocked, so these assert the part the export owns: which
 * filter it runs, that it pages until it has everything, and that a selected
 * export contains only what was ticked. The rows themselves come from the same
 * call the screen makes, which is exactly why nothing here recomputes a tally.
 */

const listAccounts = vi.fn();
const listCustomers = vi.fn();

vi.mock("@/modules/accounts/services/accounts.service", () => ({
  accountsService: { listAccounts: (filter: unknown) => listAccounts(filter) },
}));

vi.mock("@/modules/customers/services/customers.service", () => ({
  customersService: { list: (filter: unknown) => listCustomers(filter) },
}));

const { accountExportService } = await import("@/modules/accounts/services/account-export.service");
const { customerExportService } =
  await import("@/modules/customers/services/customer-export.service");

const ACTOR = {
  id: "u1",
  email: "admin@example.com",
  displayName: "Admin",
  initials: "A",
  role: USER_ROLES.SUPER_ADMIN,
};

function accountRow(id: string, email: string) {
  return {
    account: {
      id,
      email,
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
    indicators: [],
    availableProfiles: 3,
    soldProfiles: 2,
    notForSaleProfiles: 0,
    expiredProfiles: 0,
    remainingValidityDays: null,
    hasActiveProblem: false,
  };
}

function customerRow(id: string, phone: string) {
  return {
    customer: {
      id,
      phoneNormalized: phone,
      lastPurchaseAt: null,
      createdAt: new Date("2026-07-01T10:00:00Z"),
      blockedAt: null,
      deletedAt: null,
      notes: null,
    },
    activeProfiles: 1,
    expiredProfiles: 0,
  };
}

/** One page containing everything it was given. */
function singlePage(items: readonly unknown[]) {
  return ok({ items, total: items.length, limit: 100, offset: 0 });
}

beforeEach(() => {
  listAccounts.mockReset();
  listCustomers.mockReset();
});

describe("export all accounts", () => {
  it("ignores the search box and the status filter", async () => {
    listAccounts.mockResolvedValue(singlePage([accountRow("a", "one@x.com")]));

    await accountExportService.exportAccounts(
      ACTOR,
      "all",
      { search: "netflix", status: "archived" },
      [],
    );

    const asked = listAccounts.mock.calls[0]?.[0];

    expect(asked.search).toBeUndefined();
    expect(asked.status).toBeUndefined();
  });

  it("returns a row for every account", async () => {
    listAccounts.mockResolvedValue(
      singlePage([accountRow("a", "one@x.com"), accountRow("b", "two@x.com")]),
    );

    const result = await accountExportService.exportAccounts(ACTOR, "all", {}, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(2);
      expect(result.value.csv).toContain("one@x.com");
      expect(result.value.csv).toContain("two@x.com");
    }
  });
});

describe("export filtered accounts", () => {
  it("runs the filter the operator is looking at", async () => {
    listAccounts.mockResolvedValue(singlePage([accountRow("a", "one@x.com")]));

    await accountExportService.exportAccounts(
      ACTOR,
      "filtered",
      { search: "netflix", status: "archived", sortBy: "email" },
      [],
    );

    const asked = listAccounts.mock.calls[0]?.[0];

    expect(asked.search).toBe("netflix");
    expect(asked.status).toBe("archived");
    expect(asked.sortBy).toBe("email");
  });

  it("starts at the first row rather than the page being viewed", async () => {
    /* Exporting page three of a filter should still export the whole filter. */
    listAccounts.mockResolvedValue(singlePage([accountRow("a", "one@x.com")]));

    await accountExportService.exportAccounts(ACTOR, "filtered", { offset: "50" }, []);

    expect(listAccounts.mock.calls[0]?.[0].offset).toBe(0);
  });
});

describe("export selected accounts", () => {
  it("includes only the accounts whose boxes are ticked", async () => {
    listAccounts.mockResolvedValue(
      singlePage([
        accountRow("a", "one@x.com"),
        accountRow("b", "two@x.com"),
        accountRow("c", "three@x.com"),
      ]),
    );

    const result = await accountExportService.exportAccounts(ACTOR, "selected", {}, ["a", "c"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(2);
      expect(result.value.csv).toContain("one@x.com");
      expect(result.value.csv).toContain("three@x.com");
      expect(result.value.csv).not.toContain("two@x.com");
    }
  });

  it("cannot be pointed at an account outside the current view", async () => {
    /*
     * The ids are intersected with the filtered result rather than fetched, so
     * a hand-written id matches nothing instead of reaching a row the operator
     * was not looking at.
     */
    listAccounts.mockResolvedValue(singlePage([accountRow("a", "one@x.com")]));

    const result = await accountExportService.exportAccounts(ACTOR, "selected", {}, [
      "a",
      "some-other-account",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.csv).toContain("one@x.com");
    }
  });

  it("refuses a selection that is not a list of ids", async () => {
    listAccounts.mockResolvedValue(singlePage([]));

    const result = await accountExportService.exportAccounts(ACTOR, "selected", {}, "a,b");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("an empty export", () => {
  it("succeeds with no rows rather than failing", async () => {
    listAccounts.mockResolvedValue(ok({ items: [], total: 0, limit: 100, offset: 0 }));

    const result = await accountExportService.exportAccounts(ACTOR, "all", {}, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(0);
      /* Headers only. The UI turns this into "No data to export". */
      expect(result.value.csv).toContain("Email");
    }
  });

  it("reports nothing selected as nothing exported", async () => {
    listAccounts.mockResolvedValue(singlePage([accountRow("a", "one@x.com")]));

    const result = await accountExportService.exportAccounts(ACTOR, "selected", {}, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(0);
    }
  });
});

describe("reading past the first page", () => {
  it("keeps asking until it has every matching row", async () => {
    const first = Array.from({ length: 100 }, (_, i) => accountRow(`a${i}`, `a${i}@x.com`));
    const second = Array.from({ length: 20 }, (_, i) => accountRow(`b${i}`, `b${i}@x.com`));

    listAccounts
      .mockResolvedValueOnce(ok({ items: first, total: 120, limit: 100, offset: 0 }))
      .mockResolvedValueOnce(ok({ items: second, total: 120, limit: 100, offset: 100 }));

    const result = await accountExportService.exportAccounts(ACTOR, "all", {}, []);

    expect(listAccounts).toHaveBeenCalledTimes(2);
    expect(listAccounts.mock.calls[1]?.[0].offset).toBe(100);
    if (result.ok) {
      expect(result.value.rowCount).toBe(120);
    }
  });

  it("stops rather than looping when a page comes back empty", async () => {
    /* A total that disagrees with the rows must not spin forever. */
    listAccounts.mockResolvedValue(ok({ items: [], total: 999, limit: 100, offset: 0 }));

    const result = await accountExportService.exportAccounts(ACTOR, "all", {}, []);

    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("surfaces a read failure instead of exporting a partial file", async () => {
    listAccounts.mockResolvedValue(fail(new DatabaseError("connection pool exhausted")));

    const result = await accountExportService.exportAccounts(ACTOR, "all", {}, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DATABASE_ERROR");
    }
  });
});

describe("customer export scopes", () => {
  it("ignores the toggles for an export of everything", async () => {
    listCustomers.mockResolvedValue(singlePage([customerRow("c1", "512345678")]));

    await customerExportService.exportCustomers(ACTOR, "all", { active: "1", search: "05" });

    const asked = listCustomers.mock.calls[0]?.[0];

    expect(asked.search).toBeUndefined();
    expect(asked.onlyActive).toBeUndefined();
  });

  it("runs Active only and Blocked exactly as the screen does", async () => {
    listCustomers.mockResolvedValue(singlePage([customerRow("c1", "512345678")]));

    await customerExportService.exportCustomers(ACTOR, "filtered", {
      active: "1",
      blocked: "1",
      search: "05",
    });

    const asked = listCustomers.mock.calls[0]?.[0];

    expect(asked.onlyActive).toBe(true);
    expect(asked.onlyBlocked).toBe(true);
    expect(asked.search).toBe("05");
  });

  it("returns a row for every customer", async () => {
    listCustomers.mockResolvedValue(
      singlePage([customerRow("c1", "512345678"), customerRow("c2", "@yasser")]),
    );

    const result = await customerExportService.exportCustomers(ACTOR, "all", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(2);
      expect(result.value.csv).toContain("@yasser");
    }
  });

  it("succeeds with no rows when nothing matches", async () => {
    listCustomers.mockResolvedValue(ok({ items: [], total: 0, limit: 100, offset: 0 }));

    const result = await customerExportService.exportCustomers(ACTOR, "filtered", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(0);
    }
  });
});
