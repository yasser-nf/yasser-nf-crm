/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { buildWhatsAppLink, whatsappDestination } from "@/lib/whatsapp";
import { resolveProfileCustomer } from "@/modules/accounts/services/profile-customer";
import type { CustomerRow } from "@/lib/drizzle/schema";

/**
 * The two quick actions on a profile card's Customer line.
 *
 * They exist to avoid the Edit Profile dialog, so the assertion that matters
 * most is the negative one: clicking either must not open it. The rest is about
 * identity — five cards side by side, and each action acting on its own card's
 * customer rather than a neighbour's.
 */

const copyToClipboard = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

/* Only the write is stubbed. @/lib/whatsapp builds its message from this
   module, so replacing it wholesale would break the flow under test. */
vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string, o?: unknown) => toastError(m, o),
  },
}));

const { ProfileCustomerLine } = await import("@/modules/accounts/components/profile-customer-line");

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: "cus-1",
    name: null,
    phoneOriginal: "0663947116",
    phoneNormalized: "663947116",
    whatsappUrl: "https://wa.me/213663947116",
    notes: null,
    firstPurchaseAt: null,
    lastPurchaseAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    blockedAt: null,
    ...overrides,
  } as CustomerRow;
}

function renderLine(link = resolveProfileCustomer("cus-1", customer())) {
  return render(
    <dl>
      <ProfileCustomerLine customer={link} />
    </dl>,
  );
}

beforeEach(() => {
  copyToClipboard.mockReset().mockResolvedValue(true);
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(cleanup);

describe("fast copy", () => {
  it("copies the identifier that is on screen", async () => {
    renderLine();

    fireEvent.click(screen.getByLabelText("Copy customer 0663 94 71 16"));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("0663 94 71 16"));
  });

  it("confirms with a toast rather than a dialog", async () => {
    renderLine();

    fireEvent.click(screen.getByLabelText("Copy customer 0663 94 71 16"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Customer copied"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("turns the icon into a tick once the write succeeds", async () => {
    renderLine();
    const button = screen.getByLabelText("Copy customer 0663 94 71 16");

    expect(button.className).not.toContain("text-success");

    fireEvent.click(button);

    await waitFor(() => expect(button.className).toContain("text-success"));
  });

  it("reports a blocked clipboard instead of claiming success", async () => {
    copyToClipboard.mockResolvedValue(false);
    renderLine();

    fireEvent.click(screen.getByLabelText("Copy customer 0663 94 71 16"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("offers no copy button when the slot has no customer", () => {
    /* Requirement: never expose customer controls for an unheld profile. */
    renderLine(resolveProfileCustomer(null, null));

    expect(screen.queryByLabelText(/^Copy customer/)).toBeNull();
    expect(screen.getByText(/No customer assigned/)).toBeTruthy();
  });

  it("offers no copy button when the customer record is missing", () => {
    renderLine(resolveProfileCustomer("cus-gone", null));

    expect(screen.queryByLabelText(/^Copy customer/)).toBeNull();
    expect(screen.getByText("Customer unavailable")).toBeTruthy();
  });
});

describe("open WhatsApp", () => {
  it("links to the normalized Algerian number", () => {
    renderLine();

    const link = screen.getByLabelText("Open WhatsApp with 0663 94 71 16");

    expect(link.getAttribute("href")).toBe("https://wa.me/213663947116");
  });

  it("opens in a new tab, safely", () => {
    renderLine();
    const link = screen.getByLabelText("Open WhatsApp with 0663 94 71 16");

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("says WhatsApp unavailable for a username instead of linking", () => {
    /* wa.me addresses a number. A handle has no address, and never will. */
    renderLine(resolveProfileCustomer("cus-1", customer({ phoneNormalized: "@yasser" })));

    expect(screen.getByText("WhatsApp unavailable")).toBeTruthy();
    expect(screen.queryByLabelText(/^Open WhatsApp/)).toBeNull();
  });

  it("says WhatsApp unavailable for a number wa.me cannot address", () => {
    renderLine(resolveProfileCustomer("cus-1", customer({ phoneNormalized: "123" })));

    expect(screen.getByText("WhatsApp unavailable")).toBeTruthy();
  });

  it("still links a stored international key", () => {
    /* The Qatari case the destination builder was fixed for. */
    renderLine(resolveProfileCustomer("cus-1", customer({ phoneNormalized: "97471601974" })));

    expect(screen.getByLabelText(/^Open WhatsApp/).getAttribute("href")).toBe(
      "https://wa.me/97471601974",
    );
  });

  it("shows no WhatsApp control at all for an unheld slot", () => {
    renderLine(resolveProfileCustomer(null, null));

    expect(screen.queryByLabelText(/^Open WhatsApp/)).toBeNull();
    expect(screen.queryByText("WhatsApp unavailable")).toBeNull();
  });
});

describe("the actions are not the edit dialog", () => {
  it("opens no dialog and does not bubble to the card", () => {
    /*
     * The card is clickable in context. If either action bubbled, the fast path
     * would open the very dialog it exists to avoid.
     */
    const onCardClick = vi.fn();

    render(
      <dl onClick={onCardClick}>
        <ProfileCustomerLine customer={resolveProfileCustomer("cus-1", customer())} />
      </dl>,
    );

    fireEvent.click(screen.getByLabelText("Copy customer 0663 94 71 16"));
    fireEvent.click(screen.getByLabelText("Open WhatsApp with 0663 94 71 16"));

    expect(onCardClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives both actions an accessible name and a tooltip", () => {
    renderLine();

    expect(screen.getByLabelText("Copy customer 0663 94 71 16").getAttribute("title")).toBe(
      "Copy 0663 94 71 16",
    );
    expect(screen.getByLabelText("Open WhatsApp with 0663 94 71 16").getAttribute("title")).toBe(
      "Open WhatsApp with 0663 94 71 16",
    );
  });
});

describe("each card acts on its own customer", () => {
  it("keeps Profile 1's and Profile 3's actions apart", () => {
    /*
     * Two lines rendered together, as five are on an expanded account. Each
     * button carries its own customer in its accessible name and its href, so
     * neither can act on the other's number.
     */
    render(
      <dl>
        <ProfileCustomerLine
          customer={resolveProfileCustomer(
            "cus-1",
            customer({ id: "cus-1", phoneNormalized: "663947116" }),
          )}
        />
        <ProfileCustomerLine
          customer={resolveProfileCustomer(
            "cus-3",
            customer({ id: "cus-3", phoneNormalized: "552327768" }),
          )}
        />
      </dl>,
    );

    fireEvent.click(screen.getByLabelText("Copy customer 0552 32 77 68"));

    expect(copyToClipboard).toHaveBeenCalledWith("0552 32 77 68");
    expect(copyToClipboard).not.toHaveBeenCalledWith("0663 94 71 16");

    expect(screen.getByLabelText("Open WhatsApp with 0663 94 71 16").getAttribute("href")).toBe(
      "https://wa.me/213663947116",
    );
    expect(screen.getByLabelText("Open WhatsApp with 0552 32 77 68").getAttribute("href")).toBe(
      "https://wa.me/213552327768",
    );
  });
});

describe("Quick Prepare and Quick Replace are untouched", () => {
  it("builds a credential link exactly as before", () => {
    /*
     * The card's action reuses `whatsappDestination`; it did not change how
     * `buildWhatsAppLink` behaves. This asserts the credential flow still
     * produces a URL with its prefilled message intact.
     */
    const link = buildWhatsAppLink({
      identifier: "0663947116",
      accounts: [
        {
          email: "one@icloud.com",
          password: "secret",
          profiles: [{ profileNumber: 1, pin: "1234" }],
        },
      ],
      expirationDate: "2026-10-02",
      durationDays: 30,
    });

    expect(link.available).toBe(true);
    if (link.available) {
      expect(link.url.startsWith("https://wa.me/213663947116?text=")).toBe(true);
      expect(link.message.length).toBeGreaterThan(0);
    }
  });

  it("still refuses a username with the same reason", () => {
    const link = buildWhatsAppLink({
      identifier: "@yasser",
      accounts: [],
      expirationDate: "2026-10-02",
      durationDays: 30,
    });

    expect(link).toEqual({ available: false, reason: "username" });
  });

  it("builds the card's URL from the same function the message flow uses", () => {
    /*
     * One normalisation, two callers. If these ever disagreed, a number would
     * work in Quick Prepare and fail on the card, or the reverse.
     */
    const bare = whatsappDestination("663947116");
    const link = buildWhatsAppLink({
      identifier: "663947116",
      accounts: [],
      expirationDate: "2026-10-02",
      durationDays: 30,
    });

    expect(bare).toBe("https://wa.me/213663947116");
    if (link.available) {
      expect(link.url.startsWith(`${bare}?text=`)).toBe(true);
    }
  });
});
