/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PROFILE_STATE_LABELS, PROFILE_STATE_STYLES } from "@/shared/ui/profile-state";

/**
 * The inline profiles panel on the accounts list.
 *
 * The bug this file exists to prevent is the one the brief called out by name:
 * clicking Edit on Profile 3 opening Profile 1. That happens when a panel keeps
 * "is the dialog open" rather than "which profile is being edited", so the
 * assertions below are about identity, not about whether a dialog appeared.
 *
 * `EditProfileDialog` is stubbed — it reaches for a Server Action, and what
 * matters here is which profile it is handed. That it is the SAME dialog the
 * account detail page opens is a fact about the import, asserted at the bottom.
 */

const dialogRenders: {
  profileId: string;
  profileNumber: number;
  accountId: string;
  customerLabel: string;
}[] = [];

vi.mock("@/modules/accounts/components/profile-card", () => ({
  EditProfileDialog: ({
    profile,
    accountId,
    customer,
  }: {
    profile: { id: string; profileNumber: number };
    accountId: string;
    customer: { kind: string; customer?: { label: string } };
  }) => {
    dialogRenders.push({
      profileId: profile.id,
      profileNumber: profile.profileNumber,
      accountId,
      customerLabel: customer.customer?.label ?? customer.kind,
    });

    return <div role="dialog">Edit profile {profile.profileNumber}</div>;
  },
}));

const { AccountProfilesPanel } =
  await import("@/modules/accounts/components/account-profiles-panel");

type State = keyof typeof PROFILE_STATE_LABELS;

/**
 * A link shaped exactly like `resolveProfileCustomer` returns.
 *
 * Each profile gets its OWN, with a distinguishable label, which is what lets
 * the tests below prove that Profile 3's card shows Profile 3's customer.
 */
function link(profileNumber: number, kind: "linked" | "none" | "unavailable" = "linked") {
  if (kind === "none") return { kind: "none" as const };
  if (kind === "unavailable") return { kind: "unavailable" as const, customerId: "cus-gone" };

  return {
    kind: "linked" as const,
    customer: {
      id: `cus-${profileNumber}`,
      label: `066394711${profileNumber}`,
      name: null,
      whatsappUrl: "",
      isArchived: false,
    },
  };
}

function allocation(profileNumber: number, state: State, overrides = {}) {
  const held = state !== "available" && state !== "not_for_sale";

  return {
    customer: link(profileNumber, held ? "linked" : "none"),
    profile: {
      id: `p${profileNumber}`,
      accountId: "acc-1",
      profileNumber,
      profileName: `Profile ${profileNumber}`,
      pin: `100${profileNumber}`,
      status: "sold",
      customerId: state === "available" || state === "not_for_sale" ? null : "cus-1",
      saleDate: "2026-09-01",
      expirationDate: "2026-11-30",
      durationDays: 90,
      notes: null,
      ...overrides,
    },
    isAllocatable: state === "available",
    blockedReason: state === "not_for_sale" ? "profile_not_for_sale" : null,
    validity: { remainingDays: null, requestedDays: null },
    state,
  } as unknown as Parameters<typeof AccountProfilesPanel>[0]["profiles"][number];
}

const FIVE = [
  allocation(1, "sold"),
  allocation(2, "expiring_soon"),
  allocation(3, "available"),
  allocation(4, "expired"),
  allocation(5, "not_for_sale"),
];

function renderPanel(profiles = FIVE) {
  return render(
    <AccountProfilesPanel
      id="account-profiles-acc-1"
      accountId="acc-1"
      accountEmail="one@icloud.com"
      profiles={profiles}
    />,
  );
}

beforeEach(() => {
  dialogRenders.length = 0;
});

afterEach(cleanup);

describe("what the panel shows", () => {
  it("renders exactly five profiles", () => {
    renderPanel();

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("carries the id the disclosure button points at", () => {
    const { container } = renderPanel();

    expect(container.querySelector("#account-profiles-acc-1")).not.toBeNull();
  });

  it("shows each profile's number, name and PIN", () => {
    renderPanel();

    expect(screen.getByText("Profile 3")).toBeTruthy();
    expect(screen.getByText("PIN 1003")).toBeTruthy();
  });

  it("says the PIN is not set rather than showing nothing", () => {
    renderPanel([allocation(1, "sold", { pin: null })]);

    expect(screen.getByText("PIN not set")).toBeTruthy();
  });

  it("shows sale, expiry and duration only for a held slot", () => {
    renderPanel([allocation(1, "sold"), allocation(3, "available")]);

    /* One held profile means exactly one Duration row, not two. */
    expect(screen.getAllByText("Duration")).toHaveLength(1);
    expect(screen.getAllByText("Customer")).toHaveLength(2);
  });

  it("shows a note when there is one, and omits the row when there is not", () => {
    renderPanel([allocation(1, "sold", { notes: "PIN changed" })]);

    expect(screen.getByText("PIN changed")).toBeTruthy();

    cleanup();
    renderPanel([allocation(1, "sold")]);

    expect(screen.queryByText("Notes")).toBeNull();
  });
});

describe("profile state comes from the shared vocabulary", () => {
  it("labels every state with the existing wording", () => {
    renderPanel();

    for (const state of [
      "sold",
      "expiring_soon",
      "available",
      "expired",
      "not_for_sale",
    ] as const) {
      expect(screen.getAllByText(PROFILE_STATE_LABELS[state]).length).toBeGreaterThan(0);
    }
  });

  it("paints an expiring profile with the existing caution style, not a new one", () => {
    /*
     * The panel must not invent a second colour system. The yellow it uses is
     * the one `PROFILE_STATE_STYLES` already defines for expiring_soon.
     */
    const { container } = renderPanel([allocation(2, "expiring_soon")]);
    const badge = container.querySelector("li span");

    expect(PROFILE_STATE_STYLES.expiring_soon).toContain("caution");
    expect(badge?.className).toContain("caution");
  });

  it("does not paint a healthy sold profile with the caution style", () => {
    const { container } = renderPanel([allocation(1, "sold")]);

    expect(container.querySelector("li span")?.className).toContain("success");
  });
});

describe("Edit profile opens the profile that was clicked", () => {
  it("opens nothing until a button is pressed", () => {
    renderPanel();

    expect(dialogRenders).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens Profile 1 from Profile 1's button", () => {
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 1 of one@icloud.com"));

    expect(dialogRenders.at(-1)).toMatchObject({ profileId: "p1", profileNumber: 1 });
  });

  it("opens Profile 3 from Profile 3's button", () => {
    /* The exact failure the brief names: this must not open Profile 1. */
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 3 of one@icloud.com"));

    expect(dialogRenders.at(-1)).toMatchObject({ profileId: "p3", profileNumber: 3 });
    expect(screen.getByRole("dialog").textContent).toContain("Edit profile 3");
  });

  it("switches profile rather than reopening the previous one", () => {
    /*
     * A panel holding a boolean would reopen whichever profile was selected
     * last. Holding the id is what makes the second click land on Profile 5.
     */
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 3 of one@icloud.com"));
    fireEvent.click(screen.getByLabelText("Edit profile 5 of one@icloud.com"));

    expect(dialogRenders.at(-1)).toMatchObject({ profileId: "p5", profileNumber: 5 });
  });

  it("passes the account the profile belongs to", () => {
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 2 of one@icloud.com"));

    expect(dialogRenders.at(-1)?.accountId).toBe("acc-1");
  });

  it("gives every profile its own labelled button", () => {
    renderPanel();

    for (const n of [1, 2, 3, 4, 5]) {
      expect(screen.getByLabelText(`Edit profile ${n} of one@icloud.com`)).toBeTruthy();
    }
  });
});

describe("it is the existing dialog, not a copy", () => {
  it("imports EditProfileDialog from the account detail card", async () => {
    /*
     * The stub above proves the panel renders *a* dialog. This proves it is the
     * one the detail page uses: the same module, exported rather than
     * reimplemented. A second edit form would not show up here.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/accounts/components/account-profiles-panel.tsx",
      "utf8",
    );

    expect(source).toContain('import { EditProfileDialog } from "./profile-card"');
    /* And it does not define a form of its own. */
    expect(source).not.toContain("useForm");
    expect(source).not.toContain("useUpdateProfile");
  });
});

describe("the Customer field is never blank", () => {
  it("shows the customer holding a sold profile", () => {
    renderPanel([allocation(1, "sold")]);

    expect(screen.getByText("0663947111")).toBeTruthy();
  });

  it("says No customer assigned rather than leaving the field empty", () => {
    /*
     * The requirement in one assertion. An available slot used to render "—",
     * which reads as missing data rather than as an empty slot.
     */
    renderPanel([allocation(3, "available")]);

    expect(screen.getByText(/No customer assigned/)).toBeTruthy();
  });

  it("says Customer unavailable when the record behind customer_id is gone", () => {
    const broken = {
      ...allocation(1, "sold"),
      customer: link(1, "unavailable"),
    } as unknown as Parameters<typeof AccountProfilesPanel>[0]["profiles"][number];

    renderPanel([broken]);

    expect(screen.getByText("Customer unavailable")).toBeTruthy();
  });

  it("labels the field on every card, whatever the state", () => {
    renderPanel();

    expect(screen.getAllByText("Customer")).toHaveLength(5);
  });

  it("gives two profiles on one account their own customers", () => {
    /*
     * Requirement 5: the customer belongs to the allocation, not the account.
     * Two sold slots on the same account must name two different people.
     */
    renderPanel([allocation(1, "sold"), allocation(2, "sold")]);

    expect(screen.getByText("0663947111")).toBeTruthy();
    expect(screen.getByText("0663947112")).toBeTruthy();
  });

  it("does not let an available profile inherit a neighbour's customer", () => {
    renderPanel([allocation(1, "sold"), allocation(3, "available")]);

    expect(screen.getAllByText(/No customer assigned/)).toHaveLength(1);
    expect(screen.getAllByText("0663947111")).toHaveLength(1);
  });

  it("still shows the customer of a profile whose allocation expired", () => {
    /*
     * An expired slot is allocatable again, but the person who bought it is
     * still recorded on it. Blanking the field would lose that.
     */
    renderPanel([allocation(4, "expired")]);

    expect(screen.getByText("0663947114")).toBeTruthy();
  });
});

describe("Edit profile opens that profile's customer", () => {
  it("hands Profile 3's dialog Profile 3's customer", () => {
    /* Requirement 4, and the exact confusion the brief names. */
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 3 of one@icloud.com"));

    expect(dialogRenders.at(-1)).toMatchObject({
      profileNumber: 3,
      customerLabel: "none",
    });
  });

  it("does not carry Profile 1's customer into Profile 2's dialog", () => {
    renderPanel();

    fireEvent.click(screen.getByLabelText("Edit profile 1 of one@icloud.com"));
    expect(dialogRenders.at(-1)?.customerLabel).toBe("0663947111");

    fireEvent.click(screen.getByLabelText("Edit profile 2 of one@icloud.com"));
    expect(dialogRenders.at(-1)?.customerLabel).toBe("0663947112");
  });

  it("tells the dialog there is no customer on a free slot", () => {
    renderPanel([allocation(3, "available")]);

    fireEvent.click(screen.getByLabelText("Edit profile 3 of one@icloud.com"));

    expect(dialogRenders.at(-1)?.customerLabel).toBe("none");
  });
});
