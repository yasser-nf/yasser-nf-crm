import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import {
  accounts,
  customers,
  issues,
  profiles,
  users,
  type AccountRow,
  type CustomerRow,
  type IssueRow,
  type ProfileRow,
  type UserRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import type { SearchTerms } from "../services/search-terms";

/**
 * Global search queries (M05).
 *
 * One bounded query per entity, run in parallel by the service — never a table
 * downloaded to the browser, never a query per result.
 *
 * WHAT IS NEVER SELECTED. Each query names its columns. `password_encrypted`,
 * `profiles.pin` and every free-text notes column are absent from every select
 * list here, so no mapping mistake downstream can leak one: the value is never
 * in memory to begin with. Matching follows the same rule — nothing is matched
 * on a PIN or a password, because "which profile has PIN 4821" is itself the
 * disclosure.
 *
 * WHAT IS SEARCHED. Live rows only (`deleted_at is null`), the same population
 * each entity's own page shows. Every query fetches `limit + 1` so the service
 * can say "more exist" without a second count query.
 *
 * Indexes: contains-matching (`ilike '%x%'`) cannot use a b-tree, and at this
 * business's size (hundreds of rows per table) a sequential scan answers in
 * well under a millisecond per table. The profile and problem queries still
 * reach accounts through their primary key. See docs/SEARCH_AND_NOTIFICATIONS.md
 * for when trigram indexes become worth their write cost.
 */

export type AccountHitRow = Pick<
  AccountRow,
  "id" | "email" | "status" | "validUntil" | "deletedAt"
>;

export interface ProfileHitRow {
  readonly profile: Pick<
    ProfileRow,
    | "id"
    | "accountId"
    | "profileNumber"
    | "profileName"
    | "status"
    | "customerId"
    | "expirationDate"
  >;
  readonly account: Pick<
    AccountRow,
    "id" | "email" | "status" | "validUntil" | "deletedAt" | "profileSlots"
  >;
}

export type CustomerHitRow = Pick<
  CustomerRow,
  "id" | "name" | "phoneOriginal" | "phoneNormalized" | "blockedAt"
>;

export interface ProblemHitRow {
  readonly id: IssueRow["id"];
  readonly issueType: IssueRow["issueType"];
  readonly status: IssueRow["status"];
  readonly createdAt: IssueRow["createdAt"];
  readonly accountEmail: string;
}

export type UserHitRow = Pick<UserRow, "id" | "name" | "email" | "role" | "status">;

export interface SearchRepository {
  accounts(terms: SearchTerms, limit: number): Promise<Result<AccountHitRow[]>>;
  profiles(terms: SearchTerms, limit: number): Promise<Result<ProfileHitRow[]>>;
  customers(terms: SearchTerms, limit: number): Promise<Result<CustomerHitRow[]>>;
  problems(terms: SearchTerms, limit: number): Promise<Result<ProblemHitRow[]>>;
  users(terms: SearchTerms, limit: number): Promise<Result<UserHitRow[]>>;
}

/** Matches at the start of the field rank first; the rest keep their natural order. */
function startsFirst(column: SQL | typeof accounts.email, terms: SearchTerms): SQL {
  return sql`case when ${column} ilike ${terms.startsWith} then 0 else 1 end`;
}

function anyOf(conditions: (SQL | undefined)[]): SQL | undefined {
  const present = conditions.filter((condition): condition is SQL => condition !== undefined);
  return present.length > 0 ? or(...present) : undefined;
}

const BLOCKING = ["open", "in_progress", "waiting"] as const;

export const searchRepository: SearchRepository = {
  async accounts(terms, limit) {
    return databaseAdapter.query("search.accounts", (executor) =>
      executor
        .select({
          id: accounts.id,
          email: accounts.email,
          status: accounts.status,
          validUntil: accounts.validUntil,
          deletedAt: accounts.deletedAt,
        })
        .from(accounts)
        .where(
          and(
            isNull(accounts.deletedAt),
            anyOf([
              ilike(accounts.email, terms.contains),
              terms.idPrefix ? sql`${accounts.id}::text ilike ${terms.idPrefix}` : undefined,
            ]),
          ),
        )
        .orderBy(startsFirst(accounts.email, terms), asc(accounts.email))
        .limit(limit + 1),
    );
  },

  async profiles(terms, limit) {
    return databaseAdapter.query("search.profiles", async (executor) => {
      const rows = await executor
        .select({
          id: profiles.id,
          accountId: profiles.accountId,
          profileNumber: profiles.profileNumber,
          profileName: profiles.profileName,
          status: profiles.status,
          customerId: profiles.customerId,
          expirationDate: profiles.expirationDate,
          accountEmail: accounts.email,
          accountStatus: accounts.status,
          accountValidUntil: accounts.validUntil,
          accountDeletedAt: accounts.deletedAt,
          accountProfileSlots: accounts.profileSlots,
        })
        .from(profiles)
        .innerJoin(accounts, eq(accounts.id, profiles.accountId))
        .where(and(isNull(accounts.deletedAt), ilike(profiles.profileName, terms.contains)))
        .orderBy(
          sql`case when ${profiles.profileName} ilike ${terms.startsWith} then 0 else 1 end`,
          asc(accounts.email),
          asc(profiles.profileNumber),
        )
        .limit(limit + 1);

      return rows.map((row): ProfileHitRow => ({
        profile: {
          id: row.id,
          accountId: row.accountId,
          profileNumber: row.profileNumber,
          profileName: row.profileName,
          status: row.status,
          customerId: row.customerId,
          expirationDate: row.expirationDate,
        },
        account: {
          id: row.accountId,
          email: row.accountEmail,
          status: row.accountStatus,
          validUntil: row.accountValidUntil,
          deletedAt: row.accountDeletedAt,
          profileSlots: row.accountProfileSlots,
        },
      }));
    });
  },

  async customers(terms, limit) {
    return databaseAdapter.query("search.customers", (executor) =>
      executor
        .select({
          id: customers.id,
          name: customers.name,
          phoneOriginal: customers.phoneOriginal,
          phoneNormalized: customers.phoneNormalized,
          blockedAt: customers.blockedAt,
        })
        .from(customers)
        .where(
          and(
            isNull(customers.deletedAt),
            anyOf([
              ilike(customers.name, terms.contains),
              ilike(customers.phoneOriginal, terms.contains),
              ...terms.phoneKeys.map((key) => ilike(customers.phoneNormalized, key)),
            ]),
          ),
        )
        .orderBy(
          sql`case when ${customers.name} ilike ${terms.startsWith} then 0 else 1 end`,
          asc(customers.name),
          asc(customers.phoneNormalized),
        )
        .limit(limit + 1),
    );
  },

  async problems(terms, limit) {
    return databaseAdapter.query("search.problems", (executor) =>
      executor
        .select({
          id: issues.id,
          issueType: issues.issueType,
          status: issues.status,
          createdAt: issues.createdAt,
          accountEmail: accounts.email,
        })
        .from(issues)
        .innerJoin(accounts, eq(accounts.id, issues.accountId))
        .where(
          and(
            /* Problems on live accounts, the population M04's dashboard counts. */
            isNull(accounts.deletedAt),
            anyOf([
              ilike(accounts.email, terms.contains),
              terms.problemTypes.length > 0
                ? inArray(
                    sql`${issues.issueType}::text`,
                    terms.problemTypes.map((type) => sql`${type}`),
                  )
                : undefined,
              terms.idPrefix ? sql`${issues.id}::text ilike ${terms.idPrefix}` : undefined,
            ]),
          ),
        )
        /* Blocking problems are the ones someone is looking for; then newest. */
        .orderBy(
          sql`case when ${issues.status} in (${sql.join(
            BLOCKING.map((status) => sql`${status}`),
            sql`, `,
          )}) then 0 else 1 end`,
          desc(issues.createdAt),
        )
        .limit(limit + 1),
    );
  },

  async users(terms, limit) {
    return databaseAdapter.query("search.users", (executor) =>
      executor
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          status: users.status,
        })
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            anyOf([ilike(users.name, terms.contains), ilike(users.email, terms.contains)]),
          ),
        )
        .orderBy(
          sql`case when ${users.name} ilike ${terms.startsWith} then 0 else 1 end`,
          asc(users.name),
        )
        .limit(limit + 1),
    );
  },
};
