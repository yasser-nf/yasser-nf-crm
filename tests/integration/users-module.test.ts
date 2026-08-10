import { config } from "dotenv";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

config({ path: ".env.local" });

import { derivePresence } from "@/modules/users";

/**
 * Users module integration tests.
 *
 * These exist because the M06 session and activity reads are hand-written SQL
 * against `auth.sessions` — a schema Supabase owns and TypeScript cannot check.
 * A column rename on the platform side would break session listing and
 * revocation at runtime with every gate still green, so the queries themselves
 * have to be executed against the real database.
 *
 * Read-only by construction. Nothing here deletes a session, because a test that
 * revoked a live session to prove revocation works would sign a real person out.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function anyUserId(): Promise<string | null> {
  const rows = await sql!<{ id: string }[]>`select id from public.users limit 1`;
  return rows[0]?.id ?? null;
}

describe.skipIf(!configured)("sessions repository — real auth schema", () => {
  it("reads every column the projection names", async () => {
    /*
     * Asserts the shape of auth.sessions rather than our query, so a platform
     * change that removes a column fails here with a clear cause instead of
     * surfacing as an empty sessions list.
     */
    const rows = await sql!<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'auth' and table_name = 'sessions'
    `;

    const columns = new Set(rows.map((row) => row.column_name));

    for (const required of [
      "id",
      "user_id",
      "user_agent",
      "ip",
      "created_at",
      "updated_at",
      "not_after",
    ]) {
      expect(columns.has(required), `auth.sessions.${required} is missing`).toBe(true);
    }
  });

  it("executes lastActivityByUser against the live table", async () => {
    const { sessionsRepository } = await import("@/modules/users/repositories/sessions.repository");

    const result = await sessionsRepository.lastActivityByUser();

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const [userId, lastActiveAt] of result.value) {
        expect(typeof userId).toBe("string");
        expect(lastActiveAt).toBeInstanceOf(Date);
        expect(Number.isNaN(lastActiveAt.getTime())).toBe(false);
      }
    }
  });

  it("executes listForUser and returns a usable row shape", async () => {
    const { sessionsRepository } = await import("@/modules/users/repositories/sessions.repository");

    const userId = await anyUserId();
    expect(userId).not.toBeNull();

    const result = await sessionsRepository.listForUser(userId!);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const session of result.value) {
        expect(typeof session.id).toBe("string");
        expect(session.userId).toBe(userId);
        expect(session.createdAt).toBeInstanceOf(Date);
        expect(session.lastActiveAt).toBeInstanceOf(Date);
        /* host(ip) must yield a bare address, never CIDR notation. */
        if (session.ipAddress !== null) {
          expect(session.ipAddress).not.toContain("/");
        }
      }
    }
  });

  it("returns sessions whose timestamps survive derivePresence", async () => {
    /*
     * Regression, BUG-07. `executor.execute` bypasses Drizzle's column mapping,
     * so these timestamps arrived as strings while the declared type said Date.
     * getDetail feeds the newest one straight into derivePresence, which calls
     * getTime() on it — /users/[id] threw for any user holding a live session,
     * and the `as unknown as SessionRow[]` cast meant tsc never saw it.
     */
    const { sessionsRepository } = await import("@/modules/users/repositories/sessions.repository");

    const userId = await anyUserId();
    const result = await sessionsRepository.listForUser(userId!);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const newest = result.value[0]?.lastActiveAt ?? null;
      expect(() => derivePresence(newest, new Date())).not.toThrow();
    }
  });

  it("derives presence from real session activity", async () => {
    const { sessionsRepository } = await import("@/modules/users/repositories/sessions.repository");

    const result = await sessionsRepository.lastActivityByUser();
    expect(result.ok).toBe(true);

    if (result.ok) {
      const now = new Date();

      for (const lastActiveAt of result.value.values()) {
        expect(["online", "idle", "offline"]).toContain(derivePresence(lastActiveAt, now));
      }
    }
  });
});

describe.skipIf(!configured)("activity repository — real tables", () => {
  it("executes the activity UNION and returns it newest first", async () => {
    const { activityRepository } = await import("@/modules/users/repositories/activity.repository");

    const userId = await anyUserId();
    const result = await activityRepository.activityForUser(userId!);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      /*
       * Ordering is the whole point of doing this in SQL. Two queries merged in
       * JavaScript would return the newest N of each source rather than the
       * newest N overall.
       */
      const times = result.value.map((entry) => entry.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      for (const entry of result.value) {
        expect(["audit", "auth"]).toContain(entry.kind);
        expect(entry.createdAt).toBeInstanceOf(Date);
        expect(Number.isNaN(entry.createdAt.getTime())).toBe(false);
      }
    }
  });

  it("executes the login history read", async () => {
    const { activityRepository } = await import("@/modules/users/repositories/activity.repository");

    const userId = await anyUserId();
    const result = await activityRepository.loginHistoryForUser(userId!, { limit: 10 });

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.limit).toBe(10);
      expect(typeof result.value.total).toBe("number");
      expect(result.value.items.length).toBeLessThanOrEqual(10);
    }
  });

  it("keeps user_id and email nullable so failed attempts are still recorded", async () => {
    /*
     * A sign-in attempt against an address matching no user has no user_id. If
     * either column were NOT NULL the insert would fail, and the events most
     * worth seeing would be the ones never written.
     */
    const rows = await sql!<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'login_history'
        and column_name in ('user_id', 'email')
    `;

    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.is_nullable, `login_history.${row.column_name}`).toBe("YES");
    }
  });
});

describe.skipIf(!configured)("users table — M06 status semantics", () => {
  it("offers exactly the three locked statuses and no 'blocked'", async () => {
    const rows = await sql!<{ label: string }[]>`
      select enumlabel as label
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'user_status'
      order by enumsortorder
    `;

    const labels = rows.map((row) => row.label);

    expect(new Set(labels)).toEqual(new Set(["active", "suspended", "disabled"]));
    expect(labels).not.toContain("blocked");
  });

  it("has at least one active Super Admin, so the guard has something to protect", async () => {
    const rows = await sql!<{ count: number }[]>`
      select count(*)::int as count
      from public.users
      where role = 'super_admin' and status = 'active' and deleted_at is null
    `;

    expect(rows[0]?.count ?? 0).toBeGreaterThan(0);
  });
});
