/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Selection and the bulk toolbar on the Problems page (M03).
 *
 * Selection is by problem id, page-only, and cleared by any change to the
 * query string. The toolbar offers Resolve, Assign and Delete as the viewer's
 * role allows, sends exactly the selected ids, and reports what happened.
 */

const resolveProblemsAction = vi.fn();
const assignProblemsAction = vi.fn();
const deleteProblemsAction = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();

vi.mock("@/modules/problems/actions/problem.actions", () => ({
  resolveProblemsAction: (ids: unknown, input: unknown) => resolveProblemsAction(ids, input),
  assignProblemsAction: (ids: unknown, input: unknown) => assignProblemsAction(ids, input),
  deleteProblemsAction: (ids: unknown) => deleteProblemsAction(ids),
}));

let query = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/problems",
  useSearchParams: () => query,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    warning: (m: string) => toastWarning(m),
    error: vi.fn(),
  },
}));

const { ProblemsTable } = await import("@/modules/problems/components/problems-table");
const { describeOutcome } = await import("@/modules/problems/components/problems-bulk-bar");

type Entry = Parameters<typeof ProblemsTable>[0]["items"][number];

function entry(id: string, status: string, accountId = "acc-1"): Entry {
  return {
    problem: {
      id,
      accountId,
      issueType: "payment_problem",
      status,
      severity: "medium",
      description: "",
      assignedTo: null,
      reportedBy: null,
      resolvedBy: null,
      resolutionNote: null,
      reopenCount: 0,
      createdAt: new Date("2026-09-20T10:00:00Z"),
      updatedAt: new Date("2026-09-20T10:00:00Z"),
      resolvedAt: null,
      closedAt: null,
    },
    /* Two problems on one account: selection must still tell them apart. */
    accountEmail: `${accountId}@icloud.com`,
    accountStatus: "healthy",
    assignedToName: null,
    reportedByName: null,
  } as unknown as Entry;
}

const ITEMS = [entry("p1", "open"), entry("p2", "waiting"), entry("p3", "resolved")];

function Table({
  items = ITEMS,
  canAssign = true,
  canDelete = true,
}: {
  items?: Entry[];
  canAssign?: boolean;
  canDelete?: boolean;
}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  return (
    <QueryClientProvider client={client}>
      <ProblemsTable
        items={items}
        total={items.length}
        limit={25}
        offset={0}
        assignees={[{ id: "w-1", name: "Amina" }]}
        canAssign={canAssign}
        canDelete={canDelete}
      />
    </QueryClientProvider>
  );
}

/** The desktop row checkbox for a problem id (mobile cards carry a twin). */
function rowBox(index: number): HTMLElement {
  return screen.getAllByRole("checkbox", { name: /Select Payment problem on/ })[index]!;
}

function selectAll() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all problems on this page" }));
}

function barLabel(): string | null {
  return screen.queryByText(/problems? selected/)?.textContent ?? null;
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  query = new URLSearchParams();
  for (const m of [
    resolveProblemsAction,
    assignProblemsAction,
    deleteProblemsAction,
    toastSuccess,
    toastWarning,
  ]) {
    m.mockReset();
  }
  const outcome = { ok: true, data: { succeeded: ["p1"], skipped: [], failed: [] } };
  resolveProblemsAction.mockResolvedValue(outcome);
  assignProblemsAction.mockResolvedValue(outcome);
  deleteProblemsAction.mockResolvedValue(outcome);
});

afterEach(cleanup);

describe("selection", () => {
  it("shows no toolbar until something is selected", () => {
    render(<Table />);
    expect(barLabel()).toBeNull();
  });

  it("1. selects one problem", () => {
    render(<Table />);
    fireEvent.click(rowBox(0));
    expect(barLabel()).toBe("1 problem selected");
  });

  it("2. selects several problems on the same account, by problem id", () => {
    render(<Table />);
    fireEvent.click(rowBox(0));
    fireEvent.click(rowBox(1));
    expect(barLabel()).toBe("2 problems selected");
  });

  it("3. selects every visible problem, and deselects one", () => {
    render(<Table />);
    selectAll();
    expect(barLabel()).toBe("3 problems selected");

    fireEvent.click(rowBox(2));
    expect(barLabel()).toBe("2 problems selected");
  });

  it("4. Clear selection empties it", () => {
    render(<Table />);
    selectAll();
    fireEvent.click(button(/Clear selection/));
    expect(barLabel()).toBeNull();
  });

  it("says the selection is this page only", () => {
    render(<Table />);
    fireEvent.click(rowBox(0));
    expect(screen.getByText(/On this page only/)).toBeTruthy();
  });

  it.each([
    ["5. a filter", "status=open"],
    ["5. a type filter", "type=payment_problem"],
    ["5. an assignee filter", "assignedTo=w-1"],
    ["5. a date filter", "from=2026-09-01"],
    ["6. the search", "search=icloud"],
    ["7. the page", "offset=25"],
    ["a sort", "sortBy=status&dir=asc"],
  ])("changing %s clears the selection", (_label, next) => {
    const view = render(<Table />);
    selectAll();
    expect(barLabel()).toBe("3 problems selected");

    query = new URLSearchParams(next);
    view.rerender(<Table />);

    expect(barLabel()).toBeNull();
  });
});

describe("the toolbar", () => {
  it("offers Resolve, Assign, Delete and Clear selection to a Super Admin", () => {
    render(<Table />);
    fireEvent.click(rowBox(0));

    for (const name of [/^Resolve$/, /^Assign$/, /^Delete$/, /Clear selection/]) {
      expect(button(name)).toBeTruthy();
    }
  });

  it("offers no Assign or Delete to a role that may not", () => {
    render(<Table canAssign={false} canDelete={false} />);
    fireEvent.click(rowBox(0));

    expect(screen.queryByRole("button", { name: /^Assign$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
  });

  it("10. disables Resolve when every selected problem is already finished", () => {
    render(<Table />);
    fireEvent.click(rowBox(2));

    expect(button(/^Resolve$/).hasAttribute("disabled")).toBe(true);
  });

  it("9. resolves exactly the selected ids, with the required note", async () => {
    render(<Table />);
    fireEvent.click(rowBox(0));
    fireEvent.click(rowBox(1));
    fireEvent.click(button(/^Resolve$/));

    const confirm = button("Resolve problems");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("How it was resolved"), {
      target: { value: "Payment method updated." },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(resolveProblemsAction).toHaveBeenCalledTimes(1));
    expect(resolveProblemsAction).toHaveBeenCalledWith(["p1", "p2"], {
      resolutionNote: "Payment method updated.",
    });
  });

  it("says a mixed selection's finished problems will be skipped, not reopened", () => {
    render(<Table />);
    selectAll();
    fireEvent.click(button(/^Resolve$/));

    expect(screen.getByRole("dialog").textContent).toContain(
      "1 selected problem is already finished and will be skipped, not reopened.",
    );
  });

  it("20. assigns the selected problems to the chosen person", async () => {
    render(<Table />);
    selectAll();
    fireEvent.click(button(/^Assign$/));
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: "w-1" } });
    fireEvent.click(button("Assign to Amina"));

    await waitFor(() => expect(assignProblemsAction).toHaveBeenCalledTimes(1));
    expect(assignProblemsAction).toHaveBeenCalledWith(["p1", "p2", "p3"], { assignedTo: "w-1" });
  });

  it("16. will not delete until the operator acknowledges it", async () => {
    render(<Table />);
    fireEvent.click(rowBox(0));
    fireEvent.click(rowBox(1));
    fireEvent.click(button(/^Delete$/));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete 2 problems?");
    expect(dialog.textContent).toContain("This affects all 2 selected problem records.");
    expect(dialog.textContent).toContain("are not touched");

    const confirm = button("Delete 2 problems");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(deleteProblemsAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I understand 2 problems/ }));
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteProblemsAction).toHaveBeenCalledWith(["p1", "p2"]));
  });
});

describe("what the operator is told", () => {
  it("counts a clean run", () => {
    expect(describeOutcome("resolved", { succeeded: ["a", "b"], skipped: [], failed: [] })).toBe(
      "2 problems resolved.",
    );
  });

  it("names skipped and failed problems separately", () => {
    expect(
      describeOutcome("resolved", {
        succeeded: ["a", "b", "c"],
        skipped: [{ id: "d", reason: "Already closed." }],
        failed: [],
      }),
    ).toBe("3 resolved, 1 skipped (Already closed.).");

    expect(
      describeOutcome("resolved", {
        succeeded: ["a"],
        skipped: [],
        failed: [{ id: "b", message: "You can only work on problems assigned to you." }],
      }),
    ).toBe("1 resolved, 1 failed: You can only work on problems assigned to you.");
  });

  it("warns rather than celebrates when something failed", async () => {
    resolveProblemsAction.mockResolvedValue({
      ok: true,
      data: { succeeded: [], skipped: [], failed: [{ id: "p1", message: "Not yours." }] },
    });

    render(<Table />);
    fireEvent.click(rowBox(0));
    fireEvent.click(button(/^Resolve$/));
    fireEvent.change(screen.getByLabelText("How it was resolved"), {
      target: { value: "Tried to fix it." },
    });
    fireEvent.click(button("Resolve problems"));

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
