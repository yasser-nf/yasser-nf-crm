import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { customers, type CustomerRow } from "@/lib/drizzle/schema";
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

export interface CustomerFilter extends PaginationInput {
  /** Matches name, either phone form, or notes. */
  readonly search?: string | undefined;
}

export interface CustomersRepository {
  findById(id: string): Promise<Result<CustomerRow>>;
  findByNormalizedPhone(phoneNormalized: string): Promise<Result<CustomerRow>>;
  existsByNormalizedPhone(phoneNormalized: string): Promise<Result<boolean>>;
  list(filter?: CustomerFilter): Promise<Result<Page<CustomerRow>>>;
  create(input: CustomerInsert): Promise<Result<CustomerRow>>;
  update(id: string, input: CustomerUpdate): Promise<Result<CustomerRow>>;
  softDelete(id: string): Promise<Result<CustomerRow>>;
}

function buildFilter(filter: CustomerFilter) {
  if (!filter.search?.trim()) {
    return liveOnly;
  }

  const term = `%${filter.search.trim()}%`;

  return and(
    liveOnly,
    or(
      ilike(customers.name, term),
      ilike(customers.phoneOriginal, term),
      ilike(customers.phoneNormalized, term),
      ilike(customers.notes, term),
    ),
  );
}

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
