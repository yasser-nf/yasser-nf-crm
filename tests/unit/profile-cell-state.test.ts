import { describe, expect, it } from "vitest";

import { formatEmailAndPassword } from "@/lib/clipboard";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { profileCellState } from "@/modules/accounts";

/**
 * The four profile indicator states, and the copy format.
 *
 * `profileCellState` is the single interpretation behind every profile cell in
 * the application — the accounts list, the account detail page and the profile
 * cards all render what it returns. M13 §7 forbids a second interpretation, so
 * these tests pin the one that exists.
 *
 * The most important assertions are the two that separate this from a naive
 * status lookup: a long-lapsed allocation still reads `sold` in the column and
 * must show as EXPIRED, and a slot above profile_slots reads `available` and
 * must show as NOT FOR SALE.
 */

const TODAY = new Date("2026-08-13T09:30:00Z");

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "stock@example.com",
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    profileSlots: 5,
    validFrom: null,
    validUntil: null,
    country: "DZ",
    notes: null,
    createdBy: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    accountId: "11111111-1111-4111-8111-111111111111",
    profileNumber: 1,
    profileName: null,
    pin: "1234",
    status: "available",
    customerId: null,
    workerId: null,
    saleDate: null,
    expirationDate: null,
    durationDays: null,
    notes: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

const CUSTOMER = "33333333-3333-4333-8333-333333333333";

describe("profileCellState", () => {
  it("shows a free profile as available", () => {
    expect(profileCellState(profile(), account(), TODAY)).toBe("available");
  });

  it("shows a live allocation as sold", () => {
    const sold = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-09-30",
    });

    expect(profileCellState(sold, account(), TODAY)).toBe("sold");
  });

  it("shows a lapsed allocation as expired, even though the column says sold", () => {
    /*
     * The reason this function exists. Nothing ever writes the `expired` status,
     * so a component reading profiles.status would paint this green forever.
     */
    const lapsed = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-07-01",
    });

    expect(lapsed.status).toBe("sold");
    expect(profileCellState(lapsed, account(), TODAY)).toBe("expired");
  });

  it("is expiring, not expired, on the final day of the window", () => {
    /*
     * Zero days left is still inside the window — the customer holds it today.
     * It reads expiring_soon rather than sold because a badge that only turns
     * yellow after the sale has lapsed is a warning nobody can act on.
     */
    const lastDay = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-13",
    });

    expect(profileCellState(lastDay, account(), TODAY)).toBe("expiring_soon");
  });

  it("stays green while the expiry is comfortably ahead", () => {
    const later = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-12-01",
    });

    expect(profileCellState(later, account(), TODAY)).toBe("sold");
  });

  it("turns yellow exactly at the threshold, and not a day earlier", () => {
    /*
     * The boundary, pinned in both directions. EXPIRING_SOON_DAYS is 3, so
     * 2026-08-16 is the last day that counts as soon and 2026-08-17 is the
     * first that does not.
     */
    const onThreshold = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-16",
    });
    const justOutside = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-17",
    });

    expect(profileCellState(onThreshold, account(), TODAY)).toBe("expiring_soon");
    expect(profileCellState(justOutside, account(), TODAY)).toBe("sold");
  });

  it("does not colour a free slot by an old expiration date", () => {
    /*
     * A released profile keeps the date of whoever held it last. It is stock,
     * not an expiring allocation, and must stay dark.
     */
    const free = profile({ status: "available", customerId: null, expirationDate: "2026-08-14" });

    expect(profileCellState(free, account(), TODAY)).toBe("available");
  });

  it("reports expired ahead of expiring, once the window has closed", () => {
    const lapsed = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-12",
    });

    expect(profileCellState(lapsed, account(), TODAY)).toBe("expired");
  });

  it("keeps not_for_sale ahead of everything, including an imminent expiry", () => {
    /* Priority: a slot outside profile_slots is not stock, whatever else holds. */
    const parked = profile({
      profileNumber: 5,
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-14",
    });

    expect(profileCellState(parked, account({ profileSlots: 4 }), TODAY)).toBe("not_for_sale");
  });

  it("keeps a held slot expiring rather than blocked when the account cannot sell", () => {
    /*
     * The documented M13 rule: a sold profile stays sold even on a blocked
     * account, because the customer still holds it. Blocking only changes what
     * a FREE slot is offered as, so an expiring allocation stays yellow.
     */
    const held = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-14",
    });

    expect(profileCellState(held, account(), TODAY, false)).toBe("expiring_soon");
  });

  it("shows expired the day after the window closes", () => {
    const justOver = profile({
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-08-12",
    });

    expect(profileCellState(justOver, account(), TODAY)).toBe("expired");
  });

  it("shows a slot above profile_slots as not for sale", () => {
    /*
     * The row reads `available` — sellability is derived, never stored — so a
     * status lookup would offer this as free stock.
     */
    const beyond = profile({ profileNumber: 4, status: "available" });

    expect(beyond.status).toBe("available");
    expect(profileCellState(beyond, account({ profileSlots: 3 }), TODAY)).toBe("not_for_sale");
  });

  it("shows the last sellable slot as available, not as not-for-sale", () => {
    const edge = profile({ profileNumber: 3 });
    expect(profileCellState(edge, account({ profileSlots: 3 }), TODAY)).toBe("available");
  });

  it("puts not-for-sale ahead of expiry when both apply", () => {
    /*
     * A slot outside profile_slots is not stock whatever else is true of it.
     * Showing it as EXPIRED would imply it returns to the shelf; it never does.
     */
    const both = profile({
      profileNumber: 5,
      status: "sold",
      customerId: CUSTOMER,
      expirationDate: "2026-01-01",
    });

    expect(profileCellState(both, account({ profileSlots: 2 }), TODAY)).toBe("not_for_sale");
  });

  it("treats reserved and expiring_soon as sold for display", () => {
    for (const status of ["reserved", "expiring_soon"] as const) {
      const held = profile({ status, customerId: CUSTOMER, expirationDate: "2026-12-01" });
      expect(profileCellState(held, account(), TODAY), status).toBe("sold");
    }
  });

  it("produces exactly one of the four states for every profile of a five-slot account", () => {
    /* The list renders five cells per row and none may be blank. */
    const states = [1, 2, 3, 4, 5].map((profileNumber) =>
      profileCellState(profile({ profileNumber }), account({ profileSlots: 2 }), TODAY),
    );

    expect(states).toEqual([
      "available",
      "available",
      "not_for_sale",
      "not_for_sale",
      "not_for_sale",
    ]);
  });
});

describe("formatEmailAndPassword", () => {
  it("produces the labelled block the brief specifies", () => {
    expect(formatEmailAndPassword("a@example.com", "secret")).toBe(
      "Email\na@example.com\n\nPassword\nsecret",
    );
  });

  it("separates the two blocks with a blank line", () => {
    const lines = formatEmailAndPassword("a@example.com", "secret").split("\n");

    expect(lines).toEqual(["Email", "a@example.com", "", "Password", "secret"]);
  });

  it("does not mangle a password containing spaces or newlines in the email block", () => {
    const text = formatEmailAndPassword("a@example.com", "pa ss");
    expect(text.endsWith("Password\npa ss")).toBe(true);
  });
});
