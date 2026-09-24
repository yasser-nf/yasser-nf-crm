import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * Direct user creation against a real database (M02, ADR-014).
 *
 * Everything real except Supabase Auth: the repository, the Database Adapter,
 * the audit service with its M01.5 sanitizer, the stored password policy, and
 * the public.users -> auth.users foreign key from migration 0001. Supabase's
 * admin API is replaced by a stand-in that writes to the isolated database's
 * `auth.users` shim — the table the foreign key points at — so "both records
 * exist, or neither does" is checked in rows, not in mock call counts.
 *
 * LOCAL ONLY. The stand-in inserts into `auth.users` directly, which is fine in
 * the in-process PGlite database and never acceptable in a real Supabase
 * project, so this file skips for any other target — including a deliberately
 * provisioned remote test database.
 *
 * What cannot be proven here: Supabase accepting a password sign-in. There is
 * no GoTrue in the isolated database. What IS proven is everything the CRM
 * controls on either side of that: the identity is requested confirmed and
 * with the password, and getCurrentUser — the CRM's own gate after Supabase —
 * accepts the new identity with the role that was chosen.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PASSWORD = "Integration-Secret-Passphrase-42";
const PROFILE_FAILS_FOR = "profile-fails@test.invalid";

/** Which identity the stubbed Supabase session belongs to, for getCurrentUser. */
let sessionUser: { id: string; email: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    ok: true,
    value: {
      auth: {
        admin: {
          /*
           * What Supabase does for the CRM, reduced to the row it writes: an
           * identity with a fresh id, confirmed at once when asked. Refuses an
           * address it already holds, as Supabase does with email_exists.
           */
          async createUser(attributes: {
            email: string;
            password: string;
            email_confirm?: boolean;
          }) {
            const taken =
              await sql!`select 1 from auth.users where lower(email) = ${attributes.email}`;

            if (taken.length > 0) {
              return {
                data: { user: null },
                error: { code: "email_exists", status: 422, message: "already registered" },
              };
            }

            const [row] = await sql!<{ id: string }[]>`
              insert into auth.users (id, email, email_confirmed_at)
              values (gen_random_uuid(), ${attributes.email},
                      ${attributes.email_confirm === true ? sql!`now()` : null})
              returning id
            `;

            return { data: { user: { id: row!.id, email: attributes.email } }, error: null };
          },
          async deleteUser(id: string) {
            await sql!`delete from auth.users where id = ${id}`;
            return { data: { user: null }, error: null };
          },
        },
      },
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: null }) },
  }),
}));

vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  isSupabaseConfigured: () => true,
}));

let superAdmin: AppUser;
let worker: { id: string; email: string };

/** Every existing person, both halves, as one comparable value. */
async function existingUsersFingerprint(ids: readonly string[]) {
  const rows = await sql!`
    select u.id, u.name, u.email, u.role, u.status, u.updated_at, u.deleted_at,
           a.email as auth_email, a.email_confirmed_at
    from public.users u join auth.users a on a.id = u.id
    where u.id = any(${sql!.array(ids as string[])}::uuid[])
    order by u.id
  `;

  return JSON.stringify(rows);
}

let existingIds: string[] = [];
let fingerprintBefore = "";

beforeAll(async () => {
  if (!local) {
    return;
  }

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;
  const workers = await sql!<{ id: string; email: string }[]>`
    select id, email from public.users where role = 'worker' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  const seededWorker = workers[0];

  if (!admin || !seededWorker) {
    throw new Error("Needs the seeded Super Admin and Worker");
  }

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
  worker = seededWorker;

  existingIds = (await sql!<{ id: string }[]>`select id from public.users`).map((r) => r.id);
  fingerprintBefore = await existingUsersFingerprint(existingIds);

  /*
   * A genuine database failure for one address: the CRM insert raises, after
   * Supabase has already created the identity. That is the partial-creation
   * case compensation exists for. The database is this file's alone.
   */
  await sql!.unsafe(`
    create or replace function test_refuse_profile() returns trigger language plpgsql as $$
    begin
      if new.email = '${PROFILE_FAILS_FOR}' then
        raise exception 'simulated public.users failure';
      end if;
      return new;
    end $$;
    create trigger test_refuse_profile before insert on public.users
      for each row execute function test_refuse_profile();
  `);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function services() {
  return import("@/modules/users");
}

describe.skipIf(!local)("creating a user writes both halves, consistently", () => {
  let createdId = "";

  it("creates the auth identity and the CRM row with the same id", async () => {
    const { usersService } = await services();

    const result = await usersService.create(
      { name: "Nadia Created", email: " Nadia@Test.Invalid ", password: PASSWORD, role: "worker" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdId = result.value.id;

    const rows = await sql!`
      select u.id, u.email, u.role, u.status, u.deleted_at, a.email as auth_email,
             a.email_confirmed_at is not null as confirmed
      from public.users u join auth.users a on a.id = u.id
      where u.id = ${createdId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "nadia@test.invalid",
      auth_email: "nadia@test.invalid",
      role: "worker",
      status: "active",
      deleted_at: null,
      confirmed: true,
    });
  });

  it("gives public.users nowhere to put a password", async () => {
    const columns = await sql!<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'users'
    `;

    expect(columns.map((c) => c.column_name).filter((c) => /pass|secret|hash/i.test(c))).toEqual(
      [],
    );
  });

  it("records one audit entry with actor, target, role and email — and no password", async () => {
    const entries = await sql!<
      { user_id: string; actor_email: string; after: Record<string, unknown>; created_at: Date }[]
    >`
      select user_id, actor_email, after, created_at from audit_logs
      where entity = 'user' and action = 'create' and entity_id = ${createdId}
    `;

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;

    expect(entry.user_id).toBe(superAdmin.id);
    expect(entry.after).toMatchObject({
      id: createdId,
      email: "nadia@test.invalid",
      role: "worker",
      event: "user_created",
    });
    expect(entry.created_at).toBeInstanceOf(Date);
    expect(JSON.stringify(entry)).not.toContain(PASSWORD);
  });

  it("lets the new user through the CRM's own sign-in gate, with the chosen role", async () => {
    /*
     * getCurrentUser is what every page and action calls after Supabase has
     * verified a session. Given the new identity, it must find an active CRM
     * record and return the role the administrator picked.
     */
    sessionUser = { id: createdId, email: "nadia@test.invalid" };
    const { getCurrentUser } = await import("@/lib/auth/session");

    const appUser = await getCurrentUser();

    expect(appUser).toMatchObject({ id: createdId, role: "worker" });
    sessionUser = null;
  });

  it("creates a Super Admin when a Super Admin asks for one", async () => {
    const { usersService } = await services();

    const result = await usersService.create(
      {
        name: "Second Admin",
        email: "second-admin@test.invalid",
        password: PASSWORD,
        role: "super_admin",
      },
      { actor: superAdmin },
    );

    expect(result.ok && result.value.role).toBe("super_admin");
  });

  it("shows the new user in the Users list as an established user, not a pending invite", async () => {
    const { usersService } = await services();

    const list = await usersService.list({ search: "nadia", limit: 10, offset: 0 }, superAdmin);

    expect(list.ok).toBe(true);
    if (!list.ok) return;

    const entry = list.value.items.find((item) => item.user.id === createdId);
    expect(entry?.invitation).toBe("accepted");
    expect(entry?.invitedAt).toBeNull();
  });
});

describe.skipIf(!local)("failure leaves nothing behind", () => {
  it("removes the auth identity when the CRM row cannot be written", async () => {
    const { usersService } = await services();

    const result = await usersService.create(
      { name: "Will Fail", email: PROFILE_FAILS_FOR, password: PASSWORD, role: "worker" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const [auth] = await sql!<{ n: number }[]>`
      select count(*)::int as n from auth.users where email = ${PROFILE_FAILS_FOR}`;
    const [crm] = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.users where email = ${PROFILE_FAILS_FOR}`;
    const [audit] = await sql!<{ n: number }[]>`
      select count(*)::int as n from audit_logs where after->>'email' = ${PROFILE_FAILS_FOR}`;

    expect({ auth: auth!.n, crm: crm!.n, audit: audit!.n }).toEqual({ auth: 0, crm: 0, audit: 0 });
  });

  it("refuses an existing user's address and changes nothing about them", async () => {
    const { usersService } = await services();
    const [before] = await sql!<{ n: number }[]>`select count(*)::int as n from auth.users`;

    const result = await usersService.create(
      {
        name: "Impostor",
        email: worker.email.toUpperCase(),
        password: PASSWORD,
        role: "super_admin",
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");

    const [after] = await sql!<{ n: number }[]>`select count(*)::int as n from auth.users`;
    expect(after!.n).toBe(before!.n);
  });

  it("refuses a Worker, writing nothing", async () => {
    const { usersService } = await services();
    const workerActor: AppUser = {
      id: worker.id,
      email: worker.email,
      displayName: "Worker",
      initials: "W",
      role: "worker",
    };

    const result = await usersService.create(
      { name: "Nope", email: "nope@test.invalid", password: PASSWORD, role: "worker" },
      { actor: workerActor },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");

    const [n] = await sql!<{ n: number }[]>`
      select count(*)::int as n from auth.users where email = 'nope@test.invalid'`;
    expect(n!.n).toBe(0);
  });
});

describe.skipIf(!local)("existing users are untouched, and the password is nowhere", () => {
  it("leaves every pre-existing user exactly as it was, in both tables", async () => {
    expect(await existingUsersFingerprint(existingIds)).toBe(fingerprintBefore);
  });

  it("appears in no application table, in any column", async () => {
    /*
     * Every row of every table the CRM writes, as text. A password that reached
     * any of them — an audit snapshot, a login-history reason, a settings value
     * — would be found here.
     */
    const tables = await sql!<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;

    const hits: string[] = [];

    for (const { table_name } of tables) {
      const [found] = await sql!<{ n: number }[]>`
        select count(*)::int as n from ${sql!("public")}.${sql!(table_name)} t
        where t::text like ${"%" + PASSWORD + "%"}
      `;

      if (found!.n > 0) hits.push(table_name);
    }

    expect(tables.length).toBeGreaterThan(5);
    expect(hits).toEqual([]);
  });
});
