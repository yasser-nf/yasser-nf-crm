import { sql, type SQL } from "drizzle-orm";

import { accounts, profiles } from "./schema";

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
