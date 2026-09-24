import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M03 revision — the Accounts list is the operational list, and its bulk
 * actions. Against the isolated database, through the real services.
 *
 *   Accounts  = live accounts with no blocking problem
 *   Problems  = accounts with an open / in-progress / waiting problem
 *
 * The exclusion is `accountHasNoBlockingProblemSql` in the list query's WHERE
 * clause, so these tests also check what a query-side rule must guarantee: the
 * total and every page are counted over the same set.
 *
 * LOCAL ONLY: creates, resolves, notes and deletes accounts.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;

async function services() {
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService, problemResolutionService, bulkProblemsService } =
    await import("@/modules/problems");
  const { quickPrepareService, quickReplaceService } = await import("@/modules/quick-prepare");
  return {
    accountsService,
    problemsService,
    problemResolutionService,
    bulkProblemsService,
    quickPrepareService,
    quickReplaceService,
  };
}

let counter = 0;
/** Unique per run, so this file's accounts can be found among any others. */
const TAG = `op${Date.now() % 100000}`;

async function makeAccount(label: string, password = `pw-${label}-Secret!`) {
  const { accountsService } = await services();
  counter += 1;
  const email = `${TAG}-${label}-${counter}@example.invalid`;

  const created = await accountsService.createAccount(
    { email, password, country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email, password };
}

async function report(accountId: string, issueType = "payment_problem") {
  const { problemsService } = await services();
  const created = await problemsService.report({ accountId, issueType }, { actor: superAdmin });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

async function resolve(problemId: string) {
  const { problemResolutionService } = await services();
  const result = await problemResolutionService.resolve(
    problemId,
    { resolutionNote: "Fixed during the verification run." },
    { actor: superAdmin },
  );
  if (!result.ok) throw new Error(result.error.message);
}

/** The Accounts page: the default list, exactly as the page asks for it. */
async function accountsPage(filter: Record<string, unknown> = {}) {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 200, search: TAG, ...filter });
  if (!page.ok) throw new Error(page.error.message);
  return page.value;
}

async function onAccountsPage(accountId: string): Promise<boolean> {
  return (await accountsPage()).items.some((row) => row.account.id === accountId);
}

async function onProblemsPage(accountId: string): Promise<boolean> {
  const { problemsService } = await services();
  const page = await problemsService.list({ blocking: true, limit: 200 }, superAdmin);
  if (!page.ok) throw new Error(page.error.message);
  return page.value.items.some((entry) => entry.problem.accountId === accountId);
}

beforeAll(async () => {
  if (!local) return;

  const rows = await sql!<{ id: string; email: string; name: string; role: string }[]>`
    select id, email, name, role from users where status = 'active' and deleted_at is null`;

  const admin = rows.find((row) => row.role === "super_admin")!;
  const seededWorker = rows.find((row) => row.role === "worker")!;

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
  worker = {
    id: seededWorker.id,
    email: seededWorker.email,
    displayName: seededWorker.name,
    initials: "W",
    role: "worker",
  };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("the Accounts list is the operational list", () => {
  it("1. a healthy operational account appears", async () => {
    const account = await makeAccount("healthy");

    expect(await onAccountsPage(account.id)).toBe(true);
    expect(await onProblemsPage(account.id)).toBe(false);
  });

  it("2. an account with a blocking problem does not appear — it is on Problems", async () => {
    const account = await makeAccount("blocked");
    await report(account.id, "payment_problem");

    expect(await onAccountsPage(account.id)).toBe(false);
    expect(await onProblemsPage(account.id)).toBe(true);

    /* 17. Not even when searched for by its exact email. */
    const searched = await accountsPage({ search: account.email });
    expect(searched.items).toHaveLength(0);
    expect(searched.total).toBe(0);

    /* 33. It has not vanished: its own page still shows the problem. */
    const { accountsService } = await services();
    const detail = await accountsService.getAccountDetail(account.id);
    expect(detail.ok && detail.value.activeProblems.map((p) => p.issueType)).toEqual([
      "payment_problem",
    ]);
  });

  it("3. a problem in a non-blocking status leaves the account in Accounts", async () => {
    const { problemResolutionService } = await services();
    const account = await makeAccount("cancelled");
    const problem = await report(account.id, "something_went_wrong");
    await problemResolutionService.cancel(problem.id, { actor: superAdmin });

    expect(await onAccountsPage(account.id)).toBe(true);
    expect(await onProblemsPage(account.id)).toBe(false);
  });

  it("4. resolving the only blocking problem returns the account to Accounts", async () => {
    const account = await makeAccount("resolved");
    const problem = await report(account.id);
    expect(await onAccountsPage(account.id)).toBe(false);

    await resolve(problem.id);

    expect(await onAccountsPage(account.id)).toBe(true);
    expect(await onProblemsPage(account.id)).toBe(false);
  });

  it("5. with two blocking problems it stays out until the LAST is resolved", async () => {
    const account = await makeAccount("two");
    const first = await report(account.id, "payment_problem");
    const second = await report(account.id, "invalid_email");

    await resolve(first.id);
    expect(await onAccountsPage(account.id)).toBe(false);
    expect(await onProblemsPage(account.id)).toBe(true);

    await resolve(second.id);
    expect(await onAccountsPage(account.id)).toBe(true);
  });

  it("18. counts and pages over the operational set, in the query", async () => {
    const { accountsService } = await services();
    const pageTag = `${TAG}pg`;
    const made: { id: string }[] = [];

    for (let i = 0; i < 5; i += 1) {
      counter += 1;
      const created = await accountsService.createAccount(
        { email: `${pageTag}-${counter}@example.invalid`, password: "x-Secret-1!", country: "DZ" },
        { actor: superAdmin },
      );
      if (!created.ok) throw new Error(created.error.message);
      made.push({ id: created.value.id });
    }

    await report(made[1]!.id);
    await report(made[3]!.id);

    const all = await accountsService.listAccounts({ search: pageTag, limit: 2, offset: 0 });
    const next = await accountsService.listAccounts({ search: pageTag, limit: 2, offset: 2 });
    if (!all.ok || !next.ok) throw new Error("list failed");

    expect(all.value.total).toBe(3);
    const seen = [...all.value.items, ...next.value.items].map((row) => row.account.id);
    expect(seen).toHaveLength(3);
    expect(seen).not.toContain(made[1]!.id);
    expect(seen).not.toContain(made[3]!.id);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("Copy Credentials", () => {
  let logged: string[] = [];

  beforeEach(() => {
    logged = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("13. returns each account's own email and password, in the order selected", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("cred-a", "Alpha-Pass-111!");
    const b = await makeAccount("cred-b", "Bravo-Pass-222!");

    const result = await accountsService.revealCredentials([b.id, a.id], { actor: worker });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual([
      { email: b.email, password: "Bravo-Pass-222!" },
      { email: a.email, password: "Alpha-Pass-111!" },
    ]);
  });

  it("16. audits that each credential was read — never the password itself", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("cred-audit", "Charlie-Pass-333!");

    await accountsService.revealCredentials([a.id], { actor: superAdmin });

    const audits = await sql!<{ after: Record<string, unknown> }[]>`
      select after from audit_logs where entity_id = ${a.id}::uuid order by created_at`;
    expect(audits.at(-1)?.after).toMatchObject({ event: "password_revealed" });

    const everything = await sql!<{ n: number }[]>`
      select count(*)::int n from audit_logs where coalesce(before::text, '') || coalesce(after::text, '') like ${"%Charlie-Pass-333!%"}`;
    expect(everything[0]!.n).toBe(0);
    expect(logged.join("\n")).not.toContain("Charlie-Pass-333!");
  });

  it("is all or nothing: one deleted account refuses the batch, and names no password", async () => {
    const { accountsService } = await services();
    const live = await makeAccount("cred-live", "Delta-Pass-444!");
    const gone = await makeAccount("cred-gone", "Echo-Pass-555!");
    await accountsService.softDeleteAccount(gone.id, { actor: superAdmin });

    const result = await accountsService.revealCredentials([live.id, gone.id], {
      actor: superAdmin,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const surfaces = `${result.error.message} ${result.error.userMessage} ${JSON.stringify(result.error.toLogObject())}`;
      expect(surfaces).not.toContain("Delta-Pass-444!");
      expect(surfaces).not.toContain("Echo-Pass-555!");
    }
    expect(logged.join("\n")).not.toContain("Delta-Pass-444!");
  });

  it("15. refuses a caller with no session, and the single reveal does too", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("cred-anon");

    const bulk = await accountsService.revealCredentials([a.id], { actor: null });
    const single = await accountsService.revealPassword(a.id, { actor: null });

    expect(bulk.ok || bulk.error.code).toBe("FORBIDDEN");
    expect(single.ok || single.error.code).toBe("FORBIDDEN");
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("account notes", () => {
  async function notesOf(ids: string[]) {
    const rows = await sql!<{ id: string; notes: string | null }[]>`
      select id, notes from accounts where id = any(${sql!.array(ids)}::uuid[])`;
    return Object.fromEntries(rows.map((row) => [row.id, row.notes]));
  }

  it("17–18. adds and edits one account's note through the existing editor path", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("note-one");

    await accountsService.updateAccount(a.id, { notes: "First note" }, { actor: superAdmin });
    await accountsService.updateAccount(a.id, { notes: "Edited note" }, { actor: superAdmin });

    expect((await notesOf([a.id]))[a.id]).toBe("Edited note");
  });

  it("19–20. a bulk note will not replace existing notes without confirmation", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("note-a");
    const b = await makeAccount("note-b");
    await accountsService.updateAccount(b.id, { notes: "Keep me" }, { actor: superAdmin });

    const refused = await accountsService.setNotesForAccounts(
      [a.id, b.id],
      { note: "Bulk note" },
      { actor: superAdmin },
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CONFLICT");
    expect(await notesOf([a.id, b.id])).toEqual({ [a.id]: null, [b.id]: "Keep me" });

    const confirmed = await accountsService.setNotesForAccounts(
      [a.id, b.id],
      {
        note: "Bulk note",
        confirmOverwrite: true,
        expectedNotes: { [a.id]: null, [b.id]: "Keep me" },
      },
      { actor: superAdmin },
    );

    expect(confirmed.ok && confirmed.value.updated).toBe(2);
    expect(await notesOf([a.id, b.id])).toEqual({ [a.id]: "Bulk note", [b.id]: "Bulk note" });

    /* Audited per account, with old and new note. */
    const [audit] = await sql!<
      { before: Record<string, unknown>; after: Record<string, unknown> }[]
    >`
      select before, after from audit_logs where entity_id = ${b.id}::uuid
      order by created_at desc limit 1`;
    expect(audit).toMatchObject({
      before: { notes: "Keep me" },
      after: { notes: "Bulk note", changedFields: ["notes"] },
    });
  });

  it("refuses — changing nothing — when a note changed after the dialog opened", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("note-stale");
    const b = await makeAccount("note-stale-2");

    /* The operator saw both empty; someone else adds a note to b in between. */
    await accountsService.updateAccount(b.id, { notes: "Added meanwhile" }, { actor: superAdmin });

    const result = await accountsService.setNotesForAccounts(
      [a.id, b.id],
      { note: "Bulk", confirmOverwrite: true, expectedNotes: { [a.id]: null, [b.id]: null } },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    expect(await notesOf([a.id, b.id])).toEqual({ [a.id]: null, [b.id]: "Added meanwhile" });
  });

  it("refuses the whole batch if a selected account was deleted meanwhile", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("note-live");
    const gone = await makeAccount("note-gone");
    await accountsService.softDeleteAccount(gone.id, { actor: superAdmin });

    const result = await accountsService.setNotesForAccounts(
      [a.id, gone.id],
      { note: "Bulk", confirmOverwrite: true },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    expect((await notesOf([a.id]))[a.id]).toBeNull();
  });

  it("refuses a Worker, who may not edit accounts", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("note-worker");

    const result = await accountsService.setNotesForAccounts(
      [a.id],
      { note: "x", confirmOverwrite: true },
      { actor: worker },
    );

    expect(result.ok || result.error.code).toBe("FORBIDDEN");
    expect((await notesOf([a.id]))[a.id]).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("Resolve", () => {
  it("21–22. the bulk Resolve uses the Problems resolution, and the account returns", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("bulk-resolve");
    await report(account.id);

    const outcome = await bulkProblemsService.resolveForAccounts(
      [account.id],
      { resolutionNote: "Payment method updated by the owner." },
      { actor: superAdmin },
    );

    expect(outcome.ok && outcome.value.succeeded).toEqual([account.id]);
    expect(await onAccountsPage(account.id)).toBe(true);

    /* Resolved through the lifecycle, with the note — not by editing account.status. */
    const [row] = await sql!<{ status: string; resolution_note: string; account_status: string }[]>`
      select i.status, i.resolution_note, a.status as account_status
      from issues i join accounts a on a.id = i.account_id where i.account_id = ${account.id}::uuid`;
    expect(row).toMatchObject({ status: "resolved", account_status: "healthy" });
    expect(row!.resolution_note).toContain("Payment method");
  });

  it("24. refuses a Worker resolving a problem that is not theirs", async () => {
    const { problemResolutionService } = await services();
    const account = await makeAccount("worker-resolve");
    const problem = await report(account.id);

    const result = await problemResolutionService.resolve(
      problem.id,
      { resolutionNote: "Trying to resolve somebody else's problem." },
      { actor: worker },
    );

    expect(result.ok).toBe(false);
    expect(await onAccountsPage(account.id)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("Delete", () => {
  it("25–26, 29. deletes one and several through the soft delete — rows are kept", async () => {
    const { accountsService } = await services();
    const one = await makeAccount("del-one");
    const two = await makeAccount("del-two");
    const three = await makeAccount("del-three");

    const [before] = await sql!<{ n: number }[]>`select count(*)::int n from accounts`;

    expect((await accountsService.softDeleteAccount(one.id, { actor: superAdmin })).ok).toBe(true);
    const bulk = await accountsService.softDeleteAccounts([two.id, three.id], {
      actor: superAdmin,
    });
    expect(bulk.ok && bulk.value.deleted).toEqual([two.id, three.id]);

    const [after] = await sql!<{ n: number }[]>`select count(*)::int n from accounts`;
    expect(after!.n).toBe(before!.n);

    const rows = await sql!<{ status: string; deleted: boolean }[]>`
      select status, deleted_at is not null as deleted from accounts
      where id in (${one.id}::uuid, ${two.id}::uuid, ${three.id}::uuid)`;
    expect(rows.every((row) => row.status === "deleted" && row.deleted)).toBe(true);

    for (const id of [one.id, two.id, three.id]) {
      expect(await onAccountsPage(id)).toBe(false);
    }
  });

  it("reports an account deleted meanwhile, rather than failing silently", async () => {
    const { accountsService } = await services();
    const live = await makeAccount("del-live");
    const gone = await makeAccount("del-gone");
    await accountsService.softDeleteAccount(gone.id, { actor: superAdmin });

    const bulk = await accountsService.softDeleteAccounts([live.id, gone.id], {
      actor: superAdmin,
    });

    expect(bulk.ok).toBe(true);
    if (bulk.ok) {
      expect(bulk.value.deleted).toEqual([live.id]);
      expect(bulk.value.failed.map((failure) => failure.id)).toEqual([gone.id]);
    }
  });

  it("28. refuses a Worker, deleting nothing", async () => {
    const { accountsService } = await services();
    const a = await makeAccount("del-worker");

    const result = await accountsService.softDeleteAccounts([a.id], { actor: worker });

    expect(result.ok || result.error.code).toBe("FORBIDDEN");
    expect(await onAccountsPage(a.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("regressions", () => {
  it("30–31. Quick Prepare skips a blocked account; Quick Replace shows its free slots blocked", async () => {
    const { quickPrepareService, quickReplaceService } = await services();
    const account = await makeAccount("qp");
    await report(account.id);

    const stock = await quickPrepareService.availableStock();
    if (!stock.ok) throw new Error(stock.error.message);

    if (stock.value > 0) {
      const preview = await quickPrepareService.preview({
        profileCount: Math.min(stock.value, 20),
        durationDays: 30,
      });
      expect(preview.ok && preview.value.accounts.map((a) => a.accountId)).not.toContain(
        account.id,
      );
    }

    const replace = await quickReplaceService.preview({ accountEmail: account.email });
    expect(replace.ok && replace.value.accountProfiles.map((slot) => slot.state)).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
    ]);
  });
});
