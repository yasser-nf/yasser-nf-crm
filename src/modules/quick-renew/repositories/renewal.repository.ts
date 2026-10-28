import { and, asc, eq, ilike, sql } from "drizzle-orm";

import { databaseAdapter, type DatabaseTransaction } from "@/lib/database";
import { accountHasNoBlockingProblemSql, accountIsLiveSql } from "@/lib/drizzle/predicates";
import {
  accounts,
  customers,
  profiles,
  type AccountRow,
  type CustomerRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { escapeLike } from "@/utils/like";

/**
 * Reads behind Quick Renewing (M09A).
 *
 * Deliberately narrow. The account list's own search matches email, notes and
 * country, and does not escape the operator's wildcards; this workflow asks
 * only "which account has this email", so it matches the email column alone
 * and escapes the term — a typed `%` finds accounts containing a percent sign
 * rather than every account in the system.
 */

/** One account that matched, with just enough to choose between near-identical emails. */
export interface AccountMatch {
  readonly account: AccountRow;
  readonly hasBlockingProblem: boolean;
}

export interface ProfileWithCustomer {
  readonly profile: ProfileRow;
  readonly customer: CustomerRow | null;
}

export interface RenewalTarget {
  readonly profile: ProfileRow;
  readonly account: AccountRow;
  readonly customer: CustomerRow | null;
  readonly hasBlockingProblem: boolean;
}

export interface RenewalRepository {
  /** Live accounts whose email contains the term. Never the password. */
  searchByEmail(term: string, limit: number): Promise<Result<readonly AccountMatch[]>>;

  /** One live account, with whether a problem currently blocks it. */
  findAccount(accountId: string): Promise<Result<AccountMatch | null>>;

  /** An account's slots in profile order, each with whoever holds it. */
  profilesForAccount(accountId: string): Promise<Result<readonly ProfileWithCustomer[]>>;

  /** The unlocked read behind the preview. */
  findTarget(profileId: string): Promise<Result<RenewalTarget | null>>;

  /**
   * The same row, locked for the confirm.
   *
   * `FOR UPDATE` on the profile only: the account and customer are read for
   * their rules, not changed, and locking them would serialise unrelated work
   * on the same account. Two renewals of the SAME profile serialise here, which
   * is the race that matters — the second then sees the first's expiry and its
   * stale-preview check refuses it.
   */
  lockTarget(executor: DatabaseTransaction, profileId: string): Promise<RenewalTarget | null>;

  /** Writes the renewed period. Returns the row as it now stands. */
  applyRenewal(
    executor: DatabaseTransaction,
    profileId: string,
    next: { readonly expirationDate: string; readonly durationDays: number },
  ): Promise<ProfileRow | null>;
}

const blockingProblem = sql<boolean>`not (${accountHasNoBlockingProblemSql})`;

export const renewalRepository: RenewalRepository = {
  async searchByEmail(term, limit) {
    return databaseAdapter.query("renewal.searchByEmail", async (executor) => {
      const rows = await executor
        .select({ account: accounts, hasBlockingProblem: blockingProblem })
        .from(accounts)
        .where(and(accountIsLiveSql, ilike(accounts.email, `%${escapeLike(term)}%`)))
        .orderBy(asc(accounts.email))
        .limit(limit);

      return rows.map((row) => ({
        account: row.account,
        hasBlockingProblem: row.hasBlockingProblem === true,
      }));
    });
  },

  async findAccount(accountId) {
    return databaseAdapter.query("renewal.findAccount", async (executor) => {
      const [row] = await executor
        .select({ account: accounts, hasBlockingProblem: blockingProblem })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), accountIsLiveSql))
        .limit(1);

      return row
        ? { account: row.account, hasBlockingProblem: row.hasBlockingProblem === true }
        : null;
    });
  },

  async profilesForAccount(accountId) {
    return databaseAdapter.query("renewal.profilesForAccount", async (executor) => {
      const rows = await executor
        .select({ profile: profiles, customer: customers })
        .from(profiles)
        .leftJoin(customers, eq(profiles.customerId, customers.id))
        .where(eq(profiles.accountId, accountId))
        .orderBy(asc(profiles.profileNumber));

      return rows.map((row) => ({ profile: row.profile, customer: row.customer }));
    });
  },

  async findTarget(profileId) {
    return databaseAdapter.query("renewal.findTarget", async (executor) => {
      const [row] = await executor
        .select({
          profile: profiles,
          account: accounts,
          customer: customers,
          hasBlockingProblem: blockingProblem,
        })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .leftJoin(customers, eq(profiles.customerId, customers.id))
        .where(and(eq(profiles.id, profileId), accountIsLiveSql))
        .limit(1);

      return row
        ? {
            profile: row.profile,
            account: row.account,
            customer: row.customer,
            hasBlockingProblem: row.hasBlockingProblem === true,
          }
        : null;
    });
  },

  async lockTarget(executor, profileId) {
    const [locked] = await executor
      .select()
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .for("update");

    if (!locked) {
      return null;
    }

    const [row] = await executor
      .select({ account: accounts, hasBlockingProblem: blockingProblem })
      .from(accounts)
      .where(and(eq(accounts.id, locked.accountId), accountIsLiveSql))
      .limit(1);

    if (!row) {
      return null;
    }

    /* Read separately rather than left-joined: the held customer is optional. */
    const held = locked.customerId
      ? ((await executor.select().from(customers).where(eq(customers.id, locked.customerId)))[0] ??
        null)
      : null;

    return {
      profile: locked,
      account: row.account,
      customer: held,
      hasBlockingProblem: row.hasBlockingProblem === true,
    };
  },

  async applyRenewal(executor, profileId, next) {
    const [row] = await executor
      .update(profiles)
      .set({
        expirationDate: next.expirationDate,
        durationDays: next.durationDays,
        updatedAt: sql`now()`,
      })
      .where(eq(profiles.id, profileId))
      .returning();

    return row ?? null;
  },
};
