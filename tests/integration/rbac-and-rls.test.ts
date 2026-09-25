import { config } from "dotenv";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

config({ path: ".env.local" });

/**
 * Authorization and RLS integration tests.
 *
 * Runs against the real database. These are the checks that would have caught
 * SEC-01 — every earlier suite ran as the application, so nothing ever asked
 * what an attacker reaches with the browser key.
 *
 * Skipped automatically when no real project is configured, so a fresh clone
 * still passes `npm run verify`.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
const ANON_KEY = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "";

const configured =
  !DATABASE_URL.includes("placeholder") &&
  !SUPABASE_URL.includes("placeholder") &&
  !ANON_KEY.includes("placeholder-anon-key");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Every table in `public`.
 *
 * The count is asserted, not just the membership: a table added without RLS
 * would otherwise pass silently, which is exactly how login_history slipped
 * through in M06 — `ALTER DEFAULT PRIVILEGES` governs grants, not row security,
 * so anything created after migration 0002 starts with RLS off.
 */
const TABLES = [
  "users",
  "customers",
  "accounts",
  "profiles",
  "profile_events",
  "audit_logs",
  "login_history",
  "backups",
  "settings",
  /* M08. Added here in the same change that created them, not in a follow-up. */
  "issues",
  "issue_notes",
  /* M09 added no tables. M10 adds one. */
  "report_presets",
  /* M05 (notifications). Added in the same change that created it. */
  "notifications",
] as const;

describe.skipIf(!configured)("RLS — anonymous access", () => {
  /*
   * The attacker's view: the anon key is NEXT_PUBLIC and ships in the browser
   * bundle. Anything reachable with it is public.
   */
  for (const table of TABLES) {
    it(`denies anonymous SELECT on ${table}`, async () => {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  }

  it("denies anonymous INSERT", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/customers`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone_original: "0663000000",
        phone_normalized: "663000000",
        whatsapp_url: "https://wa.me/213663000000",
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("denies anonymous DELETE", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/accounts?id=neq.null`, {
      method: "DELETE",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe.skipIf(!configured)("RLS — database configuration", () => {
  it("has RLS enabled on every table", async () => {
    const rows = await sql!`
      select relname, relrowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r'`;

    const disabled = rows.filter((r) => !r["relrowsecurity"]).map((r) => r["relname"]);
    expect(disabled).toEqual([]);
    expect(rows).toHaveLength(TABLES.length);
  });

  it("grants nothing to anon or authenticated", async () => {
    const rows = await sql!`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')`;

    expect(rows).toEqual([]);
  });

  it("defines policies on every table", async () => {
    const rows = await sql!`
      select tablename, count(*)::int as n
      from pg_policies where schemaname = 'public' group by tablename`;

    const covered = new Set(rows.map((r) => r["tablename"] as string));
    for (const table of TABLES) {
      expect(covered.has(table)).toBe(true);
    }
  });

  it("gives append-only tables no UPDATE or DELETE policy", async () => {
    /*
     * profile_events, audit_logs and login_history are all append-only. An
     * absent policy is stronger than one returning false: there is nothing to
     * edit rather than a rule that could be got wrong.
     */
    const rows = await sql!`
      select tablename, cmd from pg_policies
      where schemaname = 'public'
        and tablename in ('profile_events', 'audit_logs', 'login_history')
        and cmd in ('UPDATE', 'DELETE')`;

    expect(rows).toEqual([]);
  });

  it("pins search_path on every SECURITY DEFINER helper", async () => {
    const rows = await sql!`
      select p.proname, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const config = (row["proconfig"] as string[] | null) ?? [];
      expect(config.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
  });
});

describe.skipIf(!configured)("Role resolution", () => {
  it("the super admin has a role in public.users", async () => {
    const rows = await sql!`
      select id, email, role, status from public.users where role = 'super_admin' limit 1`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("active");
  });

  it("every CRM user maps to a Supabase Auth identity", async () => {
    const rows = await sql!`
      select u.id from public.users u
      left join auth.users a on a.id = u.id
      where a.id is null`;

    expect(rows).toEqual([]);
  });

  it("role is not duplicated into Supabase Auth metadata", async () => {
    /*
     * ADR-005 Decision 3: public.users.role is authoritative. A copy in auth
     * metadata is a copy that can disagree with the real authorization source.
     */
    const rows = await sql!`
      select id from auth.users
      where raw_app_meta_data ? 'role' or raw_user_meta_data ? 'role'`;

    expect(rows).toEqual([]);
  });
});

describe.skipIf(!configured)("Immutability", () => {
  it("audit_logs has no soft-delete or update column", async () => {
    const rows = await sql!`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_logs'
        and column_name in ('updated_at', 'deleted_at')`;

    expect(rows).toEqual([]);
  });

  it("profile_events has no soft-delete or update column", async () => {
    const rows = await sql!`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'profile_events'
        and column_name in ('updated_at', 'deleted_at')`;

    expect(rows).toEqual([]);
  });

  it("soft-delete columns survive on the tables that need them", async () => {
    const rows = await sql!`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'deleted_at'
      order by table_name`;

    expect(rows.map((r) => r["table_name"])).toEqual(["accounts", "customers", "users"]);
  });
});
