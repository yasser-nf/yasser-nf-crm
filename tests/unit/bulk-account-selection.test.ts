import { describe, expect, it, vi } from "vitest";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import { DatabaseError, ForbiddenError, NotFoundError } from "@/lib/errors";
import {
  EMPTY_SELECTION,
  actionableIds,
  allSelected,
  resultSetKey,
  selectionLabel,
  partitionByProblem,
  someSelected,
  toggleAll,
  toggleSelected,
} from "@/modules/accounts/services/account-selection";
import { deleteEachAccount, uniqueIds } from "@/modules/accounts/services/bulk-delete";
import { fail, ok } from "@/utils/result";

/**
 * Bulk account selection and deletion.
 *
 * The dangerous property of this feature is not that a delete might fail — it
 * is that a delete might succeed on the wrong account. Selection is a Set that
 * outlives individual rows, so most of what follows checks that the set can
 * never name something the operator is not looking at.
 */

const ROWS = ["a", "b", "c"] as const;

describe("selecting accounts", () => {
  it("selects one account", () => {
    const selection = toggleSelected(EMPTY_SELECTION, "a");

    expect([...selection]).toEqual(["a"]);
    expect(selection.has("b")).toBe(false);
  });

  it("selects several accounts without disturbing the others", () => {
    const selection = toggleSelected(toggleSelected(EMPTY_SELECTION, "a"), "c");

    expect([...selection].sort()).toEqual(["a", "c"]);
    expect(selection.has("b")).toBe(false);
  });

  it("deselects an account that was already selected", () => {
    const selection = toggleSelected(toggleSelected(EMPTY_SELECTION, "a"), "a");

    expect([...selection]).toEqual([]);
  });

  it("never mutates the selection it was given", () => {
    /* The table holds this Set in state; mutating it in place would not re-render. */
    const before = toggleSelected(EMPTY_SELECTION, "a");
    const after = toggleSelected(before, "b");

    expect([...before]).toEqual(["a"]);
    expect([...after].sort()).toEqual(["a", "b"]);
  });
});

describe("select all", () => {
  it("selects every row on the page", () => {
    expect([...toggleAll(EMPTY_SELECTION, ROWS)].sort()).toEqual(["a", "b", "c"]);
  });

  it("selects only the rows currently displayed", () => {
    /*
     * The safety rule: page two exists, and Select All must not reach it.
     * Whatever is passed here is one page, so the result can never be larger.
     */
    const page = ["a", "b"];

    expect([...toggleAll(EMPTY_SELECTION, page)].sort()).toEqual(["a", "b"]);
  });

  it("clears when everything is already selected", () => {
    const everything = toggleAll(EMPTY_SELECTION, ROWS);

    expect([...toggleAll(everything, ROWS)]).toEqual([]);
  });

  it("reports all, some or none for the three header states", () => {
    const none = EMPTY_SELECTION;
    const some = toggleSelected(EMPTY_SELECTION, "a");
    const every = toggleAll(EMPTY_SELECTION, ROWS);

    expect([allSelected(none, ROWS), someSelected(none, ROWS)]).toEqual([false, false]);
    expect([allSelected(some, ROWS), someSelected(some, ROWS)]).toEqual([false, true]);
    expect([allSelected(every, ROWS), someSelected(every, ROWS)]).toEqual([true, false]);
  });

  it("is not fully selected when there are no rows at all", () => {
    /* An empty page must not present a ticked header box. */
    expect(allSelected(EMPTY_SELECTION, [])).toBe(false);
  });
});

describe("clearing selection", () => {
  it("clears everything", () => {
    expect([...EMPTY_SELECTION]).toEqual([]);
    expect(actionableIds(EMPTY_SELECTION, ROWS)).toEqual([]);
  });
});

describe("a changed filter invalidates the selection", () => {
  const base = {
    search: undefined,
    status: undefined,
    sortBy: "createdAt",
    sortDirection: "desc",
    offset: 0,
  };

  it("changes key when the search changes", () => {
    expect(resultSetKey({ ...base, search: "netflix" })).not.toBe(resultSetKey(base));
  });

  it("changes key when the status filter changes", () => {
    expect(resultSetKey({ ...base, status: "archived" })).not.toBe(resultSetKey(base));
  });

  it("changes key when the page changes", () => {
    /* Page two shows different rows, so a tick from page one cannot survive. */
    expect(resultSetKey({ ...base, offset: 25 })).not.toBe(resultSetKey(base));
  });

  it("changes key when the sort changes", () => {
    expect(resultSetKey({ ...base, sortDirection: "asc" })).not.toBe(resultSetKey(base));
    expect(resultSetKey({ ...base, sortBy: "email" })).not.toBe(resultSetKey(base));
  });

  it("keeps the key stable when nothing relevant changed", () => {
    /* Otherwise selection would be wiped on every unrelated re-render. */
    expect(resultSetKey({ ...base })).toBe(resultSetKey(base));
  });
});

describe("only visible rows can be acted on", () => {
  it("returns the selected rows in the order they appear", () => {
    const selection = toggleAll(EMPTY_SELECTION, ["c", "a"]);

    expect(actionableIds(selection, ROWS)).toEqual(["a", "c"]);
  });

  it("drops a selected id that is no longer displayed", () => {
    /*
     * The last line of defence. If a selection ever outlived a filter change,
     * the stale id would be discarded here rather than deleted — which is the
     * difference between a bug and an unrecoverable one.
     */
    const selection = toggleSelected(EMPTY_SELECTION, "deleted-elsewhere");

    expect(actionableIds(selection, ROWS)).toEqual([]);
  });

  it("acts on the selected rows and no others", () => {
    const selection = toggleSelected(EMPTY_SELECTION, "b");

    expect(actionableIds(selection, ROWS)).toEqual(["b"]);
  });
});

describe("the selection label", () => {
  it("counts in singular and plural", () => {
    expect(selectionLabel(1)).toBe("1 account selected");
    expect(selectionLabel(3)).toBe("3 accounts selected");
  });
});

describe("deleting the selected accounts", () => {
  it("deletes exactly the ids it was given, and nothing else", async () => {
    /* Recording the ids is the assertion: nothing outside the list is touched. */
    const attempted: string[] = [];
    const deleteOne = vi.fn(async (id: string) => {
      attempted.push(id);
      return ok({});
    });

    const report = await deleteEachAccount(["a", "c"], deleteOne);

    expect(attempted).toEqual(["a", "c"]);
    expect(attempted).not.toContain("b");
    expect(report.deleted).toEqual(["a", "c"]);
    expect(report.failed).toEqual([]);
  });

  it("deletes nothing when nothing is selected", async () => {
    const deleteOne = vi.fn(async () => ok({}));

    const report = await deleteEachAccount([], deleteOne);

    expect(deleteOne).not.toHaveBeenCalled();
    expect(report.deleted).toEqual([]);
  });

  it("deletes a repeated id once", async () => {
    const deleteOne = vi.fn(async () => ok({}));

    const report = await deleteEachAccount(["a", "a", "b"], deleteOne);

    expect(deleteOne).toHaveBeenCalledTimes(2);
    expect(report.deleted).toEqual(["a", "b"]);
  });

  it("reports which accounts failed and still deletes the rest", async () => {
    /*
     * One account refused by a business rule must not strand the others. The
     * operator is told exactly which one, by its own message.
     */
    const deleteOne = vi.fn(async (id: string) =>
      id === "b"
        ? fail(new NotFoundError("gone", { userMessage: "That account no longer exists." }))
        : ok({}),
    );

    const report = await deleteEachAccount(ROWS, deleteOne);

    expect(report.deleted).toEqual(["a", "c"]);
    expect(report.failed).toEqual([{ id: "b", message: "That account no longer exists." }]);
  });

  it("keeps going after a failure rather than abandoning the batch", async () => {
    const deleteOne = vi.fn(async () => fail(new DatabaseError("pool exhausted")));

    const report = await deleteEachAccount(ROWS, deleteOne);

    expect(deleteOne).toHaveBeenCalledTimes(3);
    expect(report.deleted).toEqual([]);
    expect(report.failed.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("reports only the operator-safe message, never the technical cause", async () => {
    const deleteOne = vi.fn(async () =>
      fail(new DatabaseError("duplicate key violates constraint accounts_pkey")),
    );

    const report = await deleteEachAccount(["a"], deleteOne);

    expect(report.failed[0]?.message).not.toContain("accounts_pkey");
  });

  it("removes duplicates while preserving order", () => {
    expect(uniqueIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });
});

describe("authorization", () => {
  it("does not grant Workers permission to delete accounts", () => {
    expect(roleHasPermission(USER_ROLES.WORKER, PERMISSIONS.DELETE_ACCOUNTS)).toBe(false);
  });

  it("grants Super Admin permission to delete accounts", () => {
    expect(roleHasPermission(USER_ROLES.SUPER_ADMIN, PERMISSIONS.DELETE_ACCOUNTS)).toBe(true);
  });

  it("refuses a caller without permission before any deletion is attempted", async () => {
    /*
     * The bulk path must not become a way around the single-account gate. This
     * calls the real service: the permission check runs before the repository
     * is touched, so an unauthorized call never reaches the database.
     */
    const { accountsService } = await import("@/modules/accounts/services/accounts.service");

    const result = await accountsService.softDeleteAccounts(["a", "b"], {
      actor: {
        id: "worker-1",
        email: "worker@example.com",
        displayName: "Worker",
        initials: "W",
        role: USER_ROLES.WORKER,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("refuses when there is no signed-in user at all", async () => {
    const { accountsService } = await import("@/modules/accounts/services/accounts.service");

    const result = await accountsService.softDeleteAccounts(["a"], { actor: null });

    expect(result.ok).toBe(false);
  });
});

describe("splitting a selection by problem state", () => {
  const ROWS_WITH_STATE = [
    { id: "a", hasActiveProblem: false },
    { id: "b", hasActiveProblem: true },
    { id: "c", hasActiveProblem: false },
    { id: "d", hasActiveProblem: true },
  ];

  it("separates problem accounts from healthy ones", () => {
    const selection = toggleAll(EMPTY_SELECTION, ["a", "b", "c", "d"]);

    expect(partitionByProblem(ROWS_WITH_STATE, selection)).toEqual({
      withProblem: ["b", "d"],
      withoutProblem: ["a", "c"],
    });
  });

  it("ignores rows that are not selected", () => {
    const selection = toggleSelected(EMPTY_SELECTION, "b");

    expect(partitionByProblem(ROWS_WITH_STATE, selection)).toEqual({
      withProblem: ["b"],
      withoutProblem: [],
    });
  });

  it("offers neither action when nothing is selected", () => {
    expect(partitionByProblem(ROWS_WITH_STATE, EMPTY_SELECTION)).toEqual({
      withProblem: [],
      withoutProblem: [],
    });
  });

  it("never names an account that is not on screen", () => {
    /*
     * The rows argument is the visible page, so a stale id cannot survive into
     * either list — the same guarantee actionableIds gives the delete path.
     */
    const selection = toggleSelected(EMPTY_SELECTION, "gone-from-this-page");

    expect(partitionByProblem(ROWS_WITH_STATE, selection)).toEqual({
      withProblem: [],
      withoutProblem: [],
    });
  });

  it("puts an account in exactly one of the two lists", () => {
    /* Declaring and resolving are opposites; no account may be offered both. */
    const selection = toggleAll(EMPTY_SELECTION, ["a", "b", "c", "d"]);
    const { withProblem, withoutProblem } = partitionByProblem(ROWS_WITH_STATE, selection);

    expect(withProblem.filter((id) => withoutProblem.includes(id))).toEqual([]);
    expect(withProblem.length + withoutProblem.length).toBe(4);
  });
});
