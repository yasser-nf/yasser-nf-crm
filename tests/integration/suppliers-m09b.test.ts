import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M09B Supplier Manager, against the real schema.
 *
 * What these tests are for: an account's provenance is a fact the business
 * acts on — which supplier to stop buying from — so the rules binding
 * `ownership` and `supplier_id` have to hold at the service, not only in a
 * form. Every test builds its own supplier and accounts.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m09b";
const PLAINTEXT = "m09b-not-a-real-password";

let admin: AppUser;
let worker: AppUser;

async function modules() {
  const suppliers = await import("@/modules/suppliers");
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService } = await import("@/modules/problems");
  return { ...suppliers, accountsService, problemsService };
}

/** A supplier with a unique name, created through the service. */
async function makeSupplier(tag: string): Promise<{ id: string; name: string }> {
  const { suppliersService } = await modules();
  const name = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}`;
  const created = await suppliersService.create({ name }, { actor: admin });
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, name };
}

async function makeAccount(
  tag: string,
  ownership: { ownership: "owned" | "unknown" } | { ownership: "supplied"; supplierId: string },
): Promise<{ id: string; email: string }> {
  const { accountsService } = await modules();
  const email = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const created = await accountsService.createAccount(
    { email, password: PLAINTEXT, country: "DZ", profileSlots: 5, ...ownership },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email };
}

async function accountRow(id: string) {
  const [row] = await sql!<{ ownership: string; supplier_id: string | null }[]>`
    select ownership::text as ownership, supplier_id from accounts where id = ${id}::uuid`;
  return row!;
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
  if (!local) return;
  /* Accounts first: the foreign key to suppliers is ON DELETE RESTRICT. */
  await sql!`delete from accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from suppliers where name like ${`${PREFIX}-%`}`;
  await sql!.end({ timeout: 5 });
});

/* ------------------------------------------------------------- authorization */

describe.skipIf(!local)("authorization", () => {
  it("refuses every supplier operation to a Worker and to the signed-out", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("auth");
    const account = await makeAccount("auth", { ownership: "owned" });

    for (const actor of [null, worker]) {
      for (const call of [
        suppliersService.overview({}, actor),
        suppliersService.detail(supplier.id, {}, actor),
        suppliersService.metrics(actor),
        suppliersService.options(actor),
        suppliersService.create({ name: `${PREFIX}-nope` }, { actor }),
        suppliersService.update(supplier.id, { name: `${PREFIX}-nope` }, { actor }),
        suppliersService.remove(supplier.id, { actor }),
        suppliersService.assign(
          { accountId: account.id, ownership: { ownership: "owned" } },
          { actor },
        ),
      ]) {
        const result = await call;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
      }
    }

    /* And nothing a refused write asked for actually happened. */
    expect(await accountRow(account.id)).toMatchObject({ ownership: "owned", supplier_id: null });
    const planted = await sql!<{ count: number }[]>`
      select count(*)::int as count from suppliers where name = ${`${PREFIX}-nope`}`;
    expect(planted[0]!.count).toBe(0);
  });
});

/* ------------------------------------------------------------------- the list */

describe.skipIf(!local)("supplier records", () => {
  it("collapses whitespace in a name and refuses a duplicate whatever its case", async () => {
    const { suppliersService } = await modules();
    const tag = `${PREFIX}-dup-${randomUUID().slice(0, 8)}`;

    const created = await suppliersService.create(
      { name: `  ${tag}   Shop  `, contact: "+213600000000" },
      { actor: admin },
    );
    expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
    if (!created.ok) return;

    /* Trimmed by the schema, and its internal run of spaces collapsed. */
    expect(created.value.name).toBe(`${tag} Shop`);

    const again = await suppliersService.create(
      { name: `${tag.toUpperCase()} SHOP` },
      { actor: admin },
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
  });

  it("archives a supplier out of the picker without touching its accounts", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("archive");
    const account = await makeAccount("archive", {
      ownership: "supplied",
      supplierId: supplier.id,
    });

    const before = await suppliersService.options(admin);
    expect(before.ok && before.value.some((row) => row.id === supplier.id)).toBe(true);

    const archived = await suppliersService.update(
      supplier.id,
      { archived: true },
      { actor: admin },
    );
    expect(archived.ok, archived.ok ? "" : archived.error.message).toBe(true);

    const after = await suppliersService.options(admin);
    expect(after.ok && after.value.some((row) => row.id === supplier.id)).toBe(false);

    /* The account keeps its provenance: archiving is not forgetting. */
    expect(await accountRow(account.id)).toMatchObject({
      ownership: "supplied",
      supplier_id: supplier.id,
    });

    /* And it is still reachable by id, so the account's link resolves. */
    const detail = await suppliersService.detail(supplier.id, {}, admin);
    expect(detail.ok && detail.value.archivedAt).toBeTruthy();
  });

  it("counts accounts and problem accounts once each, per supplier", async () => {
    const { suppliersService, problemsService } = await modules();
    const supplier = await makeSupplier("counts");
    const other = await makeSupplier("counts-other");

    const broken = await makeAccount("counts-broken", {
      ownership: "supplied",
      supplierId: supplier.id,
    });
    await makeAccount("counts-fine", { ownership: "supplied", supplierId: supplier.id });
    await makeAccount("counts-elsewhere", { ownership: "supplied", supplierId: other.id });

    /* TWO blocking problems on ONE account: the account must still count once. */
    for (const issueType of ["payment_problem", "incorrect_password"] as const) {
      const reported = await problemsService.report(
        { accountId: broken.id, issueType, description: "m09b counting" },
        { actor: worker },
      );
      expect(reported.ok, reported.ok ? "" : reported.error.message).toBe(true);
    }

    const detail = await suppliersService.detail(supplier.id, {}, admin);
    expect(detail.ok, detail.ok ? "" : detail.error.message).toBe(true);
    if (!detail.ok) return;

    expect(detail.value.accountCount).toBe(2);
    expect(detail.value.problemCount).toBe(1);

    /* The other supplier's account is not attributed here. */
    expect(detail.value.accounts.items.map((row) => row.account.id)).not.toContain(
      "counts-elsewhere",
    );
    expect(detail.value.accounts.total).toBe(2);

    /* The problem flag on the row agrees with the count above. */
    const flagged = detail.value.accounts.items.filter((row) => row.hasProblem);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.account.id).toBe(broken.id);

    /* And filtering to problems returns exactly that account. */
    const onlyProblems = await suppliersService.detail(
      supplier.id,
      { withProblemsOnly: true },
      admin,
    );
    expect(onlyProblems.ok && onlyProblems.value.accounts.total).toBe(1);
  });

  it("never carries an account's encrypted password into a supplier payload", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("secrets");
    await makeAccount("secrets", { ownership: "supplied", supplierId: supplier.id });

    const detail = await suppliersService.detail(supplier.id, {}, admin);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    for (const row of detail.value.accounts.items) {
      expect(Object.keys(row.account)).not.toContain("passwordEncrypted");
      expect(JSON.stringify(row.account)).not.toContain(PLAINTEXT);
    }

    const overview = await suppliersService.overview({}, admin);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(JSON.stringify(overview.value)).not.toContain(PLAINTEXT);
  });
});

/* ---------------------------------------------------------------- deleting */

describe.skipIf(!local)("deleting a supplier", () => {
  it("refuses while accounts still name it, and says how many", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("guard");
    const replacement = await makeSupplier("guard-new");
    const account = await makeAccount("guard", {
      ownership: "supplied",
      supplierId: supplier.id,
    });

    const refused = await suppliersService.remove(supplier.id, { actor: admin });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CONFLICT");
      expect(refused.error.userMessage).toContain("1 account");
    }

    /* The refusal left everything alone. */
    const untouched = await sql!<{ deleted_at: Date | null }[]>`
      select deleted_at from suppliers where id = ${supplier.id}::uuid`;
    expect(untouched[0]!.deleted_at).toBeNull();

    /* Move the account, and the same delete now goes through. */
    const moved = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "supplied", supplierId: replacement.id } },
      { actor: admin },
    );
    expect(moved.ok, moved.ok ? "" : moved.error.message).toBe(true);
    expect(await accountRow(account.id)).toMatchObject({ supplier_id: replacement.id });

    const removed = await suppliersService.remove(supplier.id, { actor: admin });
    expect(removed.ok, removed.ok ? "" : removed.error.message).toBe(true);

    /* Soft-deleted: the row survives so the audit trail still resolves the name. */
    const [row] = await sql!<{ deleted_at: Date | null; name: string }[]>`
      select deleted_at, name from suppliers where id = ${supplier.id}::uuid`;
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.name).toBe(supplier.name);

    /* And it is gone from every live surface. */
    const options = await suppliersService.options(admin);
    expect(options.ok && options.value.some((entry) => entry.id === supplier.id)).toBe(false);
    const detail = await suppliersService.detail(supplier.id, {}, admin);
    expect(detail.ok).toBe(false);
    if (!detail.ok) expect(detail.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------- creating an account */

describe.skipIf(!local)("an account's provenance on creation", () => {
  it("requires an answer, and requires a supplier when the answer is 'supplied'", async () => {
    const { accountsService } = await modules();
    const supplier = await makeSupplier("create");

    /* Silence is not an answer: nothing falls through to the column default. */
    const unsaid = await accountsService.createAccount(
      {
        email: `${PREFIX}-unsaid-${randomUUID().slice(0, 8)}@example.invalid`,
        password: PLAINTEXT,
        profileSlots: 5,
      },
      { actor: admin },
    );
    expect(unsaid.ok).toBe(false);
    if (!unsaid.ok) expect(unsaid.error.code).toBe("VALIDATION_ERROR");

    /* Supplied with no supplier is refused on this path. */
    const nameless = await accountsService.createAccount(
      {
        email: `${PREFIX}-nameless-${randomUUID().slice(0, 8)}@example.invalid`,
        password: PLAINTEXT,
        profileSlots: 5,
        ownership: "supplied",
      },
      { actor: admin },
    );
    expect(nameless.ok).toBe(false);

    /* A supplier on an account that is not supplied is refused too. */
    const contradiction = await accountsService.createAccount(
      {
        email: `${PREFIX}-contra-${randomUUID().slice(0, 8)}@example.invalid`,
        password: PLAINTEXT,
        profileSlots: 5,
        ownership: "owned",
        supplierId: supplier.id,
      },
      { actor: admin },
    );
    expect(contradiction.ok).toBe(false);

    /* And the coherent pair is stored as given. */
    const supplied = await makeAccount("created-supplied", {
      ownership: "supplied",
      supplierId: supplier.id,
    });
    expect(await accountRow(supplied.id)).toMatchObject({
      ownership: "supplied",
      supplier_id: supplier.id,
    });

    const owned = await makeAccount("created-owned", { ownership: "owned" });
    expect(await accountRow(owned.id)).toMatchObject({ ownership: "owned", supplier_id: null });
  });

  it("applies one answer to a whole bulk import", async () => {
    const { accountsService } = await modules();
    const supplier = await makeSupplier("bulk");
    const tag = randomUUID().slice(0, 8);

    const rows = [
      `${PREFIX}-bulk1-${tag}@example.invalid,${PLAINTEXT},DZ`,
      `${PREFIX}-bulk2-${tag}@example.invalid,${PLAINTEXT},MA`,
    ].join("\n");

    /* The envelope is validated too: supplied must name a supplier. */
    const refused = await accountsService.createAccountsInBulk(
      { rows, ownership: "supplied", supplierId: null },
      { actor: admin },
    );
    expect(refused.ok).toBe(false);

    const created = await accountsService.createAccountsInBulk(
      { rows, ownership: "supplied", supplierId: supplier.id },
      { actor: admin },
    );
    expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
    if (!created.ok) return;
    expect(created.value.created).toHaveLength(2);

    for (const account of created.value.created) {
      expect(await accountRow(account.id)).toMatchObject({
        ownership: "supplied",
        supplier_id: supplier.id,
      });
    }

    const detail = await suppliersDetail(supplier.id);
    expect(detail).toBe(2);
  });
});

/** The supplier's account count, as the page would read it. */
async function suppliersDetail(id: string): Promise<number> {
  const { suppliersService } = await modules();
  const detail = await suppliersService.detail(id, {}, admin);
  if (!detail.ok) throw new Error(detail.error.message);
  return detail.value.accountCount;
}

/* ------------------------------------------------------------ reassignment */

describe.skipIf(!local)("changing an account's provenance", () => {
  it("clears the supplier when an account becomes ours, and refuses a dead supplier", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("reassign");
    const account = await makeAccount("reassign", {
      ownership: "supplied",
      supplierId: supplier.id,
    });

    const owned = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "owned" } },
      { actor: admin },
    );
    expect(owned.ok, owned.ok ? "" : owned.error.message).toBe(true);

    /*
     * Both columns move together. Leaving supplier_id behind would violate
     * accounts_supplier_requires_supplied, so this is also the check that the
     * database constraint is never the thing that catches it.
     */
    expect(await accountRow(account.id)).toMatchObject({ ownership: "owned", supplier_id: null });

    /* A supplier that has been deleted cannot be chosen, FK or no FK. */
    const gone = await makeSupplier("reassign-gone");
    const removed = await suppliersService.remove(gone.id, { actor: admin });
    expect(removed.ok).toBe(true);

    const refused = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "supplied", supplierId: gone.id } },
      { actor: admin },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VALIDATION_ERROR");

    /* The failed assignment changed nothing. */
    expect(await accountRow(account.id)).toMatchObject({ ownership: "owned", supplier_id: null });
  });

  it("clears the supplier through the account edit path too", async () => {
    const { accountsService } = await modules();
    const supplier = await makeSupplier("edit");
    const account = await makeAccount("edit", {
      ownership: "supplied",
      supplierId: supplier.id,
    });

    /*
     * The account form sends `ownership` without mentioning the supplier. If
     * `updateAccount` wrote only the one column, the row would keep a supplier
     * while claiming to be ours — which the database's
     * `accounts_supplier_requires_supplied` check rejects, so the operator
     * would get a raw constraint error instead of an edit.
     */
    const updated = await accountsService.updateAccount(
      account.id,
      { ownership: "owned" },
      { actor: admin },
    );
    expect(updated.ok, updated.ok ? "" : updated.error.message).toBe(true);
    expect(await accountRow(account.id)).toMatchObject({ ownership: "owned", supplier_id: null });

    /* And the same path can hand it to a supplier again. */
    const back = await accountsService.updateAccount(
      account.id,
      { ownership: "supplied", supplierId: supplier.id },
      { actor: admin },
    );
    expect(back.ok, back.ok ? "" : back.error.message).toBe(true);
    expect(await accountRow(account.id)).toMatchObject({
      ownership: "supplied",
      supplier_id: supplier.id,
    });

    /* Editing something else leaves provenance exactly as it was. */
    const noted = await accountsService.updateAccount(
      account.id,
      { notes: "m09b untouched provenance" },
      { actor: admin },
    );
    expect(noted.ok, noted.ok ? "" : noted.error.message).toBe(true);
    expect(await accountRow(account.id)).toMatchObject({
      ownership: "supplied",
      supplier_id: supplier.id,
    });
  });

  it("lists a supplied account with no supplier for triage, and drops it once resolved", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("triage");
    const account = await makeAccount("triage", { ownership: "owned" });

    /*
     * "Supplied, supplier not recorded" is deliberately storable: an operator
     * who knows an account came from outside but not from whom must be able to
     * say so. It is surfaced until it is resolved.
     */
    const parked = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "supplied", supplierId: null } },
      { actor: admin },
    );
    expect(parked.ok, parked.ok ? "" : parked.error.message).toBe(true);
    expect(await accountRow(account.id)).toMatchObject({
      ownership: "supplied",
      supplier_id: null,
    });

    const waiting = await suppliersService.overview({}, admin);
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.value.unassigned.map((row) => row.id)).toContain(account.id);
    expect(waiting.value.metrics.suppliedWithoutSupplier).toBeGreaterThan(0);

    const resolved = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "supplied", supplierId: supplier.id } },
      { actor: admin },
    );
    expect(resolved.ok, resolved.ok ? "" : resolved.error.message).toBe(true);

    const after = await suppliersService.overview({}, admin);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.unassigned.map((row) => row.id)).not.toContain(account.id);
  });

  it("records the change in the audit log without inventing a new entity", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("audit");
    const account = await makeAccount("audit", { ownership: "owned" });

    const assigned = await suppliersService.assign(
      { accountId: account.id, ownership: { ownership: "supplied", supplierId: supplier.id } },
      { actor: admin },
    );
    expect(assigned.ok, assigned.ok ? "" : assigned.error.message).toBe(true);

    const [entry] = await sql!<
      { entity: string; action: string; before: unknown; after: unknown }[]
    >`select entity::text, action::text, before, after
      from audit_logs
      where entity = 'account' and entity_id = ${account.id}::uuid and action = 'update'
      order by created_at desc limit 1`;

    expect(entry).toBeDefined();
    const after = entry!.after as Record<string, unknown>;
    expect(after["event"]).toBe("supplier_assigned");
    expect(after["ownership"]).toBe("supplied");
    expect(after["supplierId"]).toBe(supplier.id);

    /* The supplier's own creation is audited under its own entity. */
    const [supplierEntry] = await sql!<{ action: string; after: unknown }[]>`
      select action::text, after from audit_logs
      where entity = 'supplier' and entity_id = ${supplier.id}::uuid
      order by created_at asc limit 1`;
    expect(supplierEntry!.action).toBe("create");
    expect((supplierEntry!.after as Record<string, unknown>)["name"]).toBe(supplier.name);
  });
});

/* ------------------------------------------------------------ list filters */

describe.skipIf(!local)("filtering the lists by source", () => {
  /** Ids of the accounts a list page returns for one source value. */
  async function accountsFor(raw: string): Promise<string[]> {
    const { accountsService } = await modules();
    const { parseAccountSource } = await import("@/lib/account-source");
    const result = await accountsService.listAccounts({
      source: parseAccountSource(raw),
      search: PREFIX,
      limit: 100,
      offset: 0,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.items.map((row) => row.account.id);
  }

  async function problemAccountsFor(raw: string): Promise<string[]> {
    const { problemsService } = await modules();
    const { parseAccountSource } = await import("@/lib/account-source");
    const result = await problemsService.list(
      { source: parseAccountSource(raw), search: PREFIX, limit: 100, offset: 0 },
      admin,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value.items.map((entry) => entry.problem.accountId);
  }

  it("returns exactly the accounts and problems from each source", async () => {
    const { suppliersService, problemsService } = await modules();
    const karim = await makeSupplier("filter-karim");
    const other = await makeSupplier("filter-other");

    const fromKarim = await makeAccount("filter-karim", {
      ownership: "supplied",
      supplierId: karim.id,
    });
    const fromOther = await makeAccount("filter-other", {
      ownership: "supplied",
      supplierId: other.id,
    });
    const ours = await makeAccount("filter-ours", { ownership: "owned" });
    const undecided = await makeAccount("filter-undecided", { ownership: "unknown" });
    const parked = await makeAccount("filter-parked", { ownership: "owned" });
    const moved = await suppliersService.assign(
      { accountId: parked.id, ownership: { ownership: "supplied", supplierId: null } },
      { actor: admin },
    );
    expect(moved.ok).toBe(true);

    /* ---------------------------------------------------------- Accounts */
    const karimIds = await accountsFor(`supplier:${karim.id}`);
    expect(karimIds).toContain(fromKarim.id);
    expect(karimIds).not.toContain(fromOther.id);
    expect(karimIds).not.toContain(ours.id);

    const anySupplier = await accountsFor("supplied");
    expect(anySupplier).toEqual(expect.arrayContaining([fromKarim.id, fromOther.id, parked.id]));
    expect(anySupplier).not.toContain(ours.id);
    expect(anySupplier).not.toContain(undecided.id);

    const unassigned = await accountsFor("unassigned");
    expect(unassigned).toContain(parked.id);
    expect(unassigned).not.toContain(fromKarim.id);

    const owned = await accountsFor("owned");
    expect(owned).toContain(ours.id);
    expect(owned).not.toContain(fromKarim.id);

    expect(await accountsFor("unknown")).toContain(undecided.id);

    /* A value the parser does not recognise filters nothing. */
    const unfiltered = await accountsFor("supplier:not-a-uuid");
    expect(unfiltered).toEqual(expect.arrayContaining([fromKarim.id, ours.id, undecided.id]));

    /* ---------------------------------------------------------- Problems */
    for (const account of [fromKarim, fromOther, ours]) {
      const reported = await problemsService.report(
        {
          accountId: account.id,
          issueType: "payment_problem",
          description: `${PREFIX} source filter`,
        },
        { actor: worker },
      );
      expect(reported.ok, reported.ok ? "" : reported.error.message).toBe(true);
    }

    const karimProblems = await problemAccountsFor(`supplier:${karim.id}`);
    expect(karimProblems).toEqual([fromKarim.id]);

    const suppliedProblems = await problemAccountsFor("supplied");
    expect(suppliedProblems).toEqual(expect.arrayContaining([fromKarim.id, fromOther.id]));
    expect(suppliedProblems).not.toContain(ours.id);

    expect(await problemAccountsFor("owned")).toContain(ours.id);
    expect(await problemAccountsFor("owned")).not.toContain(fromKarim.id);
  });
});

/* ----------------------------------------------------------------- metrics */

describe.skipIf(!local)("the dashboard figure", () => {
  it("counts only accounts explicitly classified as supplied", async () => {
    const { suppliersService } = await modules();
    const supplier = await makeSupplier("metrics");

    const before = await suppliersService.metrics(admin);
    expect(before.ok, before.ok ? "" : before.error.message).toBe(true);
    if (!before.ok) return;

    await makeAccount("metrics-supplied", { ownership: "supplied", supplierId: supplier.id });
    await makeAccount("metrics-owned", { ownership: "owned" });
    await makeAccount("metrics-unknown", { ownership: "unknown" });
    const second = await makeSupplier("metrics-second");

    const after = await suppliersService.metrics(admin);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    /*
     * One supplied account more, one unclassified account more, and the owned
     * one counted in neither — the distinction the whole metric exists for.
     */
    expect(after.value.suppliedAccounts).toBe(before.value.suppliedAccounts + 1);
    expect(after.value.unknownOwnership).toBe(before.value.unknownOwnership + 1);

    /* And the supplier tally tracks the one added between the two readings. */
    expect(after.value.totalSuppliers).toBe(before.value.totalSuppliers + 1);
    expect(second.id).not.toBe(supplier.id);
  });
});
