import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  profileCellState,
  remainingCustomerDays,
  toAccountView,
  toProfileView,
  type AccountView,
  type ProfileCellState,
  type ProfileView,
} from "@/modules/accounts";
import { databaseAdapter } from "@/lib/database";
import { remainingDays } from "@/lib/dates";
import {
  accounts,
  customers,
  profiles,
  type CustomerRow,
  type IssueRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import { ValidationError } from "@/lib/errors";
import { problemsService } from "@/modules/problems";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { allocationRepository } from "../repositories/allocation.repository";
import { buildAllocationPlan } from "./allocation-engine";
import { replaceLookupSchema } from "../validation/quick-prepare.schema";

/**
 * Quick Replace — the preview half.
 *
 * M13 §9 requires the operator to SEE the whole picture before anything is
 * released: which account, which profile, whose it is, how long they have left,
 * what is wrong with it, and what they would be moved onto. This service
 * produces exactly that and writes nothing at all.
 *
 * Splitting preview from commit is not a UI convenience. Releasing an allocation
 * before a replacement is confirmed is how a customer ends up with nothing when
 * the second half fails, and the brief calls that out specifically. Preview
 * takes no locks and makes no changes; `quickPrepareService.confirmReplacement`
 * does the release and the re-allocation together, under one transaction, and is
 * the only entry point that can.
 *
 * The preview is therefore ADVISORY, exactly as Quick Prepare's is (ADR-007 D4).
 * Stock can move between preview and commit, which is why the commit re-selects
 * under lock and refuses if what it finds no longer matches what was shown.
 */

/** One customer holding profiles on the account being replaced. */
export interface ReplacementCandidate {
  readonly customer: CustomerRow;
  readonly profiles: readonly ProfileView[];
  /** Whole days the customer still has. Never negative. */
  readonly remainingDays: number;
  /** True when their allocation has already lapsed. */
  readonly hasExpired: boolean;
}

/**
 * One physical slot on the failing account, with its state already derived.
 *
 * M13 Phase E step 3 asks the operator to see every screen on the account, not
 * only the ones somebody holds — a five-slot account showing two rows is how a
 * replacement gets aimed at the wrong profile.
 *
 * `state` comes from `profileCellState`, the single derivation the accounts
 * list, the detail page and the profile cards already share. There is no second
 * interpretation of sellability or expiry here.
 */
export interface AccountProfileSlot {
  readonly profile: ProfileView;
  readonly state: ProfileCellState;
  /** Who holds it, when anybody does. The row itself carries the id. */
  readonly customerName: string | null;
}

/** What the operator is shown before confirming. */
export interface ReplacementPreview {
  readonly oldAccount: AccountView;
  /**
   * Every physical slot on the failing account, in profile-number order.
   *
   * For visualisation and disambiguation only. Never an allocation input — the
   * commit re-reads under lock.
   */
  readonly accountProfiles: readonly AccountProfileSlot[];
  /** Every customer on this account, so an ambiguous case can be resolved. */
  readonly candidates: readonly ReplacementCandidate[];
  /**
   * The one being replaced. Null when the account carries several customers and
   * the caller did not say which — the UI must ask rather than the service
   * guessing.
   */
  readonly selected: ReplacementCandidate | null;
  /** Open problems on the failing account, per M13 §9 step 5. */
  readonly problems: readonly IssueRow[];
  /** The proposed replacement, or null when nothing suitable exists. */
  readonly replacement: {
    readonly account: AccountView;
    readonly profiles: readonly ProfileView[];
    readonly remainingValidityDays: number | null;
    /** Carried over, never restarted. The customer's original expiry date. */
    readonly expirationDate: string | null;
  } | null;
  /**
   * Why no replacement could be offered. Null when one was.
   *
   * Distinguishes "no stock at all" from "stock exists but none of it lasts
   * long enough", which have completely different answers for the operator.
   */
  readonly blockedReason: "no_stock" | "insufficient_validity" | "nothing_to_replace" | null;
  /** How short the best near-miss was, so the UI can quote numbers. */
  readonly bestAvailableDays: number | null;
  /**
   * True when the replacement account previously served another customer whose
   * allocation has expired. M13 §7: the operator must change the password
   * before handing it over, and §8 makes confirming that mandatory.
   */
  readonly requiresPasswordChange: boolean;
}

/**
 * Finds a customer's allocation from the account email they were given, and
 * proposes a replacement. Read-only.
 */
async function preview(input: unknown): Promise<Result<ReplacementPreview>> {
  const parsed = replaceLookupSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Quick Replace lookup failed validation", { fieldErrors }));
  }

  const { accountEmail, customerId } = parsed.data;

  const accountRows = await databaseAdapter.query("quickReplace.findAccount", (executor) =>
    executor
      .select()
      .from(accounts)
      .where(and(eq(accounts.email, accountEmail), isNull(accounts.deletedAt)))
      .limit(1),
  );

  if (!accountRows.ok) {
    return accountRows;
  }

  const oldAccount = accountRows.value[0];

  if (!oldAccount) {
    /*
     * A ValidationError rather than a NotFoundError, deliberately: the failure
     * is an address the operator typed, and it needs to render ON that input.
     * NotFoundError carries no field errors, so the message would have had
     * nowhere to attach — the exact silence that hid the account-creation bug.
     */
    return fail(
      new ValidationError(`No live account with email ${accountEmail}`, {
        userMessage: "No account with that email. Check the address and try again.",
        fieldErrors: { accountEmail: "No account found with this email" },
      }),
    );
  }

  /* Every profile on the account that belongs to somebody, with its customer. */
  const heldRows = await databaseAdapter.query("quickReplace.findHeld", (executor) =>
    executor
      .select({ profile: profiles, customer: customers })
      .from(profiles)
      .innerJoin(customers, eq(profiles.customerId, customers.id))
      .where(eq(profiles.accountId, oldAccount.id)),
  );

  if (!heldRows.ok) {
    return heldRows;
  }

  /*
   * Every physical slot, held or not. A LEFT join, so a free slot still appears
   * — the whole point is that the operator sees all five rather than only the
   * sold ones. Separate from the read above rather than replacing it: the
   * candidate grouping below is the allocation-relevant view and stays exactly
   * as it was.
   */
  const allRows = await databaseAdapter.query("quickReplace.findAllProfiles", (executor) =>
    executor
      .select({ profile: profiles, customerName: customers.name })
      .from(profiles)
      .leftJoin(customers, eq(profiles.customerId, customers.id))
      .where(eq(profiles.accountId, oldAccount.id))
      .orderBy(profiles.profileNumber),
  );

  if (!allRows.ok) {
    return allRows;
  }

  const now = new Date();

  /*
   * State derived from the FULL row, then the row projected. Doing it in this
   * order keeps `profileCellState` on its existing signature — the derivation is
   * shared, not re-implemented against a narrower shape.
   */
  const accountProfiles: readonly AccountProfileSlot[] = allRows.value.map((row) => ({
    profile: toProfileView(row.profile),
    state: profileCellState(row.profile, oldAccount, now),
    customerName: row.customerName,
  }));

  /* Group by customer: one person may hold several profiles on one account. */
  const byCustomer = new Map<string, { customer: CustomerRow; profiles: ProfileRow[] }>();

  for (const row of heldRows.value) {
    const entry = byCustomer.get(row.customer.id) ?? { customer: row.customer, profiles: [] };
    entry.profiles.push(row.profile);
    byCustomer.set(row.customer.id, entry);
  }

  const candidates: ReplacementCandidate[] = [...byCustomer.values()].map((entry) => {
    /*
     * The longest-dated profile decides the customer's remaining time. Taking
     * the shortest would under-serve somebody holding two profiles bought at
     * different times.
     */
    const days = Math.max(
      ...entry.profiles.map((profile) => remainingCustomerDays(profile, now)),
      0,
    );

    return {
      customer: entry.customer,
      /* Projected last: the days above were measured on the full rows. */
      profiles: [...entry.profiles]
        .sort((a, b) => a.profileNumber - b.profileNumber)
        .map(toProfileView),
      remainingDays: days,
      hasExpired: entry.profiles.every(
        (profile) => (remainingDays(profile.expirationDate, now) ?? 1) < 0,
      ),
    };
  });

  const problemsResult = await problemsService.activeForAccount(oldAccount.id);
  const problems = problemsResult.ok ? problemsResult.value : [];

  /*
   * Ambiguity is reported, never resolved by guessing. Replacing the wrong
   * customer's profile cannot be undone by pressing back.
   */
  const selected =
    customerId !== undefined
      ? (candidates.find((candidate) => candidate.customer.id === customerId) ?? null)
      : candidates.length === 1
        ? (candidates[0] ?? null)
        : null;

  /*
   * The credential leaves here and goes no further. `oldAccount` is projected
   * once, into the object every early return spreads, so no return path can
   * forget it.
   */
  const base = {
    oldAccount: toAccountView(oldAccount),
    accountProfiles,
    candidates,
    selected,
    problems,
    replacement: null,
    bestAvailableDays: null,
    requiresPasswordChange: false,
  } as const;

  if (candidates.length === 0) {
    return ok({ ...base, blockedReason: "nothing_to_replace" });
  }

  if (!selected) {
    /* More than one customer and no choice made. The UI asks; nothing is wrong. */
    return ok({ ...base, blockedReason: null });
  }

  /*
   * What the replacement must cover. M13 §9: the remaining period, not a fresh
   * term — 90 bought, 40 consumed, 50 carried over.
   */
  const needed = selected.remainingDays;

  const candidatesResult = await allocationRepository.findCandidates();

  if (!candidatesResult.ok) {
    return candidatesResult;
  }

  /* Never replace like for like — the failing account must not win again. */
  const eligible = candidatesResult.value.filter(
    (candidate) => candidate.account.id !== oldAccount.id,
  );

  const plan = buildAllocationPlan(eligible, selected.profiles.length, {
    requestedDurationDays: needed,
  });

  const bestAvailableDays =
    eligible.length === 0
      ? null
      : eligible.reduce<number | null>((best, candidate) => {
          const days = candidate.remainingValidityDays;
          if (days === null) return null === best ? null : best;
          return best === null ? days : Math.max(best, days);
        }, 0);

  if (plan.isShort) {
    return ok({
      ...base,
      blockedReason: plan.excludedForValidity > 0 ? "insufficient_validity" : "no_stock",
      bestAvailableDays,
    });
  }

  const slice = plan.slices[0];

  if (!slice) {
    return ok({ ...base, blockedReason: "no_stock", bestAvailableDays });
  }

  const chosen = eligible.find((candidate) => candidate.account.id === slice.account.id);

  /*
   * Reuse detection. A profile on the replacement account that was sold and has
   * since lapsed means somebody else had these credentials. M13 §7 and §8: the
   * password must be changed before handover, and the operator must confirm it.
   */
  const reused = await hasLapsedAllocation(slice.account.id);

  /* The customer's own expiry is preserved exactly — this is the carry-over. */
  const expirationDate = selected.profiles[0]?.expirationDate ?? null;

  return ok({
    ...base,
    blockedReason: null,
    bestAvailableDays,
    requiresPasswordChange: reused,
    replacement: {
      account: toAccountView(slice.account),
      profiles: slice.profiles.map(toProfileView),
      remainingValidityDays: chosen?.remainingValidityDays ?? null,
      expirationDate,
    },
  });
}

/**
 * Whether any profile on this account was sold to somebody whose time ran out.
 *
 * Read from the dates, not from the status column — nothing writes `expired`.
 */
async function hasLapsedAllocation(accountId: string): Promise<boolean> {
  const rows = await databaseAdapter.query("quickReplace.reuseCheck", (executor) =>
    executor
      .select({ n: sql<number>`count(*)::int` })
      .from(profiles)
      .where(
        and(
          eq(profiles.accountId, accountId),
          sql`${profiles.expirationDate} is not null and ${profiles.expirationDate} < current_date`,
        ),
      ),
  );

  return rows.ok && (rows.value[0]?.n ?? 0) > 0;
}

/**
 * Re-reads the profiles a preview showed, to verify it is still current.
 *
 * Used by the commit path before it releases anything. Exported so the confirm
 * step in quick-prepare.service can call it without duplicating the query.
 */
async function stillHolds(
  accountId: string,
  customerId: string,
  expectedProfileIds: readonly string[],
): Promise<Result<boolean>> {
  const rows = await databaseAdapter.query("quickReplace.verifyPreview", (executor) =>
    executor
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          eq(profiles.accountId, accountId),
          eq(profiles.customerId, customerId),
          inArray(profiles.id, [...expectedProfileIds]),
        ),
      ),
  );

  if (!rows.ok) {
    return rows;
  }

  return ok(rows.value.length === expectedProfileIds.length);
}

export const quickReplaceService = { preview, stillHolds } as const;
