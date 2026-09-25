import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M06 Logs, against the isolated database.
 *
 * Real audit rows written by real services, plus rows placed at exact UTC
 * boundaries with hostile content, read back through `logsService` — and the
 * database layer itself checked as the browser roles would reach it.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const SECRET_PIN = "8642";
const SECRET_NOTE = "the account password is Swordfish-M06";
const CIPHERTEXT = "v1:c2VjcmV0:dGFn:ZGF0YQ";
/** An entity id no other file uses, so these rows can be found and counted exactly. */
const MARKED = "0e060000-0000-4000-8000-0000000000";

let admin: AppUser;
let worker: AppUser;

async function services() {
  const { logsService, parseLogsFilter } = await import("@/modules/audit");
  const { accountsService } = await import("@/modules/accounts");
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  return { logsService, parseLogsFilter, accountsService, quickPrepareService };
}

async function list(params: Record<string, string>, actor: AppUser | null = admin) {
  const { logsService, parseLogsFilter } = await services();
  return logsService.list(parseLogsFilter(params), actor);
}

async function page(params: Record<string, string>) {
  const result = await list(params);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Inserts an audit row as a service would have, at a chosen instant. */
async function insertRow(input: {
  suffix: string;
  createdAt: string;
  entity?: string;
  action?: string;
  after?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  userId?: string | null;
}) {
  await sql!`
    insert into audit_logs (entity, entity_id, action, before, after, user_id, actor_email, created_at)
    values (
      ${input.entity ?? "account"}, ${`${MARKED}${input.suffix}`}::uuid, ${input.action ?? "update"},
      ${input.before === undefined ? null : sql!.json(input.before as never)},
      ${sql!.json((input.after ?? {}) as never)},
      ${input.userId === undefined ? admin.id : input.userId}::uuid, 'admin@test.invalid', ${input.createdAt}::timestamptz
    )`;
}

beforeAll(async () => {
  if (!local) return;

  const rows = await sql!<{ id: string; name: string; role: string; email: string }[]>`
    select id, name, role, email from users where status = 'active' and deleted_at is null`;
  const a = rows.find((row) => row.role === "super_admin")!;
  const w = rows.find((row) => row.role === "worker")!;
  admin = { id: a.id, email: a.email, displayName: a.name, initials: "SA", role: "super_admin" };
  worker = { id: w.id, email: w.email, displayName: w.name, initials: "W", role: "worker" };

  /* Boundary rows: the last instant of 30 Sept, and the first of 1 Oct — UTC. */
  await insertRow({ suffix: "01", createdAt: "2026-09-30T23:59:59.999Z" });
  await insertRow({ suffix: "02", createdAt: "2026-10-01T00:00:00.000Z" });
  await insertRow({ suffix: "03", createdAt: "2026-10-01T00:00:00.000Z" });

  /* A hostile historical row, as if written before redaction existed. */
  await insertRow({
    suffix: "04",
    createdAt: "2026-08-15T12:00:00Z",
    entity: "profile",
    before: { pin: "1357", notes: "old" },
    after: {
      pin: SECRET_PIN,
      notes: SECRET_NOTE,
      passwordEncrypted: CIPHERTEXT,
      stray: CIPHERTEXT,
      nested: { authToken: "tok_M06_secret" },
    },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!local)("authorization", () => {
  it("a Super Admin reads the log", async () => {
    const result = await list({});

    expect(result.ok).toBe(true);
  });

  it("a Worker is refused — before any row is read", async () => {
    const result = await list({}, worker);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("the signed-out are refused", async () => {
    const result = await list({}, null);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
  });
});

describe.skipIf(!local)("retrieval, ordering and pagination", () => {
  it("pages 25 at a time, newest first, with an exact total", async () => {
    const [counted] = await sql!<{ n: number }[]>`select count(*)::int n from audit_logs`;
    const n = counted!.n;
    const first = await page({});
    const second = await page({ offset: "25" });

    expect(first.total).toBe(n);
    expect(first.items.length).toBe(Math.min(25, n));
    expect(first.limit).toBe(25);

    const times = [...first.items, ...second.items].map((entry) => entry.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    /* No entry appears on two pages. */
    const ids = [...first.items, ...second.items].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("breaks timestamp ties by id, so pages are stable", async () => {
    const tied = (await page({ from: "2026-10-01", to: "2026-10-01" })).items.filter((entry) =>
      entry.entityId.startsWith(MARKED),
    );

    expect(tied).toHaveLength(2);
    expect(tied[0]!.id > tied[1]!.id).toBe(true);
  });
});

describe.skipIf(!local)("dates are UTC days, inclusive at both ends", () => {
  async function marked(params: Record<string, string>) {
    return (await page(params)).items
      .filter((entry) => entry.entityId.startsWith(MARKED))
      .map((entry) => entry.entityId.slice(-2))
      .sort();
  }

  it("30 Sept holds 23:59:59.999Z and not 00:00:00Z the next day", async () => {
    expect(await marked({ from: "2026-09-30", to: "2026-09-30" })).toEqual(["01"]);
  });

  it("1 Oct starts at 00:00:00Z exactly", async () => {
    expect(await marked({ from: "2026-10-01", to: "2026-10-01" })).toEqual(["02", "03"]);
  });

  it("a range across the month end holds both", async () => {
    expect(await marked({ from: "2026-09-30", to: "2026-10-01" })).toEqual(["01", "02", "03"]);
  });

  it("does not follow the database session's time zone", async () => {
    await sql!`set time zone 'Pacific/Kiritimati'`;
    try {
      expect(await marked({ from: "2026-09-30", to: "2026-09-30" })).toEqual(["01"]);
    } finally {
      await sql!`set time zone 'UTC'`;
    }
  });

  it("an inverted range is refused, not answered with nothing", async () => {
    const result = await list({ from: "2026-10-02", to: "2026-10-01" });

    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!local)("filters and search", () => {
  it("filters by entity, action and person, server-side", async () => {
    const profiles = await page({ entity: "profile" });
    const archives = await page({ action: "archive" });
    const mine = await page({ actor: admin.id });

    expect(profiles.items.every((entry) => entry.entity === "profile")).toBe(true);
    expect(archives.items.every((entry) => entry.action === "archive")).toBe(true);
    expect(mine.items.every((entry) => entry.actor.id === admin.id)).toBe(true);
    expect(mine.total).toBeGreaterThan(0);
  });

  it("finds by the start of an entity id", async () => {
    const found = await page({ search: `${MARKED}04`.slice(0, 13) });

    expect(found.items.map((entry) => entry.entityId)).toContain(`${MARKED}04`);
  });

  it("finds by the actor's email and by an action's label", async () => {
    expect((await page({ search: "admin@test" })).total).toBeGreaterThan(0);
    expect((await page({ search: "updated", from: "2026-09-30", to: "2026-09-30" })).total).toBe(1);
  });

  it("never searches free text or secrets", async () => {
    expect((await page({ search: "Swordfish" })).total).toBe(0);
    expect((await page({ search: SECRET_PIN })).total).toBe(0);
  });

  it("treats % and _ literally", async () => {
    expect((await page({ search: "%%" })).total).toBe(0);
    expect((await page({ search: "__" })).total).toBe(0);
  });

  it("a filter that matches nothing is an empty page, not an error", async () => {
    const result = await list({ from: "2001-01-01", to: "2001-01-02" });

    expect(result.ok && result.value).toMatchObject({ items: [], total: 0 });
  });
});

describe.skipIf(!local)("what reaches the browser", () => {
  it("the hostile historical row is shown without a single secret", async () => {
    const entry = (await page({ search: `${MARKED}04`.slice(0, 13) })).items.find(
      (item) => item.entityId === `${MARKED}04`,
    );
    const body = JSON.stringify(entry);

    expect(entry).toBeDefined();
    for (const secret of [SECRET_PIN, "1357", "Swordfish", CIPHERTEXT, "tok_M06_secret"]) {
      expect(body, secret).not.toContain(secret);
    }
    expect(entry!.changes.find((change) => change.field === "pin")?.after).toBe("Hidden");
    expect(entry!.changes.find((change) => change.field === "notes")?.after).toMatch(
      /^Text hidden/,
    );
  });

  it("no page of the real log carries a snapshot, a PIN or a ciphertext", async () => {
    const all = await page({});
    const body = JSON.stringify(all);

    /* A change's before/after are display strings; a raw snapshot would be an object. */
    expect(body).not.toMatch(/"(before|after)":\{/);
    expect(body).not.toMatch(/"(pin|passwordEncrypted)":/);
    expect(body).not.toMatch(/v1:[^"\s:]+:[^"\s:]+:[^"\s:]+/);
  });
});

describe.skipIf(!local)("new audit coverage: customer creation", () => {
  it("a customer created by Quick Prepare is audited, with who created it", async () => {
    const { accountsService, quickPrepareService } = await services();
    const account = await accountsService.createAccount(
      {
        email: `m06-${Date.now()}@example.invalid`,
        password: "not-a-real-password",
        country: "DZ",
        profileSlots: 5,
      },
      { actor: admin },
    );
    expect(account.ok).toBe(true);

    const phone = `0551${String(Date.now()).slice(-6)}`;
    const prepared = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone, passwordChangeConfirmed: true },
      { actor: worker },
    );
    expect(prepared.ok, prepared.ok ? "" : prepared.error.message).toBe(true);

    const rows = await sql!<{ user_id: string; action: string }[]>`
      select a.user_id, a.action from audit_logs a
      join customers c on c.id = a.entity_id
      where a.entity = 'customer' and c.phone_normalized = ${phone.slice(1)}`;

    expect(rows).toEqual([{ user_id: worker.id, action: "create" }]);
  });
});

describe.skipIf(!local)("a real failed query logs no bound values", () => {
  it("the adapter's error log omits the parameter and the value PostgreSQL echoes", async () => {
    const { databaseAdapter } = await import("@/lib/database");
    const { sql: drizzleSql } = await import("drizzle-orm");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await databaseAdapter.query("test.failedPinQuery", (executor) =>
        executor.execute(drizzleSql`select ${`PIN-${SECRET_PIN}`}::int`),
      );

      expect(result.ok).toBe(false);
      const written = [...spy.mock.calls, ...warn.mock.calls]
        .map((call) => String(call[0]))
        .join("\n");
      expect(written).toContain("test.failedPinQuery");
      expect(written).not.toContain(SECRET_PIN);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe.skipIf(!local)("the database layer: browser roles never read audit_logs", () => {
  it("anon and authenticated — even a Super Admin's own session — are refused everything", async () => {
    const ROLLBACK = new Error("rollback");
    const statements = [
      "select id from audit_logs limit 1",
      `insert into audit_logs (entity, entity_id, action) values ('account', '${MARKED}99', 'create')`,
      "update audit_logs set action = 'delete' where false",
      "delete from audit_logs where false",
    ];

    for (const role of ["anon", "authenticated"]) {
      for (const statement of statements) {
        let outcome = "allowed";
        try {
          await sql!.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx`select set_config('request.jwt.claim.sub', ${admin.id}, true)`;
            try {
              await tx.unsafe(statement);
            } catch (error) {
              outcome = (error as { code?: string }).code ?? "error";
            }
            throw ROLLBACK;
          });
        } catch (error) {
          if (error !== ROLLBACK) throw error;
        }

        expect(outcome, `${role}: ${statement}`).toBe("42501");
      }
    }
  });

  it("keeps RLS on, with the Super Admin read policy from 0002 unchanged", async () => {
    const [table] = await sql!<{ rls: boolean }[]>`
      select relrowsecurity rls from pg_class where oid = 'public.audit_logs'::regclass`;
    const policies = await sql!<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies where tablename = 'audit_logs' order by 1`;

    expect(table?.rls).toBe(true);
    expect(policies).toEqual([
      { policyname: "audit_logs_insert", cmd: "INSERT" },
      { policyname: "audit_logs_read_admin", cmd: "SELECT" },
    ]);
  });
});
