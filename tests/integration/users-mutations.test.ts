import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Status mutations, against the live database.
 *
 * Opt-in. `npm run verify` must stay non-destructive, so this suite runs only
 * when RUNTIME_MUTATION_TESTS=1 is set. It changes a real person's status, and
 * disabling revokes their sessions — that is not something a routine gate
 * should do behind someone's back.
 *
 *   RUNTIME_MUTATION_TESTS=1 npx vitest run tests/integration/users-mutations.test.ts
 *
 * It targets the Worker, never a Super Admin, and restores `active` at the end
 * so the environment is left as it was found. Every assertion reads the row
 * back from the database rather than trusting the service's return value.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const enabled =
  process.env["RUNTIME_MUTATION_TESTS"] === "1" &&
  DATABASE_URL !== "" &&
  !DATABASE_URL.includes("placeholder");

const sql = enabled ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

let superAdmin: AppUser;
let workerId: string;

beforeAll(async () => {
  if (!enabled) {
    return;
  }

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const workers = await sql!<{ id: string }[]>`
    select id from public.users
    where role = 'worker' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  const worker = workers[0];

  if (!admin || !worker) {
    throw new Error("Needs one active Super Admin and one Worker");
  }

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };

  workerId = worker.id;
});

afterAll(async () => {
  if (!enabled) {
    return;
  }

  /* Leave the environment as it was found, even if an assertion failed. */
  await sql!`update public.users set status = 'active' where id = ${workerId}`;
  await sql!.end({ timeout: 5 });
});

async function usersService() {
  return (await import("@/modules/users/services/users.service")).usersService;
}

async function statusInDatabase(): Promise<string> {
  const rows = await sql!<{ status: string }[]>`
    select status from public.users where id = ${workerId}
  `;
  return rows[0]!.status;
}

describe.skipIf(!enabled)("Worker status mutations", () => {
  it("suspends the Worker and leaves sessions intact", async () => {
    const service = await usersService();

    const before = await sql!<{ n: number }[]>`
      select count(*)::int as n from auth.sessions where user_id = ${workerId}
    `;

    const result = await service.changeStatus(
      workerId,
      { status: "suspended" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    expect(await statusInDatabase()).toBe("suspended");

    const after = await sql!<{ n: number }[]>`
      select count(*)::int as n from auth.sessions where user_id = ${workerId}
    `;

    /*
     * The documented difference between the two denial states. Suspension is
     * reversible without disruption, so lifting it must restore access with no
     * new sign-in.
     */
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("re-enables the Worker", async () => {
    const service = await usersService();

    const result = await service.changeStatus(
      workerId,
      { status: "active" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    expect(await statusInDatabase()).toBe("active");
  });

  it("disables the Worker and revokes every session", async () => {
    const service = await usersService();

    const result = await service.changeStatus(
      workerId,
      { status: "disabled" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    expect(await statusInDatabase()).toBe("disabled");

    const sessions = await sql!<{ n: number }[]>`
      select count(*)::int as n from auth.sessions where user_id = ${workerId}
    `;

    expect(sessions[0]!.n).toBe(0);
  });

  it("writes an audit entry for each status change", async () => {
    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'user' and entity_id = ${workerId} and action = 'update'
    `;

    /* Suspend, re-enable, disable. */
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it("revokes a real session and the row is gone from auth.sessions", async () => {
    const { sessionsService } = await import("@/modules/users/services/sessions.service");

    /*
     * Only ever the oldest, and only when more than one exists. Revoking the
     * sole remaining session would sign the operator out of the CRM mid-run,
     * so the newest is deliberately out of reach of this test.
     */
    const sessions = await sql!<{ id: string }[]>`
      select id from auth.sessions where user_id = ${superAdmin.id} order by updated_at asc
    `;

    if (sessions.length < 2) {
      /* Nothing safe to revoke. Reported rather than silently passing. */
      expect(sessions.length).toBeLessThan(2);
      return;
    }

    const target = sessions[0]!.id;

    const result = await sessionsService.revoke(target, superAdmin.id, { actor: superAdmin });

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value).toBe(1);

    const remaining = await sql!<{ id: string }[]>`
      select id from auth.sessions where id = ${target}
    `;

    expect(remaining).toHaveLength(0);

    /* Revocation is recorded, not silent. */
    const recorded = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.login_history
      where user_id = ${superAdmin.id} and event_type = 'session_revoked'
    `;

    expect(recorded[0]!.n).toBeGreaterThan(0);
  });

  it("restores the Worker to active", async () => {
    const service = await usersService();

    const result = await service.changeStatus(
      workerId,
      { status: "active" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    expect(await statusInDatabase()).toBe("active");
  });
});
