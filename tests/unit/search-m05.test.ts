import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { identifierSearchKeys } from "@/lib/phone";
import { fail, ok } from "@/utils/result";

/**
 * M05 global search: matching rules and the service's promises, without a
 * database. The repository is replaced so each group can be made to fail on
 * its own — which is how "error is not empty" is pinned.
 */

const repo = {
  accounts: vi.fn(),
  profiles: vi.fn(),
  customers: vi.fn(),
  problems: vi.fn(),
  users: vi.fn(),
};
const accountsWithActiveProblems = vi.fn();

vi.mock("@/modules/search/repositories/search.repository", () => ({ searchRepository: repo }));
vi.mock("@/modules/problems", () => ({
  problemsService: { accountsWithActiveProblems: () => accountsWithActiveProblems() },
}));

const { searchService } = await import("@/modules/search/services/search.service");
const { buildSearchTerms, escapeLike, matchingProblemTypes, normalizeQuery } =
  await import("@/modules/search/services/search-terms");
const { DatabaseError } = await import("@/lib/errors");

const ADMIN: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "a@example.com",
  displayName: "Admin",
  initials: "A",
  role: "super_admin",
};
const WORKER: AppUser = { ...ADMIN, id: "00000000-0000-4000-8000-000000000002", role: "worker" };

const ACCOUNT = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "one@icloud.com",
  status: "healthy",
  validUntil: null,
  deletedAt: null,
};

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockResolvedValue(ok([]));
  accountsWithActiveProblems.mockResolvedValue(ok(new Map()));
});

afterEach(() => vi.clearAllMocks());

/* ------------------------------------------------------------------ matching */

describe("query rules", () => {
  it("defines the minimum: fewer than two characters is not a search", () => {
    expect(normalizeQuery("a")).toBeNull();
    expect(normalizeQuery("   a  ")).toBeNull();
    expect(normalizeQuery("ab")).toBe("ab");
  });

  it("collapses whitespace and caps the length", () => {
    expect(normalizeQuery("  kids    room ")).toBe("kids room");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(100);
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(buildSearchTerms("a_b").contains).toBe("%a\\_b%");
  });

  it("matches problem types by their label, case-insensitively, from three letters", () => {
    expect(matchingProblemTypes("PAYMENT")).toEqual(["payment_problem"]);
    expect(matchingProblemTypes("password")).toEqual(["incorrect_password"]);
    expect(matchingProblemTypes("in")).toEqual([]);
  });

  it("recognises an id fragment only from a full first group", () => {
    expect(buildSearchTerms("1111111").idPrefix).toBeNull();
    expect(buildSearchTerms("11111111").idPrefix).toBe("11111111%");
    expect(buildSearchTerms("one@icloud").idPrefix).toBeNull();
  });
});

describe("phone fragments come from the Phone Engine", () => {
  it.each([
    ["0663 94", ["066394", "66394"]],
    ["+213 663 94", ["21366394", "66394"]],
    ["00213 663", ["00213663", "663"]],
    ["00974 7160", ["009747160", "9747160"]],
    ["0663947116", ["0663947116", "663947116"]],
    ["@RAH", ["@rah"]],
    ["(0663) 94-71", ["06639471", "6639471"]],
    ["0663.94.71.16", ["0663947116", "663947116"]],
  ])("%s → %j", (input, keys) => {
    expect(identifierSearchKeys(input).sort()).toEqual([...keys].sort());
  });

  it("returns nothing for text or for fewer than three digits", () => {
    expect(identifierSearchKeys("karim")).toEqual([]);
    /* Digits inside other text are not a phone number (M05 review). */
    expect(identifierSearchKeys("user123@icloud.com")).toEqual([]);
    expect(identifierSearchKeys("kids 2024")).toEqual([]);
    expect(identifierSearchKeys("acc0663947@x.com")).toEqual([]);
    expect(identifierSearchKeys("06 63 ab")).toEqual([]);
    expect(identifierSearchKeys("06")).toEqual([]);
    expect(identifierSearchKeys("@")).toEqual([]);
  });
});

/* ------------------------------------------------------------------- service */

describe("the service", () => {
  it("does not ask the database for a one-character query", async () => {
    const result = await searchService.search("a", ADMIN);

    expect(result.ok && result.value.groups).toEqual([]);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses the signed-out and a non-string query", async () => {
    expect((await searchService.search("abc", null)).ok).toBe(false);
    expect((await searchService.search({ q: "abc" }, ADMIN)).ok).toBe(false);
  });

  it("never queries users for a Worker — the group does not exist for them", async () => {
    const result = await searchService.search("test", WORKER);

    expect(repo.users).not.toHaveBeenCalled();
    expect(result.ok && result.value.groups.map((group) => group.kind)).toEqual([
      "accounts",
      "profiles",
      "customers",
      "problems",
    ]);
  });

  it("a Super Admin searches all five", async () => {
    const result = await searchService.search("test", ADMIN);

    expect(result.ok && result.value.groups.map((group) => group.kind)).toEqual([
      "accounts",
      "profiles",
      "customers",
      "problems",
      "users",
    ]);
  });

  it("one failed group is an error in place; the others still answer", async () => {
    repo.customers.mockResolvedValue(fail(new DatabaseError("down")));
    repo.accounts.mockResolvedValue(ok([ACCOUNT]));

    const result = await searchService.search("one", ADMIN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byKind = Object.fromEntries(result.value.groups.map((group) => [group.kind, group]));
    expect(byKind["customers"]?.status).toBe("error");
    expect(byKind["accounts"]).toMatchObject({ status: "ok", hits: [{ title: "one@icloud.com" }] });
  });

  it("when every group fails, the search fails — it is not 'no results'", async () => {
    for (const fn of Object.values(repo)) fn.mockResolvedValue(fail(new DatabaseError("down")));

    const result = await searchService.search("one", ADMIN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DATABASE_ERROR");
  });

  it("if blocking problems cannot be read, accounts and profiles fail rather than guess Healthy", async () => {
    repo.accounts.mockResolvedValue(ok([ACCOUNT]));
    accountsWithActiveProblems.mockResolvedValue(fail(new DatabaseError("down")));

    const result = await searchService.search("one", ADMIN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const statuses = result.value.groups.map((group) => [group.kind, group.status]);
    expect(statuses).toContainEqual(["accounts", "error"]);
    expect(statuses).toContainEqual(["profiles", "error"]);
    expect(statuses).toContainEqual(["customers", "ok"]);
  });

  it("an account with a blocking problem is badged by that problem", async () => {
    repo.accounts.mockResolvedValue(ok([ACCOUNT]));
    accountsWithActiveProblems.mockResolvedValue(ok(new Map([[ACCOUNT.id, ["payment_problem"]]])));

    const result = await searchService.search("one", ADMIN);
    const accounts = result.ok ? result.value.groups[0] : undefined;

    expect(accounts?.status === "ok" && accounts.hits[0]?.badge?.label).toBe("Payment Problem");
  });

  it("caps each group at five and reports more, with a link where a list page exists", async () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      ...ACCOUNT,
      id: `11111111-1111-4111-8111-11111111111${index}`,
      email: `acc${index}@icloud.com`,
    }));
    repo.accounts.mockResolvedValue(ok(six));

    const result = await searchService.search("acc", ADMIN);
    const accounts = result.ok ? result.value.groups[0] : undefined;

    expect(accounts?.status).toBe("ok");
    if (accounts?.status !== "ok") return;
    expect(accounts.hits).toHaveLength(5);
    expect(accounts.hasMore).toBe(true);
    expect(accounts.viewAllHref).toBe("/accounts?search=acc");
  });

  it("returns only presentational fields — no credential can ride along", async () => {
    repo.accounts.mockResolvedValue(
      ok([{ ...ACCOUNT, passwordEncrypted: "v1:iv:tag:secret", pin: "1234", notes: "x" }]),
    );

    const result = await searchService.search("one", ADMIN);
    const hit =
      result.ok && result.value.groups[0]?.status === "ok" ? result.value.groups[0].hits[0] : null;

    expect(Object.keys(hit ?? {}).sort()).toEqual(["badge", "href", "id", "subtitle", "title"]);
    expect(JSON.stringify(result)).not.toMatch(/secret|1234/);
  });
});
