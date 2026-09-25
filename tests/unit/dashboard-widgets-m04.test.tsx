/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import {
  AccountsWidget,
  ChartsWidget,
  ExpirationWidget,
  OnlineUsersWidget,
  ProblemsCountsWidget,
  ProblemsListWidget,
  ProfilesWidget,
  ReopenedWidget,
  UsersCountsWidget,
} from "@/modules/dashboard/components/dashboard-widgets";

/**
 * Dashboard widgets (M04): what each card says, and — as much — what it must
 * not say. A failed read is an error, never an empty chart or "no problems";
 * a figure that could not be read is a dash, never a zero.
 */

afterEach(cleanup);

/** The value rendered under a metric label. */
function metric(label: string): string {
  const labelNode = screen.getByText(label, { selector: "span" });
  return labelNode.nextElementSibling?.textContent ?? "";
}

describe("KPI cards", () => {
  it("Accounts shows the four disjoint buckets and their total", () => {
    render(
      <AccountsWidget counts={{ total: 21, healthy: 16, problems: 4, expired: 0, archived: 1 }} />,
    );

    expect(metric("Total")).toBe("21");
    expect(metric("Healthy")).toBe("16");
    expect(metric("Problems")).toBe("4");
    expect(metric("Expired")).toBe("0");
    expect(metric("Archived")).toBe("1");
    expect(screen.getByText("Healthy + Problems + Expired + Archived = Total")).toBeTruthy();
  });

  it("Profiles shows every state, including Blocked and Not for sale, and no Reserved", () => {
    render(
      <ProfilesWidget
        counts={{
          total: 130,
          available: 19,
          sold: 40,
          expiringSoon: 6,
          expired: 10,
          blocked: 50,
          notForSale: 5,
          resellableExpired: 2,
        }}
      />,
    );

    expect(metric("Available")).toBe("19");
    expect(metric("Blocked")).toBe("50");
    expect(metric("Not for sale")).toBe("5");
    expect(screen.queryByText("Reserved")).toBeNull();
    expect(screen.getByText("2 can be resold")).toBeTruthy();
  });

  it("Problems separates problem records from the accounts they affect", () => {
    render(
      <ProblemsCountsWidget
        counts={{
          open: 5,
          waiting: 1,
          inProgress: 0,
          blocking: 6,
          accountsAffected: 4,
          paymentProblems: 3,
          paymentProblemAccounts: 2,
          resolvedToday: 1,
          critical: 0,
        }}
      />,
    );

    expect(metric("Blocking")).toBe("6");
    expect(screen.getByText("on 4 accounts")).toBeTruthy();
    expect(metric("Payment problems")).toBe("3");
    expect(screen.getByText("on 2 accounts")).toBeTruthy();
  });

  it("Expirations names disjoint windows", () => {
    render(
      <ExpirationWidget
        counts={{ expired: 2, today: 1, tomorrow: 0, inTwoToThree: 3, inFourToSeven: 4 }}
      />,
    );

    expect(metric("In 2–3 days")).toBe("3");
    expect(metric("In 4–7 days")).toBe("4");
    expect(screen.queryByText("Within 3 days")).toBeNull();
  });

  it("Expirations says so when nothing is due — a real empty state", () => {
    render(
      <ExpirationWidget
        counts={{ expired: 0, today: 0, tomorrow: 0, inTwoToThree: 0, inFourToSeven: 0 }}
      />,
    );

    expect(screen.getByText("No profiles are approaching expiry.")).toBeTruthy();
  });

  it("zero is shown as zero, not hidden", () => {
    render(
      <AccountsWidget counts={{ total: 0, healthy: 0, problems: 0, expired: 0, archived: 0 }} />,
    );

    expect(metric("Healthy")).toBe("0");
  });
});

describe("failed reads are errors, not empty data", () => {
  it("a failed chart reads 'Could not load', not 'No activity'", () => {
    render(
      <ChartsWidget
        accounts={null}
        customers={[]}
        types={null}
        severity={[]}
        backups={null}
        canSeeBackups
      />,
    );

    expect(screen.getAllByRole("alert").length).toBe(3);
    expect(screen.getAllByText(/Could not load this/).length).toBe(3);
    /* The chart that loaded with no data still says so, as an empty state. */
    expect(screen.getByText("No activity in this period yet.")).toBeTruthy();
  });

  it("a failed problem list is not 'No problems have been reported'", () => {
    render(
      <ProblemsListWidget
        title="Newest problems"
        items={null}
        emptyMessage="No problems have been reported."
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(/Could not load/);
    expect(screen.queryByText("No problems have been reported.")).toBeNull();
  });

  it("a genuinely empty problem list keeps its empty message", () => {
    render(
      <ProblemsListWidget
        title="Newest"
        items={[]}
        emptyMessage="No problems have been reported."
      />,
    );

    expect(screen.getByText("No problems have been reported.")).toBeTruthy();
  });

  it("a failed reopened list and online list say they failed", () => {
    render(
      <>
        <ReopenedWidget items={null} />
        <OnlineUsersWidget users="error" />
      </>,
    );

    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("Not available to your role.")).toBeNull();
  });

  it("an unreadable online count is a dash, never 0", () => {
    render(<UsersCountsWidget counts={{ active: 3, suspended: 0, disabled: 0 }} online={null} />);

    expect(metric("Online")).toBe("—");
  });
});

describe("problem lists show the problem, not the retired severity", () => {
  it("names the problem type beside its status", () => {
    const entry = {
      problem: {
        id: "p1",
        accountId: "a1",
        issueType: "payment_problem",
        status: "open",
        severity: "critical",
      },
      accountEmail: "one@icloud.com",
    } as unknown as Parameters<typeof ProblemsListWidget>[0]["items"] extends
      readonly (infer E)[] | null
      ? E
      : never;

    render(<ProblemsListWidget title="Newest" items={[entry]} emptyMessage="" />);
    const row = screen.getByRole("link");

    expect(within(row).getByText("Payment problem")).toBeTruthy();
    expect(within(row).queryByText("Critical")).toBeNull();
  });
});
