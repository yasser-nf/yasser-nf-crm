/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The simplified Problems UI (M03).
 *
 * Account and problem, whether it is blocking, and the way to the account —
 * no severity and no "What happened" anywhere a problem is reported or shown.
 * The columns still exist; these assert what the screens offer.
 */

const reportProblemAction = vi.fn();

vi.mock("@/modules/problems/actions/problem.actions", () => ({
  reportProblemAction: (input: unknown) => reportProblemAction(input),
  addProblemNoteAction: vi.fn(),
  assignProblemAction: vi.fn(),
  cancelProblemAction: vi.fn(),
  claimProblemAction: vi.fn(),
  closeProblemAction: vi.fn(),
  reopenProblemAction: vi.fn(),
  resolveProblemAction: vi.fn(),
  updateProblemAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/problems",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ReportProblemDialog } = await import("@/modules/problems/components/report-problem-dialog");
const { ProblemsTable, ProblemsFilters } =
  await import("@/modules/problems/components/problems-table");
const { ProblemDetailView } = await import("@/modules/problems/components/problem-detail");

type Entry = Parameters<typeof ProblemsTable>[0]["items"][number];

function entry(id: string, status: string, overrides = {}): Entry {
  return {
    problem: {
      id,
      accountId: `acc-${id}`,
      issueType: "payment_problem",
      status,
      severity: "critical",
      description: "An old free-text description nobody needs on screen",
      assignedTo: null,
      reportedBy: null,
      resolvedBy: null,
      resolutionNote: status === "resolved" ? "Paid." : null,
      reopenCount: 0,
      createdAt: new Date("2026-09-20T10:00:00Z"),
      updatedAt: new Date("2026-09-20T10:00:00Z"),
      resolvedAt: status === "resolved" ? new Date("2026-09-21T10:00:00Z") : null,
      closedAt: null,
      ...overrides,
    },
    accountEmail: `${id}@icloud.com`,
    accountStatus: "healthy",
    assignedToName: null,
    reportedByName: null,
  } as unknown as Entry;
}

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  reportProblemAction.mockReset().mockResolvedValue({ ok: true, data: { id: "new" } });
});

afterEach(cleanup);

describe("reporting a problem asks for the type, and nothing else", () => {
  it("offers Problem type, and no Severity or What happened", () => {
    withClient(<ReportProblemDialog accountId="acc-1" accountEmail="one@icloud.com" />);
    fireEvent.click(screen.getByRole("button", { name: /Report problem/ }));

    expect(screen.getByText("Problem type")).toBeTruthy();
    expect(screen.queryByText("Severity")).toBeNull();
    expect(screen.queryByText("What happened")).toBeNull();
  });

  it("submits the account, the type and the assignment choice", async () => {
    withClient(<ReportProblemDialog accountId="acc-1" accountEmail="one@icloud.com" />);
    fireEvent.click(screen.getByRole("button", { name: /Report problem/ }));
    fireEvent.click(screen.getByRole("button", { name: /Report problem/ }));

    await waitFor(() => expect(reportProblemAction).toHaveBeenCalledTimes(1));
    expect(reportProblemAction).toHaveBeenCalledWith({
      accountId: "acc-1",
      issueType: "something_went_wrong",
      assignToMe: false,
    });
  });
});

describe("the Problems list", () => {
  const items = [entry("a", "open"), entry("b", "waiting"), entry("c", "resolved")];

  it("says for each problem whether it is blocking, by the lifecycle rule", () => {
    render(<ProblemsTable items={items} total={3} limit={25} offset={0} />);
    const table = screen.getByRole("table");

    expect(within(table).getAllByText("Blocking")).toHaveLength(3); /* header + a + b */
    expect(within(table).getAllByText("Not blocking")).toHaveLength(1);
  });

  it("shows no severity and no description", () => {
    render(<ProblemsTable items={items} total={3} limit={25} offset={0} />);

    expect(screen.queryByText("Severity")).toBeNull();
    expect(screen.queryByText("Critical")).toBeNull();
    expect(screen.queryByText(/free-text description/)).toBeNull();
  });

  it("links each row to its account and to its problem", () => {
    render(<ProblemsTable items={items} total={3} limit={25} offset={0} />);
    const table = screen.getByRole("table");

    expect(within(table).getByRole("link", { name: "a@icloud.com" }).getAttribute("href")).toBe(
      "/accounts/acc-a",
    );
    expect(
      within(table).getAllByRole("link", { name: "Payment problem" })[0]?.getAttribute("href"),
    ).toBe("/problems/a");
  });

  it("filters by 'Blocking now', and has no severity filter", () => {
    render(<ProblemsFilters workers={[]} />);

    expect(screen.getByRole("option", { name: "Blocking now" })).toBeTruthy();
    expect(screen.queryByLabelText("Filter by severity")).toBeNull();
  });
});

describe("the problem detail", () => {
  const viewer = { id: "admin-1", isSuperAdmin: true };

  it("says an open problem blocks the account, and links to it", () => {
    withClient(<ProblemDetailView entry={entry("a", "open")} timeline={[]} viewer={viewer} />);

    expect(screen.getByText("Yes — the account cannot sell")).toBeTruthy();
    expect(screen.getByText(/all five profiles on this\s+account are blocked/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "a@icloud.com" }).getAttribute("href")).toBe(
      "/accounts/acc-a",
    );
  });

  it("does not claim a resolved problem is still blocking", () => {
    withClient(<ProblemDetailView entry={entry("c", "resolved")} timeline={[]} viewer={viewer} />);

    expect(screen.getByText("No")).toBeTruthy();
    expect(screen.getByText(/no longer blocks the account/)).toBeTruthy();
    expect(screen.queryByText(/all five profiles on this/)).toBeNull();
  });

  it("leads with the account and the problem — no severity, no description", () => {
    withClient(<ProblemDetailView entry={entry("a", "open")} timeline={[]} viewer={viewer} />);

    expect(screen.queryByText("Critical")).toBeNull();
    expect(screen.queryByText(/free-text description/)).toBeNull();
    /* The stored account column is not shown as if it were the account's state. */
    expect(screen.queryByText("Account status")).toBeNull();
  });
});
