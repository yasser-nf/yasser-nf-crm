import { accountCanAllocate, isSellableSlot } from "@/modules/accounts";
import { deriveCustomerStatus } from "@/modules/customers";
import type { AccountRow, CustomerRow, ProfileRow } from "@/lib/drizzle/schema";

/**
 * Whether a profile may be renewed at all. M09 §14.
 *
 * Every rule here is an EXISTING rule, applied — not a new restriction. M09 §14
 * is explicit that this module must reuse the project's actual rules, and each
 * branch below names the one it is applying:
 *
 *   account_unavailable  01_MASTER_RULES.md: "If an Account is not Healthy, ALL
 *                        Profiles automatically become unavailable. No
 *                        exceptions." Expressed as `accountCanAllocate`, the
 *                        same conjunction the accounts list, the detail page,
 *                        Quick Prepare and Quick Replace all go through —
 *                        healthy, not deleted, no blocking problem, own
 *                        coverage not run out. Selling more time on an account
 *                        that can serve nobody is what Quick Replace exists to
 *                        avoid, and that is where the operator is sent.
 *
 *   slot_not_for_sale    ADR-013 D2: a slot above `accounts.profile_slots` is
 *                        not stock, derived from the two facts that define it.
 *                        A renewal sells time, so it cannot sell time on a slot
 *                        the business parked. Its name, PIN and notes stay
 *                        editable as always.
 *
 *   no_customer          M09 §7: reuse the existing customer relationship and
 *                        never create a duplicate. A slot nobody holds has no
 *                        subscription to renew — that is a sale, and Quick
 *                        Prepare makes sales.
 *
 *   customer_blocked /   customer-status.ts: "A blocked customer holding a live
 *   customer_archived    profile is still blocked — showing them as Active
 *                        would invite a worker to serve someone who was
 *                        deliberately stopped." Renewing their subscription is
 *                        precisely serving them. Unblocking first is a
 *                        deliberate act (BLOCK_CUSTOMERS, Super Admin) and it
 *                        is the one this refusal asks for.
 *
 * Nothing here looks at whether the subscription has lapsed. An expired
 * profile IS renewable — see `renewalBasis` for the rule it follows — and
 * refusing one would be the invented restriction §14 forbids.
 */

export type RenewalBlockedReason =
  | "account_unavailable"
  | "slot_not_for_sale"
  | "no_customer"
  | "customer_blocked"
  | "customer_archived";

/** Why this profile cannot be renewed, or null when it can. */
export function renewalBlockedReason(
  input: {
    readonly account: AccountRow;
    readonly profile: ProfileRow;
    readonly hasActiveProblem: boolean;
    /** The holder. Null when the slot is unheld or the record is gone. */
    readonly customer: CustomerRow | null;
  },
  today: Date,
): RenewalBlockedReason | null {
  /*
   * The account first, and unconditionally. Its state overrides everything
   * about the slot: a healthy-looking profile on a payment-blocked account is
   * not renewable, and reporting the slot's problem instead would send the
   * operator to fix the wrong thing.
   */
  if (!accountCanAllocate(input.account, input.hasActiveProblem, today)) {
    return "account_unavailable";
  }

  if (!isSellableSlot(input.profile, input.account)) {
    return "slot_not_for_sale";
  }

  if (input.profile.customerId === null || input.customer === null) {
    return "no_customer";
  }

  /*
   * `deriveCustomerStatus` rather than reading `blockedAt` and `deletedAt`
   * here: it already encodes the precedence (archived outranks blocked) and is
   * what every customer screen shows, so this refusal and that badge cannot
   * disagree.
   */
  const status = deriveCustomerStatus(input.customer, [], today);

  if (status === "archived") {
    return "customer_archived";
  }

  if (status === "blocked") {
    return "customer_blocked";
  }

  return null;
}
