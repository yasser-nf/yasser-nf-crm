import { sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";

/**
 * Sessions repository.
 *
 * Reads `auth.sessions` directly. The M06 brief requires reusing Supabase Auth
 * sessions rather than creating a second table, and the probe confirmed that
 * table already carries everything needed: user_agent, ip, created_at,
 * updated_at, not_after.
 *
 * Raw SQL rather than Drizzle table objects, deliberately. The auth schema
 * belongs to Supabase and its shape can change between platform releases.
 * Declaring it in our schema would make drizzle-kit believe it owns those
 * tables and try to migrate them — exactly the reason ADR-005 kept the
 * auth.users foreign key as hand-written SQL.
 */

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly notAfter: Date | null;
}

export interface SessionsRepository {
  listForUser(userId: string): Promise<Result<readonly SessionRow[]>>;
  /** Newest activity per user. Powers the online/idle/offline column. */
  lastActivityByUser(): Promise<Result<ReadonlyMap<string, Date>>>;
  revoke(sessionId: string): Promise<Result<number>>;
  revokeAllForUser(userId: string): Promise<Result<number>>;
}

/**
 * Raw shape returned by the driver.
 *
 * `executor.execute` runs the statement without Drizzle's column mapping, so
 * timestamps arrive as strings even though a Drizzle `select` on a declared
 * table would hand back Date objects. Naming that explicitly is the point: an
 * `as SessionRow[]` cast over these rows type-checks and then fails at runtime
 * the moment anything calls a Date method — which is exactly what happened
 * before this type existed.
 */
interface RawSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string | Date;
  readonly lastActiveAt: string | Date;
  readonly notAfter: string | Date | null;
}

function toSessionRow(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    userId: row.userId,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    createdAt: new Date(row.createdAt),
    lastActiveAt: new Date(row.lastActiveAt),
    notAfter: row.notAfter === null ? null : new Date(row.notAfter),
  };
}

/* Shared projection, so both reads return an identical shape. */
const SESSION_COLUMNS = sql`
  id,
  user_id       as "userId",
  user_agent    as "userAgent",
  host(ip)      as "ipAddress",
  created_at    as "createdAt",
  updated_at    as "lastActiveAt",
  not_after     as "notAfter"
`;

export const sessionsRepository: SessionsRepository = {
  async listForUser(userId) {
    const result = await databaseAdapter.query("sessions.listForUser", async (executor) => {
      const rows = await executor.execute(sql`
        select ${SESSION_COLUMNS}
        from auth.sessions
        where user_id = ${userId}
          and (not_after is null or not_after > now())
        order by updated_at desc
      `);

      return (rows as unknown as RawSessionRow[]).map(toSessionRow);
    });

    return result;
  },

  /**
   * Latest session activity for every user, in one query.
   *
   * A Map rather than a list so the users page can annotate rows without a
   * lookup per row — the N+1 the brief asks us to avoid.
   */
  async lastActivityByUser() {
    const result = await databaseAdapter.query("sessions.lastActivityByUser", async (executor) => {
      const rows = await executor.execute(sql`
        select user_id as "userId", max(updated_at) as "lastActiveAt"
        from auth.sessions
        where not_after is null or not_after > now()
        group by user_id
      `);

      return rows as unknown as { userId: string; lastActiveAt: string | Date }[];
    });

    if (!result.ok) {
      return result;
    }

    return ok(new Map(result.value.map((row) => [row.userId, new Date(row.lastActiveAt)])));
  },

  /**
   * Revokes one session.
   *
   * Deleting the row is how a session ends in Supabase — the access token stays
   * valid until it expires (an hour at most), but no refresh can follow, so the
   * session cannot be extended. There is no way to invalidate an already-issued
   * JWT, which is a property of the token format rather than of this code.
   */
  async revoke(sessionId) {
    const result = await databaseAdapter.query("sessions.revoke", async (executor) => {
      const rows = await executor.execute(sql`
        delete from auth.sessions where id = ${sessionId} returning id
      `);

      return (rows as unknown as unknown[]).length;
    });

    return result;
  },

  async revokeAllForUser(userId) {
    return databaseAdapter.query("sessions.revokeAllForUser", async (executor) => {
      const rows = await executor.execute(sql`
        delete from auth.sessions where user_id = ${userId} returning id
      `);

      return (rows as unknown as unknown[]).length;
    });
  },
};
