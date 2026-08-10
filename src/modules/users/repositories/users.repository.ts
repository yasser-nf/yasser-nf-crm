import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { users, type UserRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";
import type { UserInsert, UserUpdate } from "../validation/user.schema";

/**
 * Users repository.
 *
 * ADR-005 Decision 5: describes WHAT data is needed using the schema's
 * vocabulary. The Database Adapter decides HOW — connection, transaction, retry,
 * error translation. This file cannot obtain a connection, so it cannot bypass
 * any of that.
 *
 * ADR-003: returns Result, never null. A missing row is a Failure carrying
 * NotFoundError.
 *
 * Every read filters out soft-deleted rows. A repository that returns deleted
 * records by default turns every caller into a place the filter can be forgotten.
 */

const ENTITY = "User";

/** Live rows only. Deleted users remain for audit history, not for reading. */
const liveOnly = isNull(users.deletedAt);

export type UserSortField = "name" | "email" | "role" | "status" | "lastLoginAt" | "createdAt";

export interface UserFilter extends PaginationInput {
  readonly role?: UserRow["role"] | undefined;
  readonly status?: UserRow["status"] | undefined;
  /** Matches name and email. */
  readonly search?: string | undefined;
  readonly sortBy?: UserSortField | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

const SORT_COLUMNS = {
  name: users.name,
  email: users.email,
  role: users.role,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
} as const;

/** Resolved through a lookup table so a query-string value never reaches SQL. */
function resolveOrderBy(filter: UserFilter) {
  const column = SORT_COLUMNS[filter.sortBy ?? "createdAt"];
  return filter.sortDirection === "asc" ? asc(column) : desc(column);
}

export interface UsersRepository {
  findById(id: string): Promise<Result<UserRow>>;
  findByEmail(email: string): Promise<Result<UserRow>>;
  exists(id: string): Promise<Result<boolean>>;
  list(filter?: UserFilter): Promise<Result<Page<UserRow>>>;
  create(input: UserInsert): Promise<Result<UserRow>>;
  update(id: string, input: UserUpdate): Promise<Result<UserRow>>;
  recordLogin(id: string): Promise<Result<UserRow>>;
  /** Changes role. Authorization belongs to the service, not here. */
  setRole(id: string, role: UserRow["role"]): Promise<Result<UserRow>>;
  setStatus(id: string, status: UserRow["status"]): Promise<Result<UserRow>>;
  /** Counts Super Admins who can still sign in. Guards the last-admin rule. */
  countActiveSuperAdmins(excludingId?: string): Promise<Result<number>>;
  softDelete(id: string): Promise<Result<UserRow>>;
}

function buildFilter(filter: UserFilter) {
  const conditions = [liveOnly];

  if (filter.role !== undefined) {
    conditions.push(eq(users.role, filter.role));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(users.status, filter.status));
  }

  if (filter.search?.trim()) {
    const term = `%${filter.search.trim()}%`;
    const matches = or(ilike(users.name, term), ilike(users.email, term));

    if (matches !== undefined) {
      conditions.push(matches);
    }
  }

  return and(...conditions);
}

export const usersRepository: UsersRepository = {
  async findById(id) {
    const result = await databaseAdapter.query("users.findById", (executor) =>
      executor
        .select()
        .from(users)
        .where(and(eq(users.id, id), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async findByEmail(email) {
    const normalized = email.trim().toLowerCase();

    const result = await databaseAdapter.query("users.findByEmail", (executor) =>
      executor
        .select()
        .from(users)
        .where(and(eq(users.email, normalized), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, normalized);
  },

  /**
   * Presence check that does not fail when absent.
   *
   * `findById` is the wrong tool for "should I create this?" — a NotFoundError
   * would be logged as a failure for a perfectly normal answer.
   */
  async exists(id) {
    const result = await databaseAdapter.query("users.exists", (executor) =>
      executor
        .select({ count: count() })
        .from(users)
        .where(and(eq(users.id, id), liveOnly)),
    );

    if (!result.ok) {
      return result;
    }

    return ok(readCount(result.value) > 0);
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    /*
     * Page and total in one transaction so the count cannot describe a different
     * set than the rows — without it, a concurrent insert produces a total that
     * disagrees with the page the user is looking at.
     */
    return databaseAdapter.transaction("users.list", async (executor) => {
      const items = await executor
        .select()
        .from(users)
        .where(where)
        .orderBy(resolveOrderBy(filter))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(users).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async create(input) {
    const result = await databaseAdapter.query("users.create", (executor) =>
      executor.insert(users).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, input.id);
  },

  async update(id, input) {
    const result = await databaseAdapter.query("users.update", (executor) =>
      executor
        .update(users)
        .set({ ...input, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async recordLogin(id) {
    const result = await databaseAdapter.query("users.recordLogin", (executor) =>
      executor
        .update(users)
        .set({ lastLoginAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async setRole(id, role) {
    const result = await databaseAdapter.query("users.setRole", (executor) =>
      executor
        .update(users)
        .set({ role, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async setStatus(id, status) {
    const result = await databaseAdapter.query("users.setStatus", (executor) =>
      executor
        .update(users)
        .set({ status, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Counts Super Admins who could still sign in.
   *
   * Only `active` counts: a suspended or disabled admin cannot authenticate, so
   * they are no protection against locking everyone out. `excludingId` lets a
   * caller ask "if I change this one, is anybody left?".
   */
  async countActiveSuperAdmins(excludingId) {
    const conditions = [liveOnly, eq(users.role, "super_admin"), eq(users.status, "active")];

    if (excludingId !== undefined) {
      conditions.push(ne(users.id, excludingId));
    }

    const result = await databaseAdapter.query("users.countActiveSuperAdmins", (executor) =>
      executor
        .select({ count: count() })
        .from(users)
        .where(and(...conditions)),
    );

    if (!result.ok) {
      return result;
    }

    return ok(readCount(result.value));
  },

  /**
   * Soft delete.
   *
   * The row is retained because audit_logs references it. Also disables the
   * account, so a single check on `status` is enough to deny access — a caller
   * that forgets to test `deletedAt` still fails closed.
   */
  async softDelete(id) {
    const result = await databaseAdapter.query("users.softDelete", (executor) =>
      executor
        .update(users)
        .set({ deletedAt: sql`now()`, status: "disabled", updatedAt: sql`now()` })
        .where(and(eq(users.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },
};
