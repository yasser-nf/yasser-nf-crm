import { describe, expect, it } from "vitest";

import {
  PROFILE_CUSTOMER_EMPTY_LABEL,
  PROFILE_CUSTOMER_MISSING_LABEL,
  profileCustomerLabel,
  resolveProfileCustomer,
} from "@/modules/accounts/services/profile-customer";
import type { CustomerRow } from "@/lib/drizzle/schema";

/**
 * Resolving who holds a profile.
 *
 * The bug: every sold profile showed "Assigned" and nothing else, on both the
 * accounts panel and the detail page. The data was never missing — 46 of 46
 * sold profiles carry a `customer_id`, none of them orphaned — the screens
 * simply never asked. `customerLabel={profile.customerId ? "Assigned" : null}`
 * was a placeholder from before the Customers module existed.
 *
 * The fix is this resolver, and its whole job is to make the three cases
 * distinguishable, so no screen can render a blank field by accident.
 */

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: "cus-1",
    name: null,
    phoneOriginal: "0663947116",
    phoneNormalized: "663947116",
    whatsappUrl: "https://wa.me/213663947116",
    notes: null,
    firstPurchaseAt: new Date("2026-01-01"),
    lastPurchaseAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    blockedAt: null,
    ...overrides,
  } as CustomerRow;
}

describe("the three states, and never a fourth", () => {
  it("names the customer when the profile has one", () => {
    const link = resolveProfileCustomer("cus-1", customer());

    expect(link.kind).toBe("linked");
    if (link.kind === "linked") {
      expect(link.customer.label).toBe("0663 94 71 16");
    }
  });

  it("says so in words when customer_id is null", () => {
    /* Requirement 8: never guess, never create. Just say it. */
    const link = resolveProfileCustomer(null, null);

    expect(link.kind).toBe("none");
    expect(profileCustomerLabel(link)).toBe(PROFILE_CUSTOMER_EMPTY_LABEL);
  });

  it("reports a customer_id whose row is gone as unavailable", () => {
    /*
     * Unreachable through the app — the foreign key is ON DELETE SET NULL, so
     * deleting a customer frees the slot instead of orphaning it. Handled
     * anyway, because a restore or a manual write could produce it and the page
     * must not render an empty field or crash.
     */
    const link = resolveProfileCustomer("cus-gone", null);

    expect(link.kind).toBe("unavailable");
    expect(profileCustomerLabel(link)).toBe(PROFILE_CUSTOMER_MISSING_LABEL);
  });

  it("never returns an empty label for any case", () => {
    /* Requirement 13, asserted directly rather than left to each screen. */
    for (const link of [
      resolveProfileCustomer(null, null),
      resolveProfileCustomer("cus-gone", null),
      resolveProfileCustomer("cus-1", customer()),
    ]) {
      expect(profileCustomerLabel(link).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("the label is the one the rest of the app shows", () => {
  it("formats a phone the way the customers table does", () => {
    const link = resolveProfileCustomer("cus-1", customer({ phoneNormalized: "552327768" }));

    if (link.kind === "linked") {
      expect(link.customer.label).toBe("0552 32 77 68");
    }
  });

  it("shows a username identifier as typed", () => {
    const link = resolveProfileCustomer("cus-1", customer({ phoneNormalized: "@yasser" }));

    if (link.kind === "linked") {
      expect(link.customer.label).toBe("@yasser");
    }
  });

  it("builds the label from phone_normalized, not phone_original", () => {
    /*
     * Numbers pasted from WhatsApp arrive wrapped in invisible bidi controls
     * (U+202A … U+202C). Production has them: `‪+213 552 32 77 68‬`. Rendering
     * phone_original would put those marks on screen and into any copy.
     */
    const link = resolveProfileCustomer(
      "cus-1",
      customer({ phoneOriginal: "‪+213 552 32 77 68‬", phoneNormalized: "552327768" }),
    );

    if (link.kind === "linked") {
      expect(link.customer.label).toBe("0552 32 77 68");
      expect(link.customer.label).not.toContain("‪");
      expect(link.customer.label).not.toContain("‬");
    }
  });
});

describe("an archived customer still holds their slot", () => {
  it("resolves rather than hiding them", () => {
    /*
     * A soft-deleted customer is not a missing one. The sale still belongs to
     * them, and blanking the field would make a sold profile look anonymous.
     */
    const link = resolveProfileCustomer("cus-1", customer({ deletedAt: new Date("2026-02-01") }));

    expect(link.kind).toBe("linked");
    if (link.kind === "linked") {
      expect(link.customer.isArchived).toBe(true);
      expect(link.customer.label).toBe("0663 94 71 16");
    }
  });

  it("marks a live customer as not archived", () => {
    const link = resolveProfileCustomer("cus-1", customer());

    if (link.kind === "linked") {
      expect(link.customer.isArchived).toBe(false);
    }
  });
});

describe("a name, when there is one", () => {
  it("carries it alongside the identifier", () => {
    const link = resolveProfileCustomer("cus-1", customer({ name: "Yasser" }));

    if (link.kind === "linked") {
      expect(link.customer.name).toBe("Yasser");
      /* The identifier stays the label — the name does not replace it. */
      expect(link.customer.label).toBe("0663 94 71 16");
    }
  });

  it("treats a blank name as no name", () => {
    const link = resolveProfileCustomer("cus-1", customer({ name: "   " }));

    if (link.kind === "linked") {
      expect(link.customer.name).toBeNull();
    }
  });
});

describe("one profile, one customer", () => {
  it("resolves each profile independently", () => {
    /*
     * Requirement 5: five slots on one account can name five different people.
     * The resolver takes one profile's id and one row, so there is no shared
     * state for a neighbour to leak through.
     */
    const links = [
      resolveProfileCustomer("cus-a", customer({ id: "cus-a", phoneNormalized: "663947116" })),
      resolveProfileCustomer("cus-b", customer({ id: "cus-b", phoneNormalized: "552327768" })),
      resolveProfileCustomer(null, null),
      resolveProfileCustomer("cus-d", customer({ id: "cus-d", phoneNormalized: "@third" })),
    ];

    expect(links.map(profileCustomerLabel)).toEqual([
      "0663 94 71 16",
      "0552 32 77 68",
      PROFILE_CUSTOMER_EMPTY_LABEL,
      "@third",
    ]);
  });

  it("ignores a joined row when the profile has no customer_id", () => {
    /*
     * Defensive: if a caller ever paired the wrong row with a free slot, the
     * slot must still read as free rather than inheriting a stranger.
     */
    const link = resolveProfileCustomer(null, customer());

    expect(link.kind).toBe("none");
  });
});
