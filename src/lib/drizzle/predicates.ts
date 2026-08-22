import { and, eq, sql, type SQL } from "drizzle-orm";

import { accounts, issues, profiles } from "./schema";

/**
 * Shared SQL predicates for the M13 inventory rules.
 *
 * These live in the schema layer rather than in a module because six different
 * queries across three modules need them — accounts, dashboard and reports —
 * and ADR-003 forbids a repository importing another module's code. The schema
 * is shared infrastructure that every repository already imports, so this is
 * the one place all of them can legitimately reach.
 *
 * WHY THESE ARE PREDICATES AND NOT A STORED COLUMN
 *
 * An earlier draft stored a `not_for_sale` profile status, which would have made
 * every `status = 'available'` filter exclude unsellable slots for free. It was
 * withdrawn: that status duplicates a fact profile_slots already records, and
 * the two could drift. `profileUpdateSchema` permits writing `status`, so a
 * profile update could return a parked slot to stock without touching
 * profile_slots, and no database constraint could object — a CHECK cannot
 * reference another table.
 *
 * Deriving costs three extra joins. It buys an invariant that cannot be broken
 * by any write path, present or future. ADR-013 Decision 2.
 *
 * The Drizzle-expression forms below are for queries built with the query
 * builder. `rawSellableSlot` is for the handful of raw-SQL aggregate queries in
 * dashboard and reports, which use table aliases the builder never sees.
 */

/**
 * The account exists.
 *
 * Soft delete is the only thing that removes an account from the catalogue, and
 * `accounts.repository.ts` has always expressed that as `isNull(deletedAt)` —
 * every list, lookup and mutation there is scoped by it. This is that same rule,
 * lifted here so the aggregates can state it identically instead of restating
 * it. The Accounts page is the source of truth for what exists; this constant is
 * how the rest of the codebase asks it.
 *
 * `status = 'deleted'` is deliberately NOT part of the test. Soft delete writes
 * both the timestamp and the status, so the two agree today — but `deleted_at`
 * is the column the partial unique index and every repository predicate are
 * built on, and adding a second condition would invite them to disagree.
 *
 * Note what this does not exclude: an `archived` account with a null
 * `deleted_at` still exists and is still listed on the Accounts page. Archiving
 * and deleting are different acts.
 */
export const accountIsLiveSql: SQL = sql`${accounts.deletedAt} is null`;

/**
 * The raw-SQL form of `accountIsLiveSql`, where the caller controls the alias.
 *
 * Same contract as `rawSellableSlot`: aliases are literals written by this
 * codebase, never user input.
 */
export function rawAccountIsLive(accountAlias: string): SQL {
  return sql.raw(`${accountAlias}.deleted_at is null`);
}

/**
 * This profile row is one of the account's sellable slots.
 *
 * Requires `profiles` to be joined to `accounts`. A query that filters on this
 * without the join will not compile in SQL, which is the intended failure: the
 * rule is meaningless without the account.
 */
export const isSellableSlotSql: SQL = sql`${profiles.profileNumber} <= ${accounts.profileSlots}`;

/**
 * The account's own coverage has not run out.
 *
 * NULL is open-ended, not expired. Every account created before M13 has a null
 * valid_until, and reading those as expired would empty the catalogue.
 */
export const accountStillCoveredSql: SQL = sql`(${accounts.validUntil} is null or ${accounts.validUntil} >= current_date)`;

/**
 * This profile is free to allocate: never sold, or sold to somebody whose time
 * has run out.
 *
 * The second half is 03_DATABASE.md's recycling rule — "Expired Profile →
 * Automatically Available if account is Healthy" — which nothing implemented
 * until M13 because no code ever wrote the `expired` status. The DATE is the
 * authority here, never the status column.
 */
export const profileIsFreeSql: SQL = sql`(
  ${profiles.status} = 'available'
  or (
    ${profiles.status} in ('sold', 'expiring_soon')
    and ${profiles.expirationDate} is not null
    and ${profiles.expirationDate} < current_date
  )
)`;

/**
 * The same sellable-slot rule for raw SQL, where the caller controls the aliases.
 *
 * Aliases are literals written by this codebase, never user input — but they are
 * still interpolated, so callers must pass identifiers and nothing else.
 *
 * Exists so the dashboard and reports aggregates express the rule identically to
 * the allocation path rather than restating it. One rule, two syntaxes, no
 * second definition.
 */
export function rawSellableSlot(profileAlias: string, accountAlias: string): SQL {
  return sql.raw(`${profileAlias}.profile_number <= ${accountAlias}.profile_slots`);
}

/** The raw-SQL form of `accountStillCoveredSql`. */
export function rawAccountStillCovered(accountAlias: string): SQL {
  return sql.raw(
    `(${accountAlias}.valid_until is null or ${accountAlias}.valid_until >= current_date)`,
  );
}

/**
 * No problem in a blocking status is open against the account.
 *
 * The statuses are written out rather than imported from the Problems module:
 * ADR-003 forbids a repository depending on another module, and this predicate
 * is reached from three of them. Reading the `issues` table through the shared
 * schema is what ADR-005 Decision 5 permits instead. `tests/unit/allocation-
 * eligibility.test.ts` asserts this list still equals `BLOCKING_STATUSES`, which
 * is what stops the two drifting apart.
 *
 * This moved here from `quick-prepare/repositories/allocation.repository.ts`,
 * which had the only copy and said so in its own comment. It was correct there
 * and missing everywhere else — which is precisely how the dashboard came to
 * advertise stock the allocation engine would never hand out.
 */
export const accountHasNoBlockingProblemSql: SQL = sql`not exists (
  select 1 from ${issues}
  where ${issues.accountId} = ${accounts.id}
    and ${issues.status} in ('open', 'in_progress', 'waiting')
)`;

/**
 * The account may sell.
 *
 * Four conditions, and every one of them is account-level: nothing here looks at
 * a profile. A profile is stock only when this holds AND the profile's own rules
 * hold — see `allocatableProfileSql`.
 *
 * The Quick Prepare engine has always applied exactly this. The accounts list
 * and the dashboard applied only the profile half, so an account with an open
 * problem advertised four available profiles that Quick Prepare would refuse to
 * allocate. Reporting and allocation now read the same rule.
 */
export const accountCanAllocateSql: SQL = and(
  eq(accounts.status, "healthy"),
  accountIsLiveSql,
  accountHasNoBlockingProblemSql,
  accountStillCoveredSql,
) as SQL;

/**
 * The raw-SQL form of `accountCanAllocateSql`, where the caller controls the
 * alias. Same contract as the other `raw*` helpers.
 */
export function rawAccountCanAllocate(accountAlias: string): SQL {
  return sql.raw(`(
    ${accountAlias}.status = 'healthy'
    and ${accountAlias}.deleted_at is null
    and (${accountAlias}.valid_until is null or ${accountAlias}.valid_until >= current_date)
    and not exists (
      select 1 from issues bi
      where bi.account_id = ${accountAlias}.id
        and bi.status in ('open', 'in_progress', 'waiting')
    )
  )`);
}
