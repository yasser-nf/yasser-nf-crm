import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { databaseAdapter, type DatabaseExecutor } from "@/lib/database";
import { accountHasBlockingProblemSql } from "@/lib/drizzle/predicates";
import {
  accounts,
  customers,
  profiles,
  type AccountRow,
  type CustomerRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";

/**
 * Renewal repository. M09.
 *
 * Belongs to this module rather than to accounts for the same reason the
 * allocation repository belongs to quick-prepare: the read that matters here is
 * a locking one, run inside someone else's transaction, and it is only correct
 * there. Tables are shared infrastructure, so reading `profiles` from here is
 * not a cross-module dependency — ADR-003's rule is about importing another
 * module's code, which this does not do.
 *
 * Describes WHAT is needed. Every statement goes through `databaseAdapter`, so
 * error translation and the retry policy are never bypassed (ADR-005 D5).
 */

/** One slot on the account, with whoever holds it. */
export interface ProfileWithCustomer {
  readonly profile: ProfileRow;
  /** Null when the slot is unheld, or when the customer record is gone. */
  readonly customer: CustomerRow | null;
}

/**
 * A profile and the account carrying it, read together because every renewal
 * rule needs both.
 *
 * `hasBlockingProblem` comes from the same query rather than a second call.
 * `accountCanAllocate` takes it as an argument — the accounts list, the detail
 * page and Quick Replace all pass the Problems module's answer — and reading it
 * separately from the locked row would mean deciding eligibility from two
 * moments in time.
 */
export interface ProfileWithAccount {
  readonly profile: ProfileRow;
  readonly account: AccountRow;
  readonly hasBlockingProblem: boolean;
}

/**
 * The live account with this email, or null.
 *
 * Soft-deleted accounts are excluded by `deletedAt is null`, the same predicate
 * every account read in the codebase is scoped by — M09 §5 asks for the
 * existing account-state rules, not a new set.
 */
async function findAccountByEmail(email: string): Promise<Result<AccountRow | null>> {
  const rows = await databaseAdapter.query("quickRenew.findAccount", (executor) =>
    executor
      .select()
      .from(accounts)
      .where(and(eq(accounts.email, email), isNull(accounts.deletedAt)))
      .limit(1),
  );

  return rows.ok ? ok(rows.value[0] ?? null) : rows;
}

/**
 * Every physical slot on the account, in profile-number order, with its holder.
 *
 * A LEFT join, so an unheld slot still appears. M09 §6 asks the operator to see
 * the account's profiles and choose one; a list that showed only the sold ones
 * is how a renewal gets aimed at the wrong profile.
 */
async function listProfilesWithCustomers(
  accountId: string,
): Promise<Result<readonly ProfileWithCustomer[]>> {
  return databaseAdapter.query("quickRenew.listProfiles", (executor) =>
    executor
      .select({ profile: profiles, customer: customers })
      .from(profiles)
      .leftJoin(customers, eq(profiles.customerId, customers.id))
      .where(eq(profiles.accountId, accountId))
      .orderBy(asc(profiles.profileNumber)),
  );
}

/**
 * One profile with its account and holder. Unlocked.
 *
 * For quoting a renewal and for replaying one that already committed — neither
 * writes, and neither may hold a lock across an operator's thinking time.
 */
async function readProfile(
  profileId: string,
): Promise<Result<(ProfileWithAccount & { readonly customer: CustomerRow | null }) | null>> {
  const rows = await databaseAdapter.query("quickRenew.readProfile", (executor) =>
    executor
      .select({
        profile: profiles,
        account: accounts,
        customer: customers,
        hasBlockingProblem: sql<boolean>`${accountHasBlockingProblemSql}`,
      })
      .from(profiles)
      .innerJoin(accounts, eq(profiles.accountId, accounts.id))
      .leftJoin(customers, eq(profiles.customerId, customers.id))
      .where(and(eq(profiles.id, profileId), isNull(accounts.deletedAt)))
      .limit(1),
  );

  return rows.ok ? ok(rows.value[0] ?? null) : rows;
}

/**
 * Reads and LOCKS one profile, with its account. Commit path only.
 *
 * Must be called inside a transaction. The lock is held until that transaction
 * commits, which is what makes "read the expiry, then extend it" atomic: two
 * operators confirming the same profile at the same moment cannot both read the
 * old expiry and both add to it.
 *
 * No SKIP LOCKED, unlike allocation. There is exactly one row that can satisfy
 * this renewal, so skipping it would report "profile not found" to the second
 * operator — a lie. Waiting makes them see the renewed row and be refused by
 * the expiry precondition, which is the truth.
 *
 * Only the profile row is locked; the account is read for its validity and
 * slot count. Locking accounts here would make a renewal contend with every
 * unrelated edit to the same account.
 */
async function lockProfile(
  executor: DatabaseExecutor,
  profileId: string,
): Promise<ProfileWithAccount | null> {
  const rows = await executor
    .select({
      profile: profiles,
      account: accounts,
      hasBlockingProblem: sql<boolean>`${accountHasBlockingProblemSql}`,
    })
    .from(profiles)
    .innerJoin(accounts, eq(profiles.accountId, accounts.id))
    .where(and(eq(profiles.id, profileId), isNull(accounts.deletedAt)))
    .limit(1)
    .for("update", { of: profiles });

  return rows[0] ?? null;
}

export const renewalRepository = {
  findAccountByEmail,
  listProfilesWithCustomers,
  readProfile,
  lockProfile,
} as const;
