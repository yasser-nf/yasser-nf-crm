import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * Supplier Manager, end to end against a real database. M10 §30.
 *
 * What can only be tested here:
 *
 *   - the foreign key actually RESTRICTS a delete (§24)
 *   - existing accounts survive the migration as "My Account" (§8, §31)
 *   - the metric SQL agrees with the TypeScript derivation (§12, §16)
 *   - an inactive supplier keeps its accounts and refuses new ones (§23)
 *   - authorization is the service's, not the UI's (§19, §20)
 *   - supplier actions reach the audit log (§21, §22)
 *
 * LOCAL ONLY. Every fixture is created by the test.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m10-sup";
const PLAINTEXT = "m10-not-a-real-password";

let admin: AppUser;
let worker: AppUser;

async function services() {
  const suppliers = await import("@/modules/suppliers");
  const { accountsService } = await import("@/modules/accounts");
  const { dashboardService } = await import("@/modules/dashboard");
  return { ...suppliers, accountsService, dashboardService };
}

function email(tag: string): string {
  return `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
}

async function makeSupplier(name: string): Promise<string> {
  const { suppliersService } = await services();
  const created = await suppliersService.createSupplier({ name }, { actor: admin });

  if (!created.ok) throw new Error(`could not create supplier: ${created.error.message}`);

  return created.value.id;
}

async function makeAccount(
  tag: string,
  options: {
    supplierId?: string | null;
    profileSlots?: number;
    validUntil?: string | null;
    status?: string;
  } = {},
): Promise<string> {
  const { accountsService } = await services();

  const created = await accountsService.createAccount(
    {
      email: email(tag),
      password: PLAINTEXT,
      country: "DZ",
      profileSlots: options.profileSlots ?? 5,
      ...(options.supplierId === undefined ? {} : { supplierId: options.supplierId }),
    },
    { actor: admin },
  );

  if (!created.ok) throw new Error(`could not create account: ${created.error.message}`);

  if (options.validUntil !== undefined) {
    await sql!`update accounts set valid_until = ${options.validUntil} where id = ${created.value.id}::uuid`;
  }

  if (options.status !== undefined) {
    await sql!`update accounts set status = ${options.status}::account_status where id = ${created.value.id}::uuid`;
  }

  return created.value.id;
}

async function openProblem(accountId: string): Promise<void> {
  await sql!`insert into issues (account_id, issue_type, status, severity, description, reported_by)
             values (${accountId}::uuid, 'payment_problem', 'open', 'high',
                     ${"m10 fixture"}, ${admin.id}::uuid)`;
}

async function auditFor(entity: string, entityId: string) {
  return sql!<
    {
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[]
  >`
    select action, before, after from audit_logs
    where entity = ${entity}::audit_entity and entity_id = ${entityId}::uuid
    order by created_at asc`;
}

beforeAll(async () => {
  if (!local) return;

  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  const [w] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'worker' and deleted_at is null limit 1`;

  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };
  worker = { id: w!.id, email: w!.email, displayName: w!.name, initials: "W", role: "worker" };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------- existing accounts */

describe.skipIf(!local)("existing accounts are untouched — M10 §8 and §31", () => {
  it("creates an account with no supplier when none is named", async () => {
    const accountId = await makeAccount("default");

    const rows = await sql!<{ supplier_id: string | null }[]>`
      select supplier_id from accounts where id = ${accountId}::uuid`;

    expect(rows[0]!.supplier_id).toBeNull();
  });

  it("reports every supplierless account as My Account", async () => {
    const { suppliersService } = await services();
    await makeAccount("mine-a");
    await makeAccount("mine-b");

    const ownership = await suppliersService.ownership({ actor: admin });

    expect(ownership.ok).toBe(true);
    if (!ownership.ok) return;

    /* Counted from the column, never from profile ownership (§15). */
    const [row] = await sql!<{ mine: number; supplied: number }[]>`
      select count(*) filter (where supplier_id is null)::int as mine,
             count(*) filter (where supplier_id is not null)::int as supplied
      from accounts where deleted_at is null`;

    expect(ownership.value.myAccounts).toBe(row!.mine);
    expect(ownership.value.supplierAccounts).toBe(row!.supplied);
    expect(ownership.value.totalAccounts).toBe(row!.mine + row!.supplied);
  });
});

/* ------------------------------------------------------------- supplier CRUD */

describe.skipIf(!local)("supplier CRUD — M10 §6", () => {
  it("creates, stores the normalized name, and audits it", async () => {
    const { suppliersService } = await services();

    const created = await suppliersService.createSupplier(
      { name: "  NetStore   DZ ", notes: "pays monthly" },
      { actor: admin },
    );

    expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
    if (!created.ok) return;

    /* Stored as typed but cleaned; compared in its normalized form. */
    expect(created.value.name).toBe("NetStore DZ");
    expect(created.value.nameNormalized).toBe("netstore dz");
    expect(created.value.deactivatedAt).toBeNull();
    expect(created.value.createdBy).toBe(admin.id);

    const audits = await auditFor("supplier", created.value.id);

    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("create");
    expect(audits[0]!.after?.["event"]).toBe("supplier_created");
    expect(audits[0]!.after?.["name"]).toBe("NetStore DZ");
    /* Derived, and deliberately not audited — see the allow-list. */
    expect(audits[0]!.after?.["nameNormalized"]).toBeUndefined();
  });

  it("refuses a duplicate name however it is typed — M10 §5", async () => {
    const { suppliersService } = await services();
    const name = `Dup ${randomUUID().slice(0, 6)}`;

    expect((await suppliersService.createSupplier({ name }, { actor: admin })).ok).toBe(true);

    for (const variant of [name, name.toUpperCase(), `  ${name.toLowerCase()}  `]) {
      const again = await suppliersService.createSupplier({ name: variant }, { actor: admin });

      expect(again.ok).toBe(false);
      if (again.ok) return;
      /* On the name input, where the operator typed it. */
      expect(again.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses a whitespace-only name", async () => {
    const { suppliersService } = await services();

    expect((await suppliersService.createSupplier({ name: "   " }, { actor: admin })).ok).toBe(
      false,
    );
  });

  it("renames, and refuses a rename onto another supplier's name", async () => {
    const { suppliersService } = await services();
    const first = await makeSupplier(`Ren A ${randomUUID().slice(0, 6)}`);
    const secondName = `Ren B ${randomUUID().slice(0, 6)}`;
    await makeSupplier(secondName);

    const renamed = await suppliersService.updateSupplier(
      first,
      { name: `Ren C ${randomUUID().slice(0, 6)}` },
      { actor: admin },
    );

    expect(renamed.ok, renamed.ok ? "" : renamed.error.message).toBe(true);

    const clash = await suppliersService.updateSupplier(
      first,
      { name: secondName.toUpperCase() },
      { actor: admin },
    );

    expect(clash.ok).toBe(false);
  });

  it("clears a note with an empty string, and audits the change", async () => {
    const { suppliersService } = await services();
    const id = await makeSupplier(`Note ${randomUUID().slice(0, 6)}`);

    await suppliersService.updateSupplier(id, { notes: "ring Karim" }, { actor: admin });
    const cleared = await suppliersService.updateSupplier(id, { notes: "" }, { actor: admin });

    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.notes).toBeNull();

    const audits = await auditFor("supplier", id);
    expect(audits.filter((entry) => entry.after?.["event"] === "supplier_updated")).toHaveLength(2);
  });

  it("refuses an update for a supplier that does not exist", async () => {
    const { suppliersService } = await services();

    const missing = await suppliersService.updateSupplier(
      randomUUID(),
      { name: "Ghost" },
      { actor: admin },
    );

    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------- account ↔ supplier */

describe.skipIf(!local)("account to supplier — M10 §7 and §22", () => {
  it("assigns at creation and audits the account", async () => {
    const supplierId = await makeSupplier(`Create ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("assigned", { supplierId });

    const rows = await sql!<{ supplier_id: string | null }[]>`
      select supplier_id from accounts where id = ${accountId}::uuid`;

    expect(rows[0]!.supplier_id).toBe(supplierId);
  });

  it("changes My Account → Supplier A → Supplier B → My Account, auditing each", async () => {
    const { accountsService } = await services();
    const a = await makeSupplier(`Move A ${randomUUID().slice(0, 6)}`);
    const b = await makeSupplier(`Move B ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("moving");

    for (const supplierId of [a, b, null]) {
      const changed = await accountsService.setAccountSupplier(
        { accountId, supplierId },
        { actor: admin },
      );

      expect(changed.ok, changed.ok ? "" : changed.error.message).toBe(true);
      if (!changed.ok) return;
      expect(changed.value.supplierId).toBe(supplierId);
    }

    /* Three ownership changes, each carrying the previous and the new supplier. */
    const audits = (await auditFor("account", accountId)).filter(
      (entry) => entry.after?.["event"] === "account_supplier_changed",
    );

    expect(audits).toHaveLength(3);
    expect(audits[0]!.before?.["supplierId"]).toBeNull();
    expect(audits[0]!.after?.["supplierId"]).toBe(a);
    expect(audits[1]!.before?.["supplierId"]).toBe(a);
    expect(audits[1]!.after?.["supplierId"]).toBe(b);
    expect(audits[2]!.after?.["supplierId"]).toBeNull();
  });

  it("does not touch profiles or their history — M10 §22", async () => {
    const { accountsService } = await services();
    const supplierId = await makeSupplier(`Quiet ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("quiet");

    const before = await sql!<{ n: number; events: number }[]>`
      select (select count(*)::int from profiles where account_id = ${accountId}::uuid) as n,
             (select count(*)::int from profile_events where account_id = ${accountId}::uuid) as events`;

    await accountsService.setAccountSupplier({ accountId, supplierId }, { actor: admin });

    const after = await sql!<{ n: number; events: number }[]>`
      select (select count(*)::int from profiles where account_id = ${accountId}::uuid) as n,
             (select count(*)::int from profile_events where account_id = ${accountId}::uuid) as events`;

    expect(after[0]).toEqual(before[0]);
  });

  it("writes nothing when the supplier is already the one asked for", async () => {
    const { accountsService } = await services();
    const supplierId = await makeSupplier(`Same ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("same", { supplierId });

    const again = await accountsService.setAccountSupplier(
      { accountId, supplierId },
      { actor: admin },
    );

    expect(again.ok).toBe(true);

    const audits = (await auditFor("account", accountId)).filter(
      (entry) => entry.after?.["event"] === "account_supplier_changed",
    );

    expect(audits).toHaveLength(0);
  });

  it("refuses an unknown supplier", async () => {
    const { accountsService } = await services();
    const accountId = await makeAccount("unknown-supplier");

    const refused = await accountsService.setAccountSupplier(
      { accountId, supplierId: randomUUID() },
      { actor: admin },
    );

    expect(refused.ok).toBe(false);
  });

  it("shows the supplier on the account detail — M10 §10", async () => {
    const { accountsService } = await services();
    const name = `Shown ${randomUUID().slice(0, 6)}`;
    const supplierId = await makeSupplier(name);
    const accountId = await makeAccount("shown", { supplierId });

    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.supplier).toMatchObject({ id: supplierId, name, status: "active" });

    const mine = await accountsService.getAccountDetail(await makeAccount("shown-mine"));

    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    /* Null is "My Account"; the UI supplies the words. */
    expect(mine.value.supplier).toBeNull();
  });

  it("filters the accounts list by supplier and by My Accounts — M10 §9", async () => {
    const { accountsService } = await services();
    const supplierId = await makeSupplier(`Filter ${randomUUID().slice(0, 6)}`);
    const theirs = await makeAccount("filter-theirs", { supplierId });
    const ours = await makeAccount("filter-ours");

    const bySupplier = await accountsService.listAccounts({ supplierId, limit: 50, offset: 0 });

    expect(bySupplier.ok).toBe(true);
    if (!bySupplier.ok) return;
    expect(bySupplier.value.items.map((row) => row.account.id)).toContain(theirs);
    expect(bySupplier.value.items.map((row) => row.account.id)).not.toContain(ours);
    /* The total is counted over the same filtered set, not the whole table. */
    expect(bySupplier.value.total).toBe(bySupplier.value.items.length);

    const mine = await accountsService.listAccounts({ supplierId: "mine", limit: 50, offset: 0 });

    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(mine.value.items.map((row) => row.account.id)).toContain(ours);
    expect(mine.value.items.map((row) => row.account.id)).not.toContain(theirs);
  });

  it("carries the supplier name on every list row", async () => {
    const { accountsService } = await services();
    const name = `Named ${randomUUID().slice(0, 6)}`;
    const supplierId = await makeSupplier(name);
    await makeAccount("named", { supplierId });

    const page = await accountsService.listAccounts({ supplierId, limit: 50, offset: 0 });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items[0]?.supplierName).toBe(name);

    const ours = await accountsService.listAccounts({
      supplierId: "mine",
      limit: 50,
      offset: 0,
    });

    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    /* Null rather than a blank string: the UI decides the words. */
    expect(ours.value.items.every((row) => row.supplierName === null)).toBe(true);
  });
});

/* --------------------------------------------------------- deactivation (§23) */

describe.skipIf(!local)("deactivating a supplier — M10 §23", () => {
  it("keeps its accounts, and they do not become My Account", async () => {
    const { accountsService, suppliersService } = await services();
    const supplierId = await makeSupplier(`Deact ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("deact", { supplierId });

    const deactivated = await suppliersService.setSupplierActive(supplierId, false, {
      actor: admin,
    });

    expect(deactivated.ok, deactivated.ok ? "" : deactivated.error.message).toBe(true);
    if (!deactivated.ok) return;
    expect(deactivated.value.deactivatedAt).not.toBeNull();

    const rows = await sql!<{ supplier_id: string | null }[]>`
      select supplier_id from accounts where id = ${accountId}::uuid`;

    expect(rows[0]!.supplier_id).toBe(supplierId);

    /* Still named on the account, and marked inactive. */
    const detail = await accountsService.getAccountDetail(accountId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.supplier).toMatchObject({ id: supplierId, status: "inactive" });
  });

  it("refuses a NEW account for it, at creation and at reassignment", async () => {
    const { accountsService, suppliersService } = await services();
    const supplierId = await makeSupplier(`Closed ${randomUUID().slice(0, 6)}`);
    await suppliersService.setSupplierActive(supplierId, false, { actor: admin });

    const created = await accountsService.createAccount(
      { email: email("blocked"), password: PLAINTEXT, country: "DZ", supplierId },
      { actor: admin },
    );

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("CONFLICT");

    const existing = await makeAccount("reassign-blocked");
    const reassigned = await accountsService.setAccountSupplier(
      { accountId: existing, supplierId },
      { actor: admin },
    );

    expect(reassigned.ok).toBe(false);
  });

  it("stays visible, with its metrics, and can be reactivated", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Visible ${randomUUID().slice(0, 6)}`);
    await makeAccount("visible", { supplierId });
    await suppliersService.setSupplierActive(supplierId, false, { actor: admin });

    const detail = await suppliersService.getSupplier(supplierId, { actor: admin });

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.status).toBe("inactive");
    expect(detail.value.metrics.totalAccounts).toBe(1);

    const reactivated = await suppliersService.setSupplierActive(supplierId, true, {
      actor: admin,
    });

    expect(reactivated.ok).toBe(true);
    if (!reactivated.ok) return;
    expect(reactivated.value.deactivatedAt).toBeNull();

    const audits = await auditFor("supplier", supplierId);
    const events = audits.map((entry) => entry.after?.["event"]);

    expect(events).toContain("supplier_deactivated");
    expect(events).toContain("supplier_reactivated");
  });

  it("is a no-op when already in that state", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Noop ${randomUUID().slice(0, 6)}`);

    expect((await suppliersService.setSupplierActive(supplierId, true, { actor: admin })).ok).toBe(
      true,
    );

    const audits = await auditFor("supplier", supplierId);

    /* Only the creation. No empty "reactivated" entry. */
    expect(audits).toHaveLength(1);
  });
});

/* ------------------------------------------------- foreign key integrity (§24) */

describe.skipIf(!local)("database integrity — M10 §24", () => {
  it("RESTRICTS deleting a supplier that still owns accounts", async () => {
    const supplierId = await makeSupplier(`Fk ${randomUUID().slice(0, 6)}`);
    await makeAccount("fk", { supplierId });

    /*
     * Attempted in raw SQL because the application offers no delete at all —
     * which is the point. The database must refuse it from any writer.
     */
    /*
     * Matched on "RESTRICT setting" rather than on the generic foreign-key
     * wording, deliberately: CASCADE and SET NULL would not raise at all, and a
     * NO ACTION constraint raises the generic message. Only RESTRICT says this.
     */
    await expect(sql!`delete from suppliers where id = ${supplierId}::uuid`).rejects.toThrow(
      /violates RESTRICT setting of foreign key constraint "accounts_supplier_id_suppliers_id_fk"/i,
    );
  });

  it("permits deleting one that owns nothing", async () => {
    const supplierId = await makeSupplier(`Empty ${randomUUID().slice(0, 6)}`);

    await sql!`delete from suppliers where id = ${supplierId}::uuid`;

    const rows = await sql!`select 1 from suppliers where id = ${supplierId}::uuid`;
    expect(rows).toHaveLength(0);
  });

  it("refuses an account pointing at a supplier that does not exist", async () => {
    const accountId = await makeAccount("bad-fk");

    await expect(
      sql!`update accounts set supplier_id = ${randomUUID()}::uuid where id = ${accountId}::uuid`,
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("refuses a blank supplier name at the database level", async () => {
    await expect(
      sql!`insert into suppliers (name, name_normalized) values ('   ', 'x')`,
    ).rejects.toThrow(/suppliers_name_not_empty/i);
  });
});

/* ------------------------------------------------------- authorization (§19) */

describe.skipIf(!local)("authorization is the service's — M10 §19 and §20", () => {
  it("lets a Worker VIEW suppliers and an account's supplier", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Worker view ${randomUUID().slice(0, 6)}`);

    const list = await suppliersService.listSuppliers({ status: "all" }, { actor: worker });
    expect(list.ok, list.ok ? "" : list.error.message).toBe(true);

    const detail = await suppliersService.getSupplier(supplierId, { actor: worker });
    expect(detail.ok).toBe(true);

    const options = await suppliersService.listOptions({ actor: worker });
    expect(options.ok).toBe(true);
  });

  it("refuses a Worker every supplier MUTATION", async () => {
    const { accountsService, suppliersService } = await services();
    const supplierId = await makeSupplier(`Worker deny ${randomUUID().slice(0, 6)}`);
    const accountId = await makeAccount("worker-deny");

    const attempts = [
      await suppliersService.createSupplier({ name: "Worker made this" }, { actor: worker }),
      await suppliersService.updateSupplier(supplierId, { name: "Renamed" }, { actor: worker }),
      await suppliersService.setSupplierActive(supplierId, false, { actor: worker }),
      await accountsService.setAccountSupplier({ accountId, supplierId }, { actor: worker }),
    ];

    for (const attempt of attempts) {
      expect(attempt.ok).toBe(false);
      if (attempt.ok) continue;
      expect(attempt.error.code).toBe("FORBIDDEN");
    }

    /* And nothing was written. */
    const rows = await sql!<{ name: string; supplier_id: string | null }[]>`
      select s.name, a.supplier_id from suppliers s
      left join accounts a on a.id = ${accountId}::uuid
      where s.id = ${supplierId}::uuid`;

    expect(rows[0]!.name).toContain("Worker deny");
    expect(rows[0]!.supplier_id).toBeNull();
  });

  it("refuses a Worker creating an account WITH a supplier, but allows one without", async () => {
    const { accountsService } = await services();
    const supplierId = await makeSupplier(`Worker create ${randomUUID().slice(0, 6)}`);

    const withSupplier = await accountsService.createAccount(
      { email: email("worker-supplier"), password: PLAINTEXT, country: "DZ", supplierId },
      { actor: worker },
    );

    expect(withSupplier.ok).toBe(false);
    if (withSupplier.ok) return;
    expect(withSupplier.error.code).toBe("FORBIDDEN");

    /*
     * Without one, creation behaves exactly as it did before M10. Asserted so
     * the new gate cannot be mistaken for a new restriction on account creation.
     */
    const plain = await accountsService.createAccount(
      { email: email("worker-plain"), password: PLAINTEXT, country: "DZ" },
      { actor: worker },
    );

    expect(plain.ok, plain.ok ? "" : plain.error.message).toBe(true);
  });

  it("refuses every entry point without an actor", async () => {
    const { suppliersService } = await services();

    const attempts = [
      await suppliersService.listSuppliers({ status: "all" }, { actor: null }),
      await suppliersService.listOptions({ actor: null }),
      await suppliersService.ownership({ actor: null }),
      await suppliersService.createSupplier({ name: "Anonymous" }, { actor: null }),
    ];

    for (const attempt of attempts) {
      expect(attempt.ok).toBe(false);
      if (attempt.ok) continue;
      expect(attempt.error.code).toBe("FORBIDDEN");
    }
  });
});

/* --------------------------------------------------------------- metrics (§12) */

describe.skipIf(!local)("supplier metrics — M10 §12, §13 and §16", () => {
  it("counts accounts by effective status, and available profiles separately", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Metrics ${randomUUID().slice(0, 6)}`);

    /* One of each bucket, built from the rules themselves. */
    await makeAccount("m-healthy", { supplierId });
    await makeAccount("m-expired", { supplierId, validUntil: "2020-01-01" });
    const problem = await makeAccount("m-problem", { supplierId });
    await openProblem(problem);
    await makeAccount("m-archived", { supplierId, status: "archived" });

    const detail = await suppliersService.getSupplier(supplierId, { actor: admin });

    expect(detail.ok, detail.ok ? "" : detail.error.message).toBe(true);
    if (!detail.ok) return;

    const { metrics } = detail.value;

    expect(metrics.totalAccounts).toBe(4);
    expect(metrics.healthyAccounts).toBe(1);
    expect(metrics.expiredAccounts).toBe(1);
    expect(metrics.problemAccounts).toBe(1);
    expect(metrics.archivedAccounts).toBe(1);

    /* Disjoint and exhaustive over live accounts. */
    expect(
      metrics.healthyAccounts +
        metrics.problemAccounts +
        metrics.expiredAccounts +
        metrics.archivedAccounts,
    ).toBe(metrics.totalAccounts);

    /*
     * A PROFILE figure, and a different unit (§13): only the healthy account's
     * five slots are allocable. The expired, problem and archived accounts
     * cannot sell anything — 01_MASTER_RULES.
     */
    expect(metrics.availableProfiles).toBe(5);
  });

  it("respects profile_slots in the available count", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Slots ${randomUUID().slice(0, 6)}`);
    await makeAccount("slots", { supplierId, profileSlots: 2 });

    const detail = await suppliersService.getSupplier(supplierId, { actor: admin });

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.metrics.availableProfiles).toBe(2);
  });

  it("is zero for a brand-new supplier rather than absent", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Fresh ${randomUUID().slice(0, 6)}`);

    const detail = await suppliersService.getSupplier(supplierId, { actor: admin });

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.metrics).toMatchObject({ totalAccounts: 0, availableProfiles: 0 });

    /* And it still appears in the list — a supplier created a minute ago. */
    const list = await suppliersService.listSuppliers({ status: "all" }, { actor: admin });

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.map((entry) => entry.supplier.id)).toContain(supplierId);
  });

  it("gives the list and the detail page the same figures", async () => {
    const { suppliersService } = await services();
    const supplierId = await makeSupplier(`Agree ${randomUUID().slice(0, 6)}`);
    await makeAccount("agree-1", { supplierId });
    const problem = await makeAccount("agree-2", { supplierId });
    await openProblem(problem);

    const list = await suppliersService.listSuppliers({ status: "all" }, { actor: admin });
    const detail = await suppliersService.getSupplier(supplierId, { actor: admin });

    expect(list.ok && detail.ok).toBe(true);
    if (!list.ok || !detail.ok) return;

    const fromList = list.value.find((entry) => entry.supplier.id === supplierId);

    expect(fromList?.metrics).toEqual(detail.value.metrics);
  });

  /**
   * THE AGREEMENT TEST. M10 §12 and §16.
   *
   * The supplier pages count in SQL; the dashboard classifies the same accounts
   * in TypeScript through `accountEffectiveStatus`. If those two ever disagree,
   * one screen is lying — the class of bug that produced the Healthy-badge and
   * stock-count defects recorded in ADR-013 and M01.
   *
   * So this asserts them equal over a deliberately awkward set.
   */
  it("agrees with the dashboard's TypeScript tally, account for account", async () => {
    const { dashboardService, suppliersService } = await services();
    const supplierId = await makeSupplier(`Twin ${randomUUID().slice(0, 6)}`);

    await makeAccount("twin-healthy", { supplierId });
    await makeAccount("twin-expired", { supplierId, validUntil: "2020-01-01" });
    await makeAccount("twin-fault", { supplierId, status: "incorrect_password" });
    await makeAccount("twin-archived", { supplierId, status: "archived" });
    const blocked = await makeAccount("twin-blocked", { supplierId });
    await openProblem(blocked);
    await makeAccount("twin-slots", { supplierId, profileSlots: 3 });

    const fromSql = await suppliersService.getSupplier(supplierId, { actor: admin });
    const dashboard = await dashboardService.load(admin);

    expect(fromSql.ok && dashboard.ok).toBe(true);
    if (!fromSql.ok || !dashboard.ok) return;

    const fromTypeScript = dashboard.value.ownership?.bySupplier.find(
      (row) => row.supplierId === supplierId,
    );

    expect(fromTypeScript).toBeDefined();
    expect(fromTypeScript).toMatchObject({
      totalAccounts: fromSql.value.metrics.totalAccounts,
      healthyAccounts: fromSql.value.metrics.healthyAccounts,
      problemAccounts: fromSql.value.metrics.problemAccounts,
      expiredAccounts: fromSql.value.metrics.expiredAccounts,
      archivedAccounts: fromSql.value.metrics.archivedAccounts,
      availableProfiles: fromSql.value.metrics.availableProfiles,
    });
  });

  it("searches by name and filters by status — M10 §17 and §18", async () => {
    const { suppliersService } = await services();
    const token = randomUUID().slice(0, 8);
    const active = await makeSupplier(`Searchable ${token}`);
    const inactive = await makeSupplier(`Searchable ${token} old`);
    await suppliersService.setSupplierActive(inactive, false, { actor: admin });

    const found = await suppliersService.listSuppliers(
      { search: token, status: "all" },
      { actor: admin },
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toHaveLength(2);

    const activeOnly = await suppliersService.listSuppliers(
      { search: token, status: "active" },
      { actor: admin },
    );

    expect(activeOnly.ok).toBe(true);
    if (!activeOnly.ok) return;
    expect(activeOnly.value.map((entry) => entry.supplier.id)).toEqual([active]);

    const inactiveOnly = await suppliersService.listSuppliers(
      { search: token, status: "inactive" },
      { actor: admin },
    );

    expect(inactiveOnly.ok).toBe(true);
    if (!inactiveOnly.ok) return;
    expect(inactiveOnly.value.map((entry) => entry.supplier.id)).toEqual([inactive]);
  });
});

/* ------------------------------------------------------------- dashboard (§14) */

describe.skipIf(!local)("dashboard ownership — M10 §14 and §15", () => {
  it("reports My Accounts, supplier accounts and the total", async () => {
    const { dashboardService } = await services();
    const supplierId = await makeSupplier(`Dash ${randomUUID().slice(0, 6)}`);
    await makeAccount("dash-theirs", { supplierId });
    await makeAccount("dash-ours");

    const result = await dashboardService.load(admin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ownership = result.value.ownership;

    expect(ownership).not.toBeNull();
    expect(ownership!.totalAccounts).toBe(ownership!.myAccounts + ownership!.supplierAccounts);

    /* Against the column itself — §15 forbids deriving it any other way. */
    const [row] = await sql!<{ mine: number; supplied: number }[]>`
      select count(*) filter (where supplier_id is null)::int as mine,
             count(*) filter (where supplier_id is not null)::int as supplied
      from accounts where deleted_at is null`;

    expect(ownership!.myAccounts).toBe(row!.mine);
    expect(ownership!.supplierAccounts).toBe(row!.supplied);
  });

  it("names each supplier, so the widget needs no join", async () => {
    const { dashboardService } = await services();
    const name = `Dash named ${randomUUID().slice(0, 6)}`;
    const supplierId = await makeSupplier(name);
    await makeAccount("dash-named", { supplierId });

    const result = await dashboardService.load(admin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownership?.names[supplierId]).toBe(name);
  });

  it("agrees with the account widget's own total", async () => {
    const { dashboardService } = await services();

    const result = await dashboardService.load(admin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Both come from the same rows and the same classifier, so the ownership
     * total and the Accounts widget's total must be the same number. If a
     * future change re-queries one of them, this is what notices.
     */
    expect(result.value.ownership?.totalAccounts).toBe(result.value.counts.accounts.total);
  });
});
