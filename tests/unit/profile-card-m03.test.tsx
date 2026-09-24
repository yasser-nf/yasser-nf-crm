/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The account page's profile card and its editor (M03).
 *
 * The badge reads the derived state, the note is shown, an account-level block
 * is explained, and the editor sends only what changed — a note can be cleared,
 * and a note edit is never mistaken for an allocation change.
 */

const updateProfileAction = vi.fn();

vi.mock("@/modules/accounts/actions/account.actions", () => ({
  updateProfileAction: (accountId: string, profileId: string, input: unknown) =>
    updateProfileAction(accountId, profileId, input),
  unassignSaleAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ProfileCard } = await import("@/modules/accounts/components/profile-card");

type Allocation = Parameters<typeof ProfileCard>[0]["allocation"];

function allocation(overrides: Partial<Record<string, unknown>> = {}, profile = {}): Allocation {
  return {
    profile: {
      id: "p3",
      accountId: "acc-1",
      profileNumber: 3,
      profileName: "Kids",
      pin: "1234",
      status: "sold",
      customerId: "cus-1",
      workerId: null,
      saleDate: "2026-09-01",
      expirationDate: "2026-10-01",
      durationDays: 30,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...profile,
    },
    customer: {
      kind: "linked",
      customer: {
        id: "cus-1",
        label: "0663 94 71 16",
        name: null,
        whatsappUrl: "https://wa.me/213663947116",
        isArchived: false,
      },
    },
    isAllocatable: false,
    blockedReason: "profile_not_available",
    validity: { remainingDays: null, requestedDays: null },
    state: "sold",
    ...overrides,
  } as unknown as Allocation;
}

function renderCard(value: Allocation) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProfileCard allocation={value} accountId="acc-1" index={0} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateProfileAction.mockReset().mockResolvedValue({ ok: true, data: {} });
});

afterEach(cleanup);

describe("the card says what the rest of the app says", () => {
  it("labels a free slot on a problem account as blocked, not Available", () => {
    renderCard(
      allocation(
        { state: "blocked", blockedReason: "account_has_problem" },
        { status: "available", customerId: null, saleDate: null, expirationDate: null },
      ),
    );

    expect(screen.getByText("Blocked by account")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.getByText(/Blocked by an open problem on this account/)).toBeTruthy();
  });

  it("labels a lapsed sale as expired, not Sold", () => {
    renderCard(allocation({ state: "expired" }));

    expect(screen.getByText("Expired allocation")).toBeTruthy();
  });

  it("keeps a sold slot sold on a problem account, with no blocked notice", () => {
    renderCard(allocation({ state: "sold", blockedReason: "account_has_problem" }));

    expect(screen.getByText("Sold, active")).toBeTruthy();
    expect(screen.queryByText(/Blocked by an open problem/)).toBeNull();
  });

  it("shows the profile's own note, labelled as a profile note", () => {
    renderCard(allocation({}, { notes: "Prefers the Kids profile." }));

    expect(screen.getByText("Profile note")).toBeTruthy();
    expect(screen.getByText("Prefers the Kids profile.")).toBeTruthy();
  });

  it("shows no note block when there is no note", () => {
    renderCard(allocation());

    expect(screen.queryByText("Profile note")).toBeNull();
  });
});

describe("the editor opens this profile and sends only what changed", () => {
  function openEditor(value = allocation({}, { notes: "Old note" })) {
    renderCard(value);
    fireEvent.click(screen.getByRole("button", { name: /Edit profile/ }));
    return screen.getByRole("dialog");
  }

  it("19. opens the editor for this exact profile", () => {
    const dialog = openEditor();

    expect(dialog.textContent).toContain("Edit profile 3");
  });

  it("clears a note by sending an empty one", async () => {
    openEditor();

    fireEvent.change(screen.getByPlaceholderText("Anything worth remembering about this profile"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateProfileAction).toHaveBeenCalledTimes(1));
    expect(updateProfileAction).toHaveBeenCalledWith("acc-1", "p3", { notes: "" });
  });

  it("a note edit sends the note alone — no sale date, no duration", async () => {
    openEditor();

    fireEvent.change(screen.getByPlaceholderText("Anything worth remembering about this profile"), {
      target: { value: "New note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateProfileAction).toHaveBeenCalledTimes(1));
    expect(updateProfileAction.mock.calls[0]?.[2]).toEqual({ notes: "New note" });
  });

  it("saving with nothing changed writes nothing", async () => {
    openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateProfileAction).not.toHaveBeenCalled();
  });

  it("recalculates the displayed expiration as the duration changes", () => {
    openEditor();

    const expiry = screen.getByLabelText("Expiration date") as HTMLInputElement;
    expect(expiry.value).toBe("2026-10-01");

    fireEvent.change(screen.getByLabelText("Duration (days)"), { target: { value: "60" } });
    expect(expiry.value).toBe("2026-10-31");

    fireEvent.change(screen.getByLabelText("Sale date"), { target: { value: "2026-09-11" } });
    expect(expiry.value).toBe("2026-11-10");
  });

  it("shows the stored expiration for a profile with no duration, as the server keeps it", () => {
    openEditor(allocation({}, { durationDays: null, expirationDate: "2026-12-31" }));

    expect((screen.getByLabelText("Expiration date") as HTMLInputElement).value).toBe("2026-12-31");
  });
});
