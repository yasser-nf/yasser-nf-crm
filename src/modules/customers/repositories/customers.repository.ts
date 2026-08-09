import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { accounts, customers, profiles, type CustomerRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";
import type { CustomerInsert, CustomerUpdate } from "../validation/customer.schema";

/**
 * Customers repository.
 *
 * 01_MASTER_RULES.md: customer identity is the normalized WhatsApp number.
 * `findByNormalizedPhone` is therefore the lookup that matters — searching by
 * name will never be reliable, because the same person appears under different
 * spellings.
 */

const ENTITY = "Customer";

const liveOnly = isNull(customers.deletedAt);

export type CustomerSortField = "createdAt" | "lastPurchaseAt" | "phoneNormalized";

export interface CustomerFilter extends PaginationInput {
  /**
   * Matches phone (either form), notes, name, and — through a join — the
   * Netflix email, profile number and PIN of any profile the customer holds.
   */
  readonly search?: string | undefined;
  readonly onlyActive?: boolean | undefined;
  readonly onlyBlocked?: boolean | undefined;
  readonly sortBy?: CustomerSortField | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

/**
 * A customer with the profile tallies the list screen needs.
 *
 * Counted in SQL rather than by loading each customer's profiles. A 25-row page
 * would otherwise issue 25 extra queries — the N+1 the brief asks us to avoid.
 */
export interface CustomerWithStats {
  readonly customer: CustomerRow;
  readonly activeProfiles: number;
  readonly expiredProfiles: number;
}

export interface CustomersRepository {
  findById(id: string): Promise<Result<CustomerRow>>;
  findByNormalizedPhone(phoneNormalized: string): Promise<Result<CustomerRow>>;
  existsByNormalizedPhone(phoneNormalized: string): Promise<Result<boolean>>;
  list(filter?: CustomerFilter): Promise<Result<Page<CustomerRow>>>;
  /** The customers list screen. One query, with tallies aggregated in SQL. */
  listWithStats(filter?: CustomerFilter): Promise<Result<Page<CustomerWithStats>>>;
  create(input: CustomerInsert): Promise<Result<CustomerRow>>;
  update(id: string, input: CustomerUpdate): Promise<Result<CustomerRow>>;
  setBlocked(id: string, blocked: boolean): Promise<Result<CustomerRow>>;
  softDelete(id: string): Promise<Result<CustomerRow>>;
}

const SORT_COLUMNS = {
  createdAt: customers.createdAt,
  lastPurchaseAt: customers.lastPurchaseAt,
  phoneNormalized: customers.phoneNormalized,
} as const;

/** Resolved through a lookup table so a query-string value never reaches SQL. */
function resolveOrderBy(filter: CustomerFilter) {
  const column = SORT_COLUMNS[filter.sortBy ?? "createdAt"];
  return filter.sortDirection === "asc" ? asc(column) : desc(column);
}

function buildFilter(filter: CustomerFilter) {
  const conditions = [liveOnly];

  if (filter.onlyBlocked === true) {
    conditions.push(isNotNull(customers.blockedAt));
  }

  if (filter.search?.trim()) {
    const raw = filter.search.trim();
    const term = `%${raw}%`;

    /*
     * 01_MASTER_RULES.md requires search across email, PIN and profile number
     * as well as the customer's own columns. Those live on other tables, so the
     * customer is matched by existence of a profile that matches — an EXISTS
     * subquery rather than a join, so a customer holding five matching profiles
     * still appears once.
     *
     * Password is deliberately absent: it is encrypted with a random IV and
     * cannot be matched in SQL. ADR-005 Decision 4 records that trade-off.
     */
    const digits = raw.replace(/\D/g, "");

    const matches = or(
      ilike(customers.name, term),
      ilike(customers.phoneOriginal, term),
      ilike(customers.phoneNormalized, digits.length > 0 ? `%${digits}%` : term),
      ilike(customers.notes, term),
      sql`exists (
        select 1 from ${profiles} p
        join ${accounts} a on a.id = p.account_id
        where p.customer_id = ${customers.id}
          and (
            a.email ilike ${term}
            or p.pin ilike ${term}
            or p.profile_name ilike ${term}
            or (${digits.length > 0 && digits.length <= 1} and p.profile_number = ${digits === "" ? -1 : Number(digits)})
          )
      )`,
    );

    if (matches !== undefined) {
      conditions.push(matches);
    }
  }

  return and(...conditions);
}

/** A profile counts as active when it is sold and has not yet expired. */
const ACTIVE_PROFILE_SQL = sql`p.status = 'sold' and (p.expiration_date is null or p.expiration_date >= current_date)`;
const EXPIRED_PROFILE_SQL = sql`p.status = 'expired' or (p.expiration_date is not null and p.expiration_date < current_date)`;

export const customersRepository: CustomersRepository = {
  async findById(id) {
    const result = await databaseAdapter.query("customers.findById", (executor) =>
      executor
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async findByNormalizedPhone(phoneNormalized) {
    const result = await databaseAdapter.query("customers.findByNormalizedPhone", (executor) =>
      executor
        .select()
        .from(customers)
        .where(and(eq(customers.phoneNormalized, phoneNormalized), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, phoneNormalized);
  },

  /**
   * Duplicate check before creating.
   *
   * Separate from `findByNormalizedPhone` because "this customer is new" is a
   * normal answer, not a NotFoundError to be logged as a failure.
   */
  async existsByNormalizedPhone(phoneNormalized) {
    const result = await databaseAdapter.query("customers.existsByNormalizedPhone", (executor) =>
      executor
        .select({ count: count() })
        .from(customers)
        .where(and(eq(customers.phoneNormalized, phoneNormalized), liveOnly)),
    );

    if (!result.ok) {
      return result;
    }

    return ok(readCount(result.value) > 0);
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("customers.list", async (executor) => {
      const items = await executor
        .select()
        .from(customers)
        .where(where)
        .orderBy(desc(customers.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(customers).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async listWithStats(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("customers.listWithStats", async (executor) => {
      /*
       * Tallies come from correlated aggregates rather than a join plus GROUP BY.
       * A join would multiply the customer row by its profiles before grouping;
       * this reads each subquery once per row against an indexed customer_id.
       */
      const rows = await executor
        .select({
          customer: customers,
          activeProfiles: sql<number>`(
            select count(*)::int from ${profiles} p
            where p.customer_id = ${customers.id} and ${ACTIVE_PROFILE_SQL}
          )`,
          expiredProfiles: sql<number>`(
            select count(*)::int from ${profiles} p
            where p.customer_id = ${customers.id} and ${EXPIRED_PROFILE_SQL}
          )`,
        })
        .from(customers)
        .where(where)
        .orderBy(resolveOrderBy(filter))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(customers).where(where);

      const items =
        filter.onlyActive === true ? rows.filter((row) => row.activeProfiles > 0) : rows;

      return { items, total: readCount(totals), limit, offset };
    });
  },

  /**
   * Blocks or unblocks a customer.
   *
   * The only stored part of customer status — the rest is derived. See the
   * schema comment on `blocked_at`.
   */
  async setBlocked(id, blocked) {
    const result = await databaseAdapter.query("customers.setBlocked", (executor) =>
      executor
        .update(customers)
        .set({ blockedAt: blocked ? sql`now()` : null, updatedAt: sql`now()` })
        .where(and(eq(customers.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async create(input) {
    const result = await databaseAdapter.query("customers.create", (executor) =>
      executor.insert(customers).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, input.phoneNormalized);
  },

  async update(id, input) {
    const result = await databaseAdapter.query("customers.update", (executor) =>
      executor
        .update(customers)
        .set({ ...input, updatedAt: sql`now()` })
        .where(and(eq(customers.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Soft delete.
   *
   * Retained because profile_events references customers, and that history must
   * survive. The partial unique index on phone_normalized excludes deleted rows,
   * so the same person can be re-added later.
   */
  async softDelete(id) {
    const result = await databaseAdapter.query("customers.softDelete", (executor) =>
      executor
        .update(customers)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(customers.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },
};
