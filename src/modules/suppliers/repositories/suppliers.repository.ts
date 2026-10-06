import { and, asc, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import {
  accountCanAllocateSql,
  accountEffectiveBucketSql,
  accountIsLiveSql,
  isSellableSlotSql,
  profileIsFreeSql,
} from "@/lib/drizzle/predicates";
import { accounts, profiles, suppliers, type SupplierRow } from "@/lib/drizzle/schema";
import { UnexpectedError } from "@/lib/errors";
import { escapeLike } from "@/utils/like";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import type { SupplierFilterInput } from "../validation/supplier.schema";

/**
 * Suppliers repository. M10.
 *
 * Describes WHAT is needed; every statement goes through `databaseAdapter`, so
 * error translation and the retry policy are never bypassed (ADR-005 D5).
 *
 * THE METRICS ARE ONE QUERY, NOT ONE PER SUPPLIER
 *
 * M10 §25 forbids N+1, and a per-supplier loop is the obvious way to get it:
 * five counts for each of twenty suppliers is a hundred round trips. Instead
 * `listWithMetrics` runs a single statement that LEFT JOINs accounts and
 * profiles to suppliers and counts every bucket with `count(*) filter (where …)`
 * — PostgreSQL makes one pass and fills every bucket from it.
 *
 * NO BUCKET IS DEFINED HERE
 *
 * Every `filter (where …)` composes a predicate from `lib/drizzle/predicates`:
 *
 *   healthy / problems / expired / archived   `accountEffectiveBucketSql`, the
 *                                             SQL twin of `accountBucket` +
 *                                             `accountEffectiveStatus`
 *   availableProfiles                         the same conjunction
 *                                             `accountsRepository.listWithCounts`
 *                                             uses, so a supplier's stock figure
 *                                             and the Accounts list agree
 *
 * M10 §12 and §16 require exactly that: no second definition of "problem",
 * "healthy" or "available". `tests/integration/suppliers-m10.test.ts` asserts
 * these counts equal the TypeScript tally over the same rows.
 */

/** Account and profile figures for one supplier. Accounts and profiles stay separate (§13). */
export interface SupplierMetrics {
  /** Live accounts assigned to this supplier. */
  readonly totalAccounts: number;
  /** Effective status "healthy" — exactly `accountCanAllocate`. */
  readonly healthyAccounts: number;
  /** A fault on the account, or a blocking problem against it. */
  readonly problemAccounts: number;
  /** Healthy and unblocked, but the account's own coverage has run out. */
  readonly expiredAccounts: number;
  readonly archivedAccounts: number;
  /** PROFILE figure, never an account one: sellable, free, on an allocatable account. */
  readonly availableProfiles: number;
}

export interface SupplierWithMetrics {
  readonly supplier: SupplierRow;
  readonly metrics: SupplierMetrics;
}

/** Ownership split for the dashboard. M10 §15. */
export interface OwnershipCounts {
  /** `supplier_id is null` — ours. */
  readonly myAccounts: number;
  /** `supplier_id is not null` — bought from somebody. */
  readonly supplierAccounts: number;
  readonly totalAccounts: number;
}

export interface SuppliersRepository {
  findById(id: string): Promise<Result<SupplierRow | null>>;
  findByNormalizedName(nameNormalized: string): Promise<Result<SupplierRow | null>>;
  listWithMetrics(filter?: SupplierFilterInput): Promise<Result<readonly SupplierWithMetrics[]>>;
  metricsFor(supplierId: string): Promise<Result<SupplierMetrics>>;
  ownership(): Promise<Result<OwnershipCounts>>;
  /** Suppliers for a picker: id, name and status only. */
  listOptions(): Promise<Result<readonly SupplierRow[]>>;
  create(input: {
    readonly name: string;
    readonly nameNormalized: string;
    readonly notes: string | null;
    readonly createdBy: string | null;
  }): Promise<Result<SupplierRow>>;
  update(
    id: string,
    input: {
      readonly name?: string | undefined;
      readonly nameNormalized?: string | undefined;
      readonly notes?: string | null | undefined;
    },
  ): Promise<Result<SupplierRow | null>>;
  setDeactivated(id: string, deactivated: boolean): Promise<Result<SupplierRow | null>>;
  /** How many live accounts point at this supplier. Used before deactivating. */
  countAccounts(supplierId: string): Promise<Result<number>>;
}

/**
 * The five metric expressions, built once.
 *
 * A function rather than a constant because each call needs them against the
 * join in hand; the predicates themselves are shared module-level values, so
 * there is still one definition of each rule.
 */
function metricColumns() {
  return {
    /*
     * `count(distinct accounts.id)`, not `count(*)`: the join to profiles
     * multiplies each account by five, and a plain count would report five
     * times the accounts. The profile count below is the only figure that
     * wants the multiplied rows.
     */
    totalAccounts: sql<number>`count(distinct ${accounts.id}) filter (where ${accountIsLiveSql})::int`,
    healthyAccounts: sql<number>`count(distinct ${accounts.id}) filter (
      where ${accountIsLiveSql} and ${accountEffectiveBucketSql("healthy")}
    )::int`,
    problemAccounts: sql<number>`count(distinct ${accounts.id}) filter (
      where ${accountIsLiveSql} and ${accountEffectiveBucketSql("problems")}
    )::int`,
    expiredAccounts: sql<number>`count(distinct ${accounts.id}) filter (
      where ${accountIsLiveSql} and ${accountEffectiveBucketSql("expired")}
    )::int`,
    archivedAccounts: sql<number>`count(distinct ${accounts.id}) filter (
      where ${accountIsLiveSql} and ${accountEffectiveBucketSql("archived")}
    )::int`,
    /*
     * The PROFILE figure. Identical conjunction to
     * `accountsRepository.listWithCounts.availableProfiles`, so a supplier's
     * stock and the Accounts list's cannot disagree. Counted on profile ids, so
     * the join's multiplication is the point rather than a bug.
     */
    availableProfiles: sql<number>`count(${profiles.id}) filter (
      where ${accountIsLiveSql}
        and ${isSellableSlotSql}
        and ${profileIsFreeSql}
        and ${accountCanAllocateSql}
    )::int`,
  };
}

const EMPTY_METRICS: SupplierMetrics = {
  totalAccounts: 0,
  healthyAccounts: 0,
  problemAccounts: 0,
  expiredAccounts: 0,
  archivedAccounts: 0,
  availableProfiles: 0,
};

function statusCondition(status: SupplierFilterInput["status"]) {
  if (status === "active") {
    return isNull(suppliers.deactivatedAt);
  }

  if (status === "inactive") {
    return isNotNull(suppliers.deactivatedAt);
  }

  return undefined;
}

export const suppliersRepository: SuppliersRepository = {
  async findById(id) {
    const rows = await databaseAdapter.query("suppliers.findById", (executor) =>
      executor.select().from(suppliers).where(eq(suppliers.id, id)).limit(1),
    );

    return rows.ok ? ok(rows.value[0] ?? null) : rows;
  },

  /**
   * Looks a supplier up by its comparable name.
   *
   * The read behind the duplicate-name message. The unique index is the real
   * guarantee — this exists so an operator gets "a supplier with that name
   * already exists" instead of a database constraint error.
   */
  async findByNormalizedName(nameNormalized) {
    const rows = await databaseAdapter.query("suppliers.findByName", (executor) =>
      executor
        .select()
        .from(suppliers)
        .where(eq(suppliers.nameNormalized, nameNormalized))
        .limit(1),
    );

    return rows.ok ? ok(rows.value[0] ?? null) : rows;
  },

  /**
   * Every supplier with its five metrics. ONE query.
   *
   * LEFT joins, so a supplier with no accounts yet appears with zeros rather
   * than vanishing — a supplier created a minute ago is exactly the row an
   * operator is looking for.
   */
  async listWithMetrics(filter = { status: "all" }) {
    return databaseAdapter.query("suppliers.listWithMetrics", async (executor) => {
      const conditions = [statusCondition(filter.status)];

      if (filter.search?.trim()) {
        /* Escaped: a name containing % or _ must match literally. */
        conditions.push(ilike(suppliers.name, `%${escapeLike(filter.search.trim())}%`));
      }

      const rows = await executor
        .select({ supplier: suppliers, ...metricColumns() })
        .from(suppliers)
        .leftJoin(accounts, eq(accounts.supplierId, suppliers.id))
        .leftJoin(profiles, eq(profiles.accountId, accounts.id))
        .where(and(...conditions.filter((condition) => condition !== undefined)))
        .groupBy(suppliers.id)
        .orderBy(asc(suppliers.name));

      return rows.map(({ supplier, ...metrics }) => ({ supplier, metrics }));
    });
  },

  /** One supplier's metrics, by the same expressions as the list. */
  async metricsFor(supplierId) {
    const rows = await databaseAdapter.query("suppliers.metricsFor", (executor) =>
      executor
        .select(metricColumns())
        .from(suppliers)
        .leftJoin(accounts, eq(accounts.supplierId, suppliers.id))
        .leftJoin(profiles, eq(profiles.accountId, accounts.id))
        .where(eq(suppliers.id, supplierId))
        .groupBy(suppliers.id),
    );

    return rows.ok ? ok(rows.value[0] ?? EMPTY_METRICS) : rows;
  },

  /**
   * My Accounts against supplier accounts. M10 §15.
   *
   * Counted from `accounts.supplier_id` and nothing else — never from profile
   * ownership, which §15 calls out specifically. One statement, two buckets.
   */
  async ownership() {
    const rows = await databaseAdapter.query("suppliers.ownership", (executor) =>
      executor
        .select({
          myAccounts: sql<number>`count(*) filter (where ${isNull(accounts.supplierId)})::int`,
          supplierAccounts: sql<number>`count(*) filter (where ${isNotNull(accounts.supplierId)})::int`,
          totalAccounts: sql<number>`count(*)::int`,
        })
        .from(accounts)
        .where(accountIsLiveSql),
    );

    if (!rows.ok) {
      return rows;
    }

    return ok(rows.value[0] ?? { myAccounts: 0, supplierAccounts: 0, totalAccounts: 0 });
  },

  /** Every supplier, for a picker. Ordered by name; status derived by the caller. */
  async listOptions() {
    return databaseAdapter.query("suppliers.listOptions", (executor) =>
      executor.select().from(suppliers).orderBy(asc(suppliers.name)),
    );
  },

  async create(input) {
    const rows = await databaseAdapter.query("suppliers.create", (executor) =>
      executor
        .insert(suppliers)
        .values({
          name: input.name,
          nameNormalized: input.nameNormalized,
          notes: input.notes,
          createdBy: input.createdBy,
        })
        .returning(),
    );

    if (!rows.ok) {
      return rows;
    }

    const created = rows.value[0];

    /*
     * Unreachable: an INSERT with no conflict clause either returns its row or
     * raises. Answered as a failure rather than with a non-null assertion,
     * because an assertion here would be the one place a duplicate-name
     * violation could surface as a crash instead of a message.
     */
    return created ? ok(created) : fail(new UnexpectedError("Supplier insert returned no row"));
  },

  async update(id, input) {
    const rows = await databaseAdapter.query("suppliers.update", (executor) =>
      executor
        .update(suppliers)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.nameNormalized === undefined ? {} : { nameNormalized: input.nameNormalized }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          updatedAt: sql`now()`,
        })
        .where(eq(suppliers.id, id))
        .returning(),
    );

    return rows.ok ? ok(rows.value[0] ?? null) : rows;
  },

  /**
   * Deactivates or reactivates.
   *
   * The accounts pointing at this supplier are deliberately untouched. M10 §23:
   * they stay linked, and they must not silently become "My Account".
   */
  async setDeactivated(id, deactivated) {
    const rows = await databaseAdapter.query("suppliers.setDeactivated", (executor) =>
      executor
        .update(suppliers)
        .set({
          deactivatedAt: deactivated ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(eq(suppliers.id, id))
        .returning(),
    );

    return rows.ok ? ok(rows.value[0] ?? null) : rows;
  },

  async countAccounts(supplierId) {
    const rows = await databaseAdapter.query("suppliers.countAccounts", (executor) =>
      executor
        .select({ total: sql<number>`count(*)::int` })
        .from(accounts)
        .where(and(eq(accounts.supplierId, supplierId), accountIsLiveSql)),
    );

    return rows.ok ? ok(rows.value[0]?.total ?? 0) : rows;
  },
};
