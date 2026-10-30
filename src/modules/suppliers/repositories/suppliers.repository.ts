import { and, asc, count, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type Page,
} from "@/lib/database";
import { accountHasNoBlockingProblemSql } from "@/lib/drizzle/predicates";
import {
  accounts,
  suppliers,
  type AccountRow,
  type NewSupplierRow,
  type SupplierRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { escapeLike } from "@/utils/like";

/**
 * Supplier reads and writes (M09B).
 *
 * Every figure on the Suppliers page is an aggregate computed by PostgreSQL —
 * one query for the whole list, not one per supplier. Counting in the service
 * would mean a query per row, and the page is a list of suppliers each of
 * which may hold dozens of accounts.
 */

/** Live = not soft-deleted. The convention every account metric already uses. */
const liveSupplier = isNull(suppliers.deletedAt);
const liveAccount = isNull(accounts.deletedAt);

/** The canonical "this account has a problem": an open, in-progress or waiting issue. */
const accountHasProblemSql = sql<boolean>`not (${accountHasNoBlockingProblemSql})`;

export interface SupplierWithCounts {
  readonly supplier: SupplierRow;
  /** Live accounts naming this supplier. */
  readonly accountCount: number;
  /** Of those, how many currently have a blocking problem. */
  readonly problemCount: number;
}

export interface SupplierFilter {
  readonly search?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface SupplierMetrics {
  readonly totalSuppliers: number;
  /** Accounts explicitly classified `supplied`, live. */
  readonly suppliedAccounts: number;
  /** Supplied accounts that do not yet name a supplier. */
  readonly suppliedWithoutSupplier: number;
  /** Supplied accounts with a blocking problem — counted once each. */
  readonly accountsWithProblems: number;
  /** Still unclassified. Zero once every account has been triaged. */
  readonly unknownOwnership: number;
}

export interface SuppliersRepository {
  list(filter: SupplierFilter): Promise<Result<Page<SupplierWithCounts>>>;
  findById(id: string): Promise<Result<SupplierWithCounts | null>>;
  /** Live, unarchived suppliers for a picker. Name and id only. */
  options(): Promise<Result<readonly { readonly id: string; readonly name: string }[]>>;
  metrics(): Promise<Result<SupplierMetrics>>;
  /** Live accounts naming this supplier, with their problem flag. */
  accountsFor(
    supplierId: string,
    filter: {
      readonly withProblemsOnly?: boolean | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ): Promise<Result<Page<{ readonly account: AccountRow; readonly hasProblem: boolean }>>>;
  /** Supplied accounts with no supplier yet — the triage list. */
  unassignedAccounts(limit: number): Promise<Result<readonly AccountRow[]>>;
  create(values: NewSupplierRow): Promise<Result<SupplierRow>>;
  update(id: string, values: Partial<NewSupplierRow>): Promise<Result<SupplierRow | null>>;
  /** Live accounts naming this supplier — the guard before deleting one. */
  countAccounts(executor: DatabaseExecutor, supplierId: string): Promise<number>;
  /** Soft delete, inside the caller's transaction. */
  softDelete(executor: DatabaseTransaction, id: string): Promise<SupplierRow | null>;
  findRow(executor: DatabaseExecutor, id: string): Promise<SupplierRow | null>;
}

function searchCondition(search: string | undefined): SQL | undefined {
  const term = search?.trim();
  return term ? ilike(suppliers.name, `%${escapeLike(term)}%`) : undefined;
}

export const suppliersRepository: SuppliersRepository = {
  async list(filter) {
    const { limit, offset } = normalizePagination(filter);
    const conditions: SQL[] = [liveSupplier];
    const search = searchCondition(filter.search);

    if (search) conditions.push(search);
    if (!filter.includeArchived) conditions.push(isNull(suppliers.archivedAt));

    const where = and(...conditions);

    return databaseAdapter.query("suppliers.list", async (executor) => {
      const [items, totals] = await Promise.all([
        executor
          .select({
            supplier: suppliers,
            accountCount: sql<number>`count(${accounts.id}) filter (where ${liveAccount})::int`,
            problemCount: sql<number>`count(${accounts.id}) filter (where ${liveAccount} and ${accountHasProblemSql})::int`,
          })
          .from(suppliers)
          .leftJoin(accounts, eq(accounts.supplierId, suppliers.id))
          .where(where)
          .groupBy(suppliers.id)
          .orderBy(asc(sql`lower(${suppliers.name})`))
          .limit(limit)
          .offset(offset),
        executor.select({ total: count() }).from(suppliers).where(where),
      ]);

      return {
        items: items.map((row) => ({
          supplier: row.supplier,
          accountCount: Number(row.accountCount),
          problemCount: Number(row.problemCount),
        })),
        total: totals[0]?.total ?? 0,
        limit,
        offset,
      };
    });
  },

  async findById(id) {
    return databaseAdapter.query("suppliers.findById", async (executor) => {
      const [row] = await executor
        .select({
          supplier: suppliers,
          accountCount: sql<number>`count(${accounts.id}) filter (where ${liveAccount})::int`,
          problemCount: sql<number>`count(${accounts.id}) filter (where ${liveAccount} and ${accountHasProblemSql})::int`,
        })
        .from(suppliers)
        .leftJoin(accounts, eq(accounts.supplierId, suppliers.id))
        .where(and(eq(suppliers.id, id), liveSupplier))
        .groupBy(suppliers.id);

      return row
        ? {
            supplier: row.supplier,
            accountCount: Number(row.accountCount),
            problemCount: Number(row.problemCount),
          }
        : null;
    });
  },

  async options() {
    return databaseAdapter.query("suppliers.options", async (executor) =>
      executor
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(and(liveSupplier, isNull(suppliers.archivedAt)))
        .orderBy(asc(sql`lower(${suppliers.name})`))
        .limit(500),
    );
  },

  async metrics() {
    return databaseAdapter.query("suppliers.metrics", async (executor) => {
      const [row] = await executor
        .select({
          suppliedAccounts: sql<number>`count(*) filter (where ${accounts.ownership} = 'supplied')::int`,
          suppliedWithoutSupplier: sql<number>`count(*) filter (where ${accounts.ownership} = 'supplied' and ${accounts.supplierId} is null)::int`,
          accountsWithProblems: sql<number>`count(*) filter (where ${accounts.ownership} = 'supplied' and ${accountHasProblemSql})::int`,
          unknownOwnership: sql<number>`count(*) filter (where ${accounts.ownership} = 'unknown')::int`,
        })
        .from(accounts)
        .where(liveAccount);

      const [total] = await executor
        .select({ total: count() })
        .from(suppliers)
        .where(and(liveSupplier, isNull(suppliers.archivedAt)));

      return {
        totalSuppliers: total?.total ?? 0,
        suppliedAccounts: Number(row?.suppliedAccounts ?? 0),
        suppliedWithoutSupplier: Number(row?.suppliedWithoutSupplier ?? 0),
        accountsWithProblems: Number(row?.accountsWithProblems ?? 0),
        unknownOwnership: Number(row?.unknownOwnership ?? 0),
      };
    });
  },

  async accountsFor(supplierId, filter) {
    const { limit, offset } = normalizePagination(filter);
    const conditions: SQL[] = [eq(accounts.supplierId, supplierId), liveAccount];

    if (filter.withProblemsOnly) {
      conditions.push(accountHasProblemSql);
    }

    const where = and(...conditions);

    return databaseAdapter.query("suppliers.accountsFor", async (executor) => {
      const [items, totals] = await Promise.all([
        executor
          .select({ account: accounts, hasProblem: accountHasProblemSql })
          .from(accounts)
          .where(where)
          .orderBy(asc(accounts.email))
          .limit(limit)
          .offset(offset),
        executor.select({ total: count() }).from(accounts).where(where),
      ]);

      return {
        items: items.map((row) => ({ account: row.account, hasProblem: row.hasProblem === true })),
        total: totals[0]?.total ?? 0,
        limit,
        offset,
      };
    });
  },

  async unassignedAccounts(limit) {
    return databaseAdapter.query("suppliers.unassignedAccounts", async (executor) =>
      executor
        .select()
        .from(accounts)
        .where(and(liveAccount, eq(accounts.ownership, "supplied"), isNull(accounts.supplierId)))
        .orderBy(asc(accounts.email))
        .limit(limit),
    );
  },

  async create(values) {
    return databaseAdapter.query("suppliers.create", async (executor) => {
      const [row] = await executor.insert(suppliers).values(values).returning();

      if (!row) {
        throw new Error("Supplier insert returned no row");
      }

      return row;
    });
  },

  async update(id, values) {
    return databaseAdapter.query("suppliers.update", async (executor) => {
      const [row] = await executor
        .update(suppliers)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(suppliers.id, id), liveSupplier))
        .returning();

      return row ?? null;
    });
  },

  async countAccounts(executor, supplierId) {
    const [row] = await executor
      .select({ total: count() })
      .from(accounts)
      .where(and(eq(accounts.supplierId, supplierId), liveAccount));

    return row?.total ?? 0;
  },

  async softDelete(executor, id) {
    const [row] = await executor
      .update(suppliers)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(suppliers.id, id), liveSupplier))
      .returning();

    return row ?? null;
  },

  async findRow(executor, id) {
    const [row] = await executor
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, id), liveSupplier));

    return row ?? null;
  },
};
