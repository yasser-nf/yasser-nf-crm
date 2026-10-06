import {
  accountCanAllocate,
  accountEffectiveStatus,
  isProfileFree,
  isSellableSlot,
} from "@/modules/accounts";
import { accountBucket, type AccountStateInput } from "./account-state-counts";
import type { ProfileStateInput } from "./profile-state-counts";

/**
 * The dashboard's ownership and per-supplier figures. M10 §14 and §15.
 *
 * COSTS NO QUERY. These are grouped from the SAME rows the dashboard already
 * reads to fill its account and profile widgets — `accountStateInputs` and
 * `profileStateInputs`, each one statement — with `supplierId` added to their
 * projections. M10 §25 forbids N+1 and forbids computing totals from large
 * client-side arrays; this does neither. The grouping happens on the server,
 * over rows that were going to be loaded anyway, in one pass.
 *
 * DEFINES NOTHING. Each account is classified by `accountEffectiveStatus` and
 * `accountBucket` — the functions behind every account badge — and each profile
 * by `profileCellState`. So "problem account" on a supplier's row means
 * precisely what the orange badge on the Accounts page means, and "available"
 * means precisely what Quick Prepare will allocate. M10 §12 and §16.
 *
 * ACCOUNT FIGURES AND PROFILE FIGURES STAY SEPARATE, as M10 §13 requires. A
 * supplier with 50 accounts and 120 available profiles is reported as both, and
 * the two are never added together.
 *
 * Pure: the caller supplies `today`.
 */

/** One supplier's figures, keyed by id. `null` is "My Account". */
export interface SupplierOwnershipRow {
  /** Null for accounts of ours. M10 §3: NULL is the representation, not a row. */
  readonly supplierId: string | null;
  readonly totalAccounts: number;
  readonly healthyAccounts: number;
  readonly problemAccounts: number;
  readonly expiredAccounts: number;
  readonly archivedAccounts: number;
  readonly availableProfiles: number;
}

export interface OwnershipTally {
  /** `supplier_id is null`. M10 §15. */
  readonly myAccounts: number;
  /** `supplier_id is not null` — "how many accounts do I have that are not mine?" */
  readonly supplierAccounts: number;
  readonly totalAccounts: number;
  /**
   * Per-supplier rows, INCLUDING the null key for our own accounts.
   *
   * Carried with the others so the widget can show the whole picture from one
   * value and the caller never has to add the two together — which is exactly
   * where a total goes wrong.
   */
  readonly bySupplier: readonly SupplierOwnershipRow[];
}

function emptyRow(supplierId: string | null): SupplierOwnershipRow {
  return {
    supplierId,
    totalAccounts: 0,
    healthyAccounts: 0,
    problemAccounts: 0,
    expiredAccounts: 0,
    archivedAccounts: 0,
    availableProfiles: 0,
  };
}

/** An account input with the supplier the dashboard query now carries. */
export interface SupplierAccountInput extends AccountStateInput {
  readonly supplierId: string | null;
}

/** A profile input with its owning account's supplier. */
export interface SupplierProfileInput extends ProfileStateInput {
  readonly supplierId: string | null;
}

export function tallySupplierOwnership(
  accounts: readonly SupplierAccountInput[],
  profiles: readonly SupplierProfileInput[],
  today: Date,
): OwnershipTally {
  /*
   * A Map keyed by `supplierId ?? ""`, because `null` and the empty string
   * cannot both be object keys and `null` is the key that matters here. The
   * row itself keeps the real `supplierId`, so nothing downstream sees the
   * substitution.
   */
  const rows = new Map<string, { supplierId: string | null; counts: Record<string, number> }>();

  const rowFor = (supplierId: string | null) => {
    const key = supplierId ?? "";
    const existing = rows.get(key);

    if (existing) {
      return existing;
    }

    const created = {
      supplierId,
      counts: {
        totalAccounts: 0,
        healthyAccounts: 0,
        problemAccounts: 0,
        expiredAccounts: 0,
        archivedAccounts: 0,
        availableProfiles: 0,
      } as Record<string, number>,
    };

    rows.set(key, created);
    return created;
  };

  let myAccounts = 0;
  let supplierAccounts = 0;

  for (const input of accounts) {
    const bucket = accountBucket(
      accountEffectiveStatus(input.account, input.blockingProblemTypes, today),
    );

    /* Soft-deleted accounts are excluded upstream; `null` means "not a bucket". */
    if (bucket === null) {
      continue;
    }

    if (input.supplierId === null) {
      myAccounts += 1;
    } else {
      supplierAccounts += 1;
    }

    const row = rowFor(input.supplierId);
    row.counts["totalAccounts"] = (row.counts["totalAccounts"] ?? 0) + 1;

    /*
     * The bucket names map to this row's fields. `problems` is plural in
     * `AccountStateTally` and singular-ish here because the supplier widget
     * reads "Problem accounts"; the VALUE is the same bucket.
     */
    const field =
      bucket === "problems"
        ? "problemAccounts"
        : bucket === "healthy"
          ? "healthyAccounts"
          : bucket === "expired"
            ? "expiredAccounts"
            : "archivedAccounts";

    row.counts[field] = (row.counts[field] ?? 0) + 1;
  }

  for (const input of profiles) {
    /*
     * ALLOCABLE, which is what M10 §12 asks for: "profiles ... currently
     * available/allocable according to the existing profile eligibility
     * rules". That is the three-way conjunction the allocation engine and
     * `accountsRepository.listWithCounts` both apply, here in its TypeScript
     * spelling:
     *
     *   isSellableSlot      within the account's profile_slots
     *   isProfileFree       never sold, OR sold to somebody whose time ran out
     *                       (03_DATABASE.md's recycling rule)
     *   accountCanAllocate  the account may sell at all
     *
     * NOT `profileCellState(...) === "available"`. That is the stricter
     * display state: it calls a lapsed allocation "expired", because on screen
     * it is. Using it here would have made this figure disagree with the same
     * supplier's figure on its own page, which composes the SQL twins of these
     * three predicates — the exact two-definitions-of-one-word bug this
     * codebase keeps paying for. `docs/DASHBOARD_MODULE.md` already records the
     * distinction: stock = available + resellable expired.
     */
    if (
      !isSellableSlot(input.profile, input.account) ||
      !isProfileFree(input.profile, today) ||
      !accountCanAllocate(input.account, input.hasBlockingProblem, today)
    ) {
      continue;
    }

    const row = rowFor(input.supplierId);
    row.counts["availableProfiles"] = (row.counts["availableProfiles"] ?? 0) + 1;
  }

  return {
    myAccounts,
    supplierAccounts,
    totalAccounts: myAccounts + supplierAccounts,
    bySupplier: [...rows.values()].map(({ supplierId, counts }) => ({
      ...emptyRow(supplierId),
      ...counts,
      supplierId,
    })),
  };
}
