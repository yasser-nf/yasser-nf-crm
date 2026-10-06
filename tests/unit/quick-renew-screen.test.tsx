/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RenewalResult } from "@/modules/quick-renew/services/quick-renew.service";
import type {
  RenewalPreview,
  RenewalQuoteResult,
} from "@/modules/quick-renew/services/renewal-lookup.service";

/**
 * The Quick Renew screen. M09 §20 "UI tests".
 *
 * Walks the whole flow — look up, choose a profile, read the customer, pick a
 * duration, review, confirm, succeed — and then the states that matter more
 * than the happy path: a profile that cannot be renewed is not selectable, a
 * double click confirms once, and an error never appears next to a success.
 *
 * The three Server Actions are the only things stubbed. Everything the screen
 * displays is what they returned, which is the property under test: the client
 * derives no dates and no eligibility of its own.
 */

const previewRenewalAction = vi.fn();
const quoteRenewalAction = vi.fn();
const confirmRenewalAction = vi.fn();

vi.mock("@/modules/quick-renew/actions/quick-renew.actions", () => ({
  previewRenewalAction: (input: unknown) => previewRenewalAction(input),
  quoteRenewalAction: (input: unknown) => quoteRenewalAction(input),
  confirmRenewalAction: (input: unknown) => confirmRenewalAction(input),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { QuickRenewScreen } = await import("@/modules/quick-renew/components/quick-renew-screen");

const ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PROFILE_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const CUSTOMER_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const BLOCKED_PROFILE_ID = "aaaaaaaa-0000-4000-8000-000000000004";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function profileEntry(overrides: Partial<RenewalPreview["profiles"][number]> = {}) {
  return {
    profile: {
      id: PROFILE_ID,
      accountId: ACCOUNT_ID,
      profileNumber: 2,
      profileName: "Profile 2",
      status: "sold",
      customerId: CUSTOMER_ID,
      workerId: null,
      saleDate: "2026-09-20",
      expirationDate: "2026-10-20",
      durationDays: 30,
      notes: null,
      createdAt: new Date("2026-09-20"),
      updatedAt: new Date("2026-09-20"),
    },
    state: "sold",
    customer: {
      kind: "linked",
      customer: {
        id: CUSTOMER_ID,
        label: "0663 94 71 16",
        name: null,
        whatsappUrl: "https://wa.me/213663947116",
        isArchived: false,
      },
    },
    customerStatus: "active",
    remainingDays: 19,
    hasExpired: false,
    blockedReason: null,
    ...overrides,
  } as RenewalPreview["profiles"][number];
}

function preview(overrides: Partial<RenewalPreview> = {}): RenewalPreview {
  return {
    account: {
      id: ACCOUNT_ID,
      email: "stock@example.invalid",
      status: "healthy",
      country: "DZ",
      notes: null,
      profileSlots: 5,
      validFrom: null,
      validUntil: null,
      createdBy: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      archivedAt: null,
      deletedAt: null,
    },
    effectiveStatus: "healthy",
    accountRemainingDays: null,
    problems: [],
    profiles: [profileEntry()],
    accountBlocksRenewal: false,
    ...overrides,
  } as RenewalPreview;
}

const quote: RenewalQuoteResult = {
  profileId: PROFILE_ID,
  profileNumber: 2,
  profileName: "Profile 2",
  accountId: ACCOUNT_ID,
  accountEmail: "stock@example.invalid",
  customer: {
    kind: "linked",
    customer: {
      id: CUSTOMER_ID,
      label: "0663 94 71 16",
      name: null,
      whatsappUrl: "https://wa.me/213663947116",
      isArchived: false,
    },
  },
  quote: {
    basis: "current_expiry",
    baseDate: "2026-10-20",
    previousExpirationDate: "2026-10-20",
    expirationDate: "2027-01-20",
    addedDays: 92,
    saleDate: "2026-09-20",
    durationDays: 122,
    label: "3 months",
    preset: "3_months",
    customDays: null,
  },
  accountRemainingDays: null,
};

const result: RenewalResult = {
  profileId: PROFILE_ID,
  profileNumber: 2,
  profileName: "Profile 2",
  accountId: ACCOUNT_ID,
  accountEmail: "stock@example.invalid",
  customer: quote.customer,
  previousExpirationDate: "2026-10-20",
  expirationDate: "2027-01-20",
  saleDate: "2026-09-20",
  durationDays: 122,
  addedDays: 92,
  basis: "current_expiry",
  renewalLabel: "3 months",
  replayed: false,
};

async function lookUp(email = "stock@example.invalid") {
  fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /look up/i }));
  await waitFor(() => expect(previewRenewalAction).toHaveBeenCalled());
}

async function selectProfile() {
  fireEvent.click(await screen.findByText("Profile 2"));
  await screen.findByText("Current expiry");
}

beforeEach(() => {
  previewRenewalAction.mockReset().mockResolvedValue({ ok: true, data: preview() });
  quoteRenewalAction.mockReset().mockResolvedValue({ ok: true, data: quote });
  confirmRenewalAction.mockReset().mockResolvedValue({ ok: true, data: result });
});

afterEach(cleanup);

describe("searching for an account", () => {
  it("sends the email the operator typed", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();

    expect(previewRenewalAction).toHaveBeenCalledWith({ accountEmail: "stock@example.invalid" });
    expect(await screen.findByText("stock@example.invalid")).toBeTruthy();
  });

  it("refuses an invalid address before any round trip", async () => {
    wrap(<QuickRenewScreen />);

    fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: "nonsense" } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    expect(await screen.findByText(/valid email address/i)).toBeTruthy();
    expect(previewRenewalAction).not.toHaveBeenCalled();
  });

  it("renders a server refusal on the email input", async () => {
    previewRenewalAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "No account with that email. Check the address and try again.",
      fieldErrors: { accountEmail: "No account found with this email" },
    });

    wrap(<QuickRenewScreen />);
    await lookUp("missing@example.invalid");

    expect(await screen.findByText("No account found with this email")).toBeTruthy();
  });
});

describe("choosing a profile", () => {
  it("shows the customer and the subscription as stored", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    /*
     * The identifier appears on the row and again on the subscription panel.
     * Asserted as "at least once" rather than exactly once: how many times a
     * number is repeated is layout, and pinning it would make the test fail on
     * a redesign that changed nothing about the data.
     */
    expect(screen.getAllByText("0663 94 71 16").length).toBeGreaterThan(0);
    expect(screen.getByText("2026-09-20")).toBeTruthy();
    expect(screen.getAllByText("2026-10-20").length).toBeGreaterThan(0);
    expect(screen.getByText("19 days")).toBeTruthy();
  });

  it("never shows a PIN, because the payload never carries one", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    expect(screen.queryByText(/pin/i)).toBeNull();
  });

  it("cannot select a profile the server marked unrenewable", async () => {
    previewRenewalAction.mockResolvedValue({
      ok: true,
      data: preview({
        profiles: [
          profileEntry({
            profile: {
              ...profileEntry().profile,
              id: BLOCKED_PROFILE_ID,
              profileName: "Profile 5",
            },
            blockedReason: "no_customer",
            state: "available",
            customer: { kind: "none" },
            customerStatus: null,
          }),
        ],
      }),
    });

    wrap(<QuickRenewScreen />);
    await lookUp();

    const row = (await screen.findByText("Profile 5")).closest("button");

    expect(row?.disabled).toBe(true);
    expect(screen.getByText("no customer")).toBeTruthy();
  });

  it("warns once when the account itself blocks every renewal", async () => {
    previewRenewalAction.mockResolvedValue({
      ok: true,
      data: preview({
        accountBlocksRenewal: true,
        effectiveStatus: "payment_problem",
        profiles: [profileEntry({ blockedReason: "account_unavailable", state: "blocked" })],
      }),
    });

    wrap(<QuickRenewScreen />);
    await lookUp();

    expect(await screen.findByText(/cannot serve anyone right now/i)).toBeTruthy();
    expect(screen.getByText(/Quick Replace/i)).toBeTruthy();
  });

  it("lists open problems on the account", async () => {
    previewRenewalAction.mockResolvedValue({
      ok: true,
      data: preview({
        /*
         * Only the fields this panel renders. Cast through `unknown` because an
         * `IssueRow` has a dozen columns the panel never reads, and spelling
         * them out here would assert nothing except that the fixture compiles.
         */
        problems: [
          {
            id: "iss-1",
            accountId: ACCOUNT_ID,
            issueType: "payment_problem",
            status: "open",
          },
        ] as unknown as RenewalPreview["problems"],
      }),
    });

    wrap(<QuickRenewScreen />);
    await lookUp();

    expect(await screen.findByText(/1 open problem on this account/i)).toBeTruthy();
  });
});

describe("choosing a duration", () => {
  it("quotes a preset on the server", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    await waitFor(() =>
      expect(quoteRenewalAction).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        duration: { kind: "preset", preset: "3_months" },
      }),
    );
  });

  it("quotes a valid custom day count", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.change(screen.getByLabelText(/custom number of days/i), { target: { value: "45" } });

    await waitFor(() =>
      expect(quoteRenewalAction).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        duration: { kind: "custom", days: 45 },
      }),
    );
  });

  it.each([
    ["0", /at least one day/i],
    ["-5", /whole number/i],
    ["30.5", /whole number/i],
    ["abc", /whole number/i],
    ["99999", /cannot exceed two years/i],
  ])("refuses %s without a round trip", async (typed, message) => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.change(screen.getByLabelText(/custom number of days/i), {
      target: { value: typed },
    });

    expect(await screen.findByText(message)).toBeTruthy();
    expect(quoteRenewalAction).not.toHaveBeenCalled();
  });

  it("clears a preset when a custom value is typed, so only one answer is live", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.click(screen.getByRole("button", { name: "1 month" }));
    await waitFor(() => expect(quoteRenewalAction).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/custom number of days/i), { target: { value: "45" } });

    await waitFor(() => expect(quoteRenewalAction).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "1 month" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("shows a refusal about account validity next to the duration", async () => {
    quoteRenewalAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      message:
        "This account is only valid until 2026-12-01, and the renewal would run to 2027-01-20.",
      fieldErrors: { days: "Account valid until 2026-12-01" },
    });

    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    expect(await screen.findByText("Account valid until 2026-12-01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm renewal/i })).toBeNull();
  });
});

describe("the preview before confirming", () => {
  it("states every line M09 §16 asks for", async () => {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    expect(await screen.findByText(/nothing has changed yet/i)).toBeTruthy();
    expect(screen.getByText("3 months (+92 days)")).toBeTruthy();
    expect(screen.getByText("2027-01-20")).toBeTruthy();
    expect(screen.getByText(/Counted from the current expiry/i)).toBeTruthy();
  });

  it("says the term restarts when the subscription had lapsed", async () => {
    quoteRenewalAction.mockResolvedValue({
      ok: true,
      data: {
        ...quote,
        quote: {
          ...quote.quote,
          basis: "today",
          baseDate: "2026-10-06",
          previousExpirationDate: "2026-01-31",
          expirationDate: "2027-01-06",
        },
      },
    });

    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    expect(await screen.findByText(/has lapsed, so the new term starts today/i)).toBeTruthy();
  });
});

describe("confirming", () => {
  async function reachConfirm() {
    wrap(<QuickRenewScreen />);
    await lookUp();
    await selectProfile();
    fireEvent.click(screen.getByRole("button", { name: "3 months" }));
    return screen.findByRole("button", { name: /confirm renewal/i });
  }

  it("sends the expiry it was shown, as the staleness precondition", async () => {
    const button = await reachConfirm();
    fireEvent.click(button);

    await waitFor(() => expect(confirmRenewalAction).toHaveBeenCalled());

    expect(confirmRenewalAction.mock.calls[0]?.[0]).toMatchObject({
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      customerId: CUSTOMER_ID,
      expectedExpirationDate: "2026-10-20",
      duration: { kind: "preset", preset: "3_months" },
    });
  });

  it("carries an operation id, so a repeat replays rather than renews twice", async () => {
    const button = await reachConfirm();
    fireEvent.click(button);

    await waitFor(() => expect(confirmRenewalAction).toHaveBeenCalled());

    const sent = confirmRenewalAction.mock.calls[0]?.[0] as { operationId?: string };
    expect(sent.operationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("confirms once for a double click", async () => {
    const button = await reachConfirm();

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(confirmRenewalAction).toHaveBeenCalledTimes(1));
  });

  it("shows the result and not the review", async () => {
    const button = await reachConfirm();
    fireEvent.click(button);

    expect(await screen.findByText(/renewal successful/i)).toBeTruthy();
    expect(screen.queryByText(/nothing has changed yet/i)).toBeNull();
    expect(screen.getByText("3 months (+92 days)")).toBeTruthy();
    expect(screen.getByText("2027-01-20")).toBeTruthy();
    expect(screen.getByText("2026-10-20")).toBeTruthy();
  });

  it("keeps a refusal on the review screen, never beside a success", async () => {
    confirmRenewalAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      message: "This subscription changed while you were reviewing it.",
    });

    const button = await reachConfirm();
    fireEvent.click(button);

    expect(await screen.findByText(/changed while you were reviewing it/i)).toBeTruthy();
    expect(screen.queryByText(/renewal successful/i)).toBeNull();
    /* Released, so the operator can look it up again and retry. */
    expect(screen.getByRole("button", { name: /confirm renewal/i })).toBeTruthy();
  });

  it("returns to the lookup form after a success", async () => {
    const button = await reachConfirm();
    fireEvent.click(button);

    fireEvent.click(await screen.findByRole("button", { name: /renew another/i }));

    expect(await screen.findByLabelText(/account email/i)).toBeTruthy();
    expect(screen.queryByText("stock@example.invalid")).toBeNull();
  });
});
