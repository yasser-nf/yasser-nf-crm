import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import {
  accounts,
  auditLogs,
  customers,
  issueNotes,
  issues,
  profiles,
  users,
  type IssueNoteRow,
  type IssueRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";
import { ACTIVE_STATUSES, type ProblemStatus } from "../services/problem-lifecycle";

/**
 * Problems repository.
 *
 * ADR-005 Decision 5: repositories may use the Drizzle query builder and schema,
 * never the connection. Every statement runs through the Database Adapter.
 *
 * It describes data operations only. Which transitions are legal, who may act,
 * and what gets audited are all service concerns and appear nowhere here.
 */

export interface ProblemFilter extends PaginationInput {
  readonly search?: string | undefined;
  readonly status?: ProblemStatus | undefined;
  /**
   * Only problems in a blocking status — the ones stopping an account from
   * selling right now. Ignored when `status` names one status exactly.
   */
  readonly blocking?: boolean | undefined;
  readonly severity?: IssueRow["severity"] | undefined;
  readonly issueType?: IssueRow["issueType"] | undefined;
  readonly assignedTo?: string | undefined;
  readonly accountId?: string | undefined;
  readonly createdAfter?: Date | undefined;
  readonly createdBefore?: Date | undefined;
  readonly sortBy?: "createdAt" | "updatedAt" | "severity" | "status" | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

/**
 * A problem with everything the list needs, resolved in one query.
 *
 * The joins exist so the list never issues a lookup per row. Account email,
 * assignee and reporter are all shown per line, and three round trips per row
 * against a page of 25 is the N+1 the brief forbids.
 */
export interface ProblemListEntry {
  readonly problem: IssueRow;
  readonly accountEmail: string;
  readonly accountStatus: string;
  readonly assignedToName: string | null;
  readonly reportedByName: string | null;
}

export interface ProblemsRepository {
  list(filter?: ProblemFilter): Promise<Result<Page<ProblemListEntry>>>;
  findById(id: string): Promise<Result<IssueRow>>;
  findDetail(id: string): Promise<Result<ProblemListEntry>>;
  create(input: typeof issues.$inferInsert): Promise<Result<IssueRow>>;
  update(id: string, patch: Partial<typeof issues.$inferInsert>): Promise<Result<IssueRow>>;
  remove(id: string): Promise<Result<IssueRow>>;

  /** Accounts with at least one blocking problem. Powers the allocation rule. */
  /**
   * The accounts, among these, with at least one blocking problem — and which
   * types those problems are. An account absent from the map has none.
   */
  accountsWithActiveProblems(
    accountIds: readonly string[],
  ): Promise<Result<ReadonlyMap<string, readonly IssueRow["issueType"][]>>>;
  activeForAccount(accountId: string): Promise<Result<readonly IssueRow[]>>;
  /** Active problems across every account a customer currently holds a profile on. */
  activeForCustomer(customerId: string): Promise<Result<readonly ProblemListEntry[]>>;

  addNote(input: typeof issueNotes.$inferInsert): Promise<Result<IssueNoteRow>>;
  notesFor(
    issueId: string,
  ): Promise<Result<readonly (IssueNoteRow & { authorName: string | null })[]>>;
  /** Audit history for one problem, newest first. The timeline source. */
  historyFor(issueId: string, limit?: number): Promise<Result<readonly TimelineAuditRow[]>>;
}

export interface TimelineAuditRow {
  readonly id: string;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly userId: string | null;
  readonly actorName: string | null;
  readonly createdAt: Date;
}

const SORT_COLUMNS = {
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  severity: issues.severity,
  status: issues.status,
} as const;

/**
 * The reporter, joined a second time.
 *
 * `assigned_to` and `reported_by` both point at users, so the table appears
 * twice in one query and needs distinct aliases. Drizzle's `alias` does that
 * properly; hand-written SQL in a join clause would bypass the query builder's
 * type checking for no benefit.
 */
const reporter = alias(users, "reporter");

function buildWhere(filter: ProblemFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    filter.status ? eq(issues.status, filter.status) : undefined,
    !filter.status && filter.blocking ? inArray(issues.status, [...ACTIVE_STATUSES]) : undefined,
    filter.severity ? eq(issues.severity, filter.severity) : undefined,
    filter.issueType ? eq(issues.issueType, filter.issueType) : undefined,
    filter.assignedTo ? eq(issues.assignedTo, filter.assignedTo) : undefined,
    filter.accountId ? eq(issues.accountId, filter.accountId) : undefined,
    filter.createdAfter ? sql`${issues.createdAt} >= ${filter.createdAfter}` : undefined,
    filter.createdBefore ? sql`${issues.createdAt} <= ${filter.createdBefore}` : undefined,
  ];

  const search = filter.search?.trim();

  if (search) {
    const pattern = `%${search}%`;

    /*
     * Searchable by problem id, account email, assignee, and customer name or
     * phone — the M08 search list. Customer reaches through profiles, because a
     * problem belongs to an account and customers attach to its profiles. That
     * is an EXISTS rather than another join, so an account with five profiles
     * cannot multiply its problem into five list rows.
     */
    const customerMatch = sql`exists (
      select 1
      from ${profiles} p
      join ${customers} c on c.id = p.customer_id
      where p.account_id = ${issues.accountId}
        and (c.name ilike ${pattern} or c.phone_normalized ilike ${pattern})
    )`;

    conditions.push(
      or(
        sql`${issues.id}::text ilike ${pattern}`,
        ilike(accounts.email, pattern),
        ilike(users.name, pattern),
        customerMatch,
      ),
    );
  }

  const active = conditions.filter((condition): condition is SQL => condition !== undefined);

  return active.length > 0 ? and(...active) : undefined;
}

export const problemsRepository: ProblemsRepository = {
  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildWhere(filter);

    const column = SORT_COLUMNS[filter.sortBy ?? "createdAt"];
    const order = filter.sortDirection === "asc" ? column : desc(column);

    return databaseAdapter.transaction("problems.list", async (executor) => {
      const rows = await executor
        .select({
          problem: issues,
          accountEmail: accounts.email,
          accountStatus: accounts.status,
          assignedToName: users.name,
          reportedByName: reporter.name,
        })
        .from(issues)
        .innerJoin(accounts, eq(accounts.id, issues.accountId))
        .leftJoin(users, eq(users.id, issues.assignedTo))
        .leftJoin(reporter, eq(reporter.id, issues.reportedBy))
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(offset);

      const totals = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .innerJoin(accounts, eq(accounts.id, issues.accountId))
        .leftJoin(users, eq(users.id, issues.assignedTo))
        .where(where);

      return { items: rows, total: readCount(totals), limit, offset };
    });
  },

  async findById(id) {
    const result = await databaseAdapter.query("problems.findById", (executor) =>
      executor.select().from(issues).where(eq(issues.id, id)).limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Problem", id);
  },

  async findDetail(id) {
    const result = await databaseAdapter.query("problems.findDetail", (executor) =>
      executor
        .select({
          problem: issues,
          accountEmail: accounts.email,
          accountStatus: accounts.status,
          assignedToName: users.name,
          reportedByName: reporter.name,
        })
        .from(issues)
        .innerJoin(accounts, eq(accounts.id, issues.accountId))
        .leftJoin(users, eq(users.id, issues.assignedTo))
        .leftJoin(reporter, eq(reporter.id, issues.reportedBy))
        .where(eq(issues.id, id))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Problem", id);
  },

  async create(input) {
    const result = await databaseAdapter.query("problems.create", (executor) =>
      executor.insert(issues).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Problem", "created");
  },

  async update(id, patch) {
    const result = await databaseAdapter.query("problems.update", (executor) =>
      executor
        .update(issues)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(issues.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Problem", id);
  },

  async remove(id) {
    const result = await databaseAdapter.query("problems.remove", (executor) =>
      executor.delete(issues).where(eq(issues.id, id)).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Problem", id);
  },

  async accountsWithActiveProblems(accountIds) {
    if (accountIds.length === 0) {
      return ok(new Map<string, IssueRow["issueType"][]>());
    }

    /*
     * One grouped read for a whole page of accounts, never one query per
     * account. Hits the partial index on (account_id) where status is blocking.
     */
    const result = await databaseAdapter.query(
      "problems.accountsWithActiveProblems",
      async (executor) => {
        const rows = await executor
          .selectDistinct({ accountId: issues.accountId, issueType: issues.issueType })
          .from(issues)
          .where(
            and(
              inArray(issues.accountId, [...accountIds]),
              inArray(issues.status, [...ACTIVE_STATUSES]),
            ),
          );

        return rows;
      },
    );

    if (!result.ok) {
      return result;
    }

    /*
     * Grouped here rather than in SQL: a page holds at most a few dozen
     * accounts, and `array_agg` would hand back a driver-shaped array to parse.
     */
    const byAccount = new Map<string, IssueRow["issueType"][]>();

    for (const { accountId, issueType } of result.value) {
      const types = byAccount.get(accountId) ?? [];
      types.push(issueType);
      byAccount.set(accountId, types);
    }

    return ok(byAccount);
  },

  async activeForAccount(accountId) {
    return databaseAdapter.query("problems.activeForAccount", (executor) =>
      executor
        .select()
        .from(issues)
        .where(and(eq(issues.accountId, accountId), inArray(issues.status, [...ACTIVE_STATUSES])))
        .orderBy(desc(issues.createdAt)),
    );
  },

  async activeForCustomer(customerId) {
    return databaseAdapter.query("problems.activeForCustomer", (executor) =>
      executor
        .selectDistinctOn([issues.id], {
          problem: issues,
          accountEmail: accounts.email,
          accountStatus: accounts.status,
          assignedToName: users.name,
          reportedByName: sql<string | null>`null`,
        })
        .from(issues)
        .innerJoin(accounts, eq(accounts.id, issues.accountId))
        .innerJoin(profiles, eq(profiles.accountId, issues.accountId))
        .leftJoin(users, eq(users.id, issues.assignedTo))
        .where(
          and(eq(profiles.customerId, customerId), inArray(issues.status, [...ACTIVE_STATUSES])),
        ),
    );
  },

  async addNote(input) {
    const result = await databaseAdapter.query("problems.addNote", (executor) =>
      executor.insert(issueNotes).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Note", "created");
  },

  async notesFor(issueId) {
    return databaseAdapter.query("problems.notesFor", (executor) =>
      executor
        .select({
          id: issueNotes.id,
          issueId: issueNotes.issueId,
          userId: issueNotes.userId,
          body: issueNotes.body,
          createdAt: issueNotes.createdAt,
          authorName: users.name,
        })
        .from(issueNotes)
        .leftJoin(users, eq(users.id, issueNotes.userId))
        .where(eq(issueNotes.issueId, issueId))
        .orderBy(desc(issueNotes.createdAt)),
    );
  },

  async historyFor(issueId, limit = 100) {
    /*
     * The timeline reads audit_logs rather than a second history table. ADR-010
     * Decision 3: audit already records every mutation with before and after, so
     * a parallel events table would duplicate it and the two could disagree.
     */
    return databaseAdapter.query("problems.historyFor", (executor) =>
      executor
        .select({
          id: auditLogs.id,
          action: sql<string>`${auditLogs.action}::text`,
          before: auditLogs.before,
          after: auditLogs.after,
          userId: auditLogs.userId,
          actorName: users.name,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(and(eq(auditLogs.entity, "issue"), eq(auditLogs.entityId, issueId)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit),
    );
  },
};
