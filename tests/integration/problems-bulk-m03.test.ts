import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * Problems page bulk actions (M03), against the isolated database.
 *
 * Every bulk action re-reads each problem and runs the existing per-problem
 * service on it — resolution, assignment, deletion — so these tests check the
 * outcome in rows: what changed, what was skipped, what was refused, and what
 * that did to the account's place in Accounts, Quick Prepare and Quick Replace.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;

const NOTE = { resolutionNote: "Fixed during the bulk verification run." };

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
const TAG = `pb${Date.now() % 100000}`;

async function makeAccount(label: string) {
  const { accountsService } = await services();
  counter += 1;
  const email = `${TAG}-${label}-${counter}@example.invalid`;
  const created = await accountsService.createAccount(
    { email, password: "not-a-real-password", country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email };
}

async function report(accountId: string, issueType = "payment_problem") {
  const { problemsService } = await services();
  const created = await problemsService.report({ accountId, issueType }, { actor: superAdmin });
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function statusOf(problemId: string) {
  const [row] = await sql!<
    { status: string; resolved_at: Date | null; assigned_to: string | null }[]
  >`
    select status, resolved_at, assigned_to from issues where id = ${problemId}::uuid`;
  return row;
}

async function onAccountsPage(accountId: string): Promise<boolean> {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 200, search: TAG });
  if (!page.ok) throw new Error(page.error.message);
  return page.value.items.some((row) => row.account.id === accountId);
}

async function onProblemsPage(accountId: string): Promise<boolean> {
  const { problemsService } = await services();
  const page = await problemsService.list({ blocking: true, limit: 200 }, superAdmin);
  if (!page.ok) throw new Error(page.error.message);
  return page.value.items.some((entry) => entry.problem.accountId === accountId);
}

async function quickPrepareAccounts(): Promise<Set<string>> {
  const { quickPrepareService } = await services();
  const stock = await quickPrepareService.availableStock();
  if (!stock.ok) throw new Error(stock.error.message);
  if (stock.value === 0) return new Set();
  const preview = await quickPrepareService.preview({
    profileCount: Math.min(stock.value, 20),
    durationDays: 30,
  });
  if (!preview.ok) throw new Error(preview.error.message);
  return new Set(preview.value.accounts.map((a) => a.accountId));
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

describe.skipIf(!local)("bulk Resolve", () => {
  it("8. resolves one problem through the existing resolution, with its note and audit", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("one");
    const problem = await report(account.id);

    const outcome = await bulkProblemsService.resolveProblems([problem], NOTE, {
      actor: superAdmin,
    });

    expect(outcome.ok && outcome.value).toEqual({ succeeded: [problem], skipped: [], failed: [] });
    expect((await statusOf(problem))?.status).toBe("resolved");

    const [audit] = await sql!<{ after: Record<string, unknown> }[]>`
      select after from audit_logs where entity = 'issue' and entity_id = ${problem}::uuid
      order by created_at desc limit 1`;
    expect(audit?.after).toMatchObject({ status: "resolved", resolutionNote: NOTE.resolutionNote });
  });

  it("9, 12–13. resolves several; the account whose last blocking problem went returns", async () => {
    const { bulkProblemsService } = await services();
    const a = await makeAccount("multi-a");
    const b = await makeAccount("multi-b");
    const a1 = await report(a.id, "payment_problem");
    const a2 = await report(a.id, "invalid_email");
    const b1 = await report(b.id, "payment_problem");

    /* Resolve a1 and b1: b is clear, a still has a2. */
    const outcome = await bulkProblemsService.resolveProblems([a1, b1], NOTE, {
      actor: superAdmin,
    });

    expect(outcome.ok && outcome.value.succeeded).toEqual([a1, b1]);
    expect(await onAccountsPage(b.id)).toBe(true);
    expect(await onProblemsPage(b.id)).toBe(false);
    expect(await onAccountsPage(a.id)).toBe(false);
    expect(await onProblemsPage(a.id)).toBe(true);

    /* No write to accounts.status: both still store healthy. */
    const accounts = await sql!<{ status: string }[]>`
      select status from accounts where id in (${a.id}::uuid, ${b.id}::uuid)`;
    expect(accounts.map((row) => row.status)).toEqual(["healthy", "healthy"]);

    await bulkProblemsService.resolveProblems([a2], NOTE, { actor: superAdmin });
    expect(await onAccountsPage(a.id)).toBe(true);
  });

  it("10. skips a problem that is already resolved or closed — never reopens it", async () => {
    const { bulkProblemsService, problemResolutionService } = await services();
    const account = await makeAccount("skip");
    const open = await report(account.id);
    const done = await report(account.id, "other");
    await problemResolutionService.resolve(done, NOTE, { actor: superAdmin });
    await problemResolutionService.close(done, { actor: superAdmin });
    const before = await statusOf(done);

    const outcome = await bulkProblemsService.resolveProblems([open, done], NOTE, {
      actor: superAdmin,
    });

    expect(outcome.ok && outcome.value).toEqual({
      succeeded: [open],
      skipped: [{ id: done, reason: "Already closed." }],
      failed: [],
    });
    expect(await statusOf(done)).toEqual(before);
  });

  it("11. refuses a Worker resolving problems not assigned to them, changing nothing", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("worker");
    const problem = await report(account.id);

    const outcome = await bulkProblemsService.resolveProblems([problem], NOTE, { actor: worker });

    expect(outcome.ok && outcome.value.failed.map((f) => f.id)).toEqual([problem]);
    expect((await statusOf(problem))?.status).toBe("open");
    expect(await onAccountsPage(account.id)).toBe(false);
  });

  it("enforces the existing note rule for every problem in the batch", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("no-note");
    const problem = await report(account.id);

    const outcome = await bulkProblemsService.resolveProblems(
      [problem],
      { resolutionNote: "short" },
      { actor: superAdmin },
    );

    expect(outcome.ok && outcome.value.failed).toHaveLength(1);
    expect((await statusOf(problem))?.status).toBe("open");
  });

  it("reports a problem deleted since it was selected", async () => {
    const { bulkProblemsService, problemsService } = await services();
    const account = await makeAccount("gone");
    const problem = await report(account.id);
    await problemsService.remove(problem, { actor: superAdmin });

    const outcome = await bulkProblemsService.resolveProblems([problem], NOTE, {
      actor: superAdmin,
    });

    expect(outcome.ok && outcome.value.failed).toEqual([
      { id: problem, message: "This problem no longer exists." },
    ]);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("bulk Delete", () => {
  it("14–15, 18. deletes one and several problems, and nothing else", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("delete");
    const p1 = await report(account.id);
    const p2 = await report(account.id, "invalid_email");
    const p3 = await report(account.id, "other");

    const counts = async () => {
      const [row] = await sql!<{ accounts: number; profiles: number; customers: number }[]>`
        select (select count(*)::int from accounts) accounts,
               (select count(*)::int from profiles) profiles,
               (select count(*)::int from customers) customers`;
      return row;
    };
    const before = await counts();

    const one = await bulkProblemsService.deleteProblems([p1], { actor: superAdmin });
    const two = await bulkProblemsService.deleteProblems([p2, p3], { actor: superAdmin });

    expect(one.ok && one.value.succeeded).toEqual([p1]);
    expect(two.ok && two.value.succeeded).toEqual([p2, p3]);

    const left = await sql!<{ n: number }[]>`
      select count(*)::int n from issues where id in (${p1}::uuid, ${p2}::uuid, ${p3}::uuid)`;
    expect(left[0]!.n).toBe(0);
    expect(await counts()).toEqual(before);

    /* The deletion is audited. */
    const audits = await sql!<{ n: number }[]>`
      select count(*)::int n from audit_logs where entity = 'issue' and action = 'delete'
      and entity_id in (${p1}::uuid, ${p2}::uuid, ${p3}::uuid)`;
    expect(audits[0]!.n).toBe(3);

    /* Its only blocking problems gone, the account is operational again. */
    expect(await onAccountsPage(account.id)).toBe(true);
  });

  it("17. refuses a Worker outright, deleting nothing", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("delete-worker");
    const problem = await report(account.id);

    const result = await bulkProblemsService.deleteProblems([problem], { actor: worker });

    expect(result.ok || result.error.code).toBe("FORBIDDEN");
    expect(await statusOf(problem)).toBeDefined();
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("bulk Assign", () => {
  it("19–20. assigns one and several problems through the existing assignment", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("assign");
    const p1 = await report(account.id);
    const p2 = await report(account.id, "other");

    const one = await bulkProblemsService.assignProblems(
      [p1],
      { assignedTo: worker.id },
      { actor: superAdmin },
    );
    expect(one.ok && one.value.succeeded).toEqual([p1]);

    /* p1 is already the worker's: skipped, not rewritten. */
    const both = await bulkProblemsService.assignProblems(
      [p1, p2],
      { assignedTo: worker.id },
      { actor: superAdmin },
    );
    expect(both.ok && both.value).toEqual({
      succeeded: [p2],
      skipped: [{ id: p1, reason: "Already assigned to that person." }],
      failed: [],
    });
    expect((await statusOf(p2))?.assigned_to).toBe(worker.id);
  });

  it("21. refuses a Worker handing problems to someone else", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount("assign-worker");
    const problem = await report(account.id);

    const outcome = await bulkProblemsService.assignProblems(
      [problem],
      { assignedTo: superAdmin.id },
      { actor: worker },
    );

    expect(outcome.ok && outcome.value.failed.map((f) => f.id)).toEqual([problem]);
    expect((await statusOf(problem))?.assigned_to).toBeNull();
  });

  it("refuses to assign a closed problem, as the single assignment does", async () => {
    const { bulkProblemsService, problemResolutionService } = await services();
    const account = await makeAccount("assign-closed");
    const problem = await report(account.id);
    await problemResolutionService.resolve(problem, NOTE, { actor: superAdmin });
    await problemResolutionService.close(problem, { actor: superAdmin });

    const outcome = await bulkProblemsService.assignProblems(
      [problem],
      { assignedTo: worker.id },
      { actor: superAdmin },
    );

    expect(outcome.ok && outcome.value.failed.map((f) => f.id)).toEqual([problem]);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("Accounts and Problems stay consistent", () => {
  it("22–25. blocked: off Accounts, on Problems, not sold; resolved: the reverse", async () => {
    const { bulkProblemsService, quickReplaceService } = await services();
    const account = await makeAccount("consistency");
    const problem = await report(account.id);

    expect(await onAccountsPage(account.id)).toBe(false);
    expect(await onProblemsPage(account.id)).toBe(true);
    expect(await quickPrepareAccounts()).not.toContain(account.id);
    let replace = await quickReplaceService.preview({ accountEmail: account.email });
    expect(replace.ok && [...new Set(replace.value.accountProfiles.map((s) => s.state))]).toEqual([
      "blocked",
    ]);

    const { quickPrepareService } = await services();
    const stockBefore = await quickPrepareService.availableStock();

    await bulkProblemsService.resolveProblems([problem], NOTE, { actor: superAdmin });

    expect(await onAccountsPage(account.id)).toBe(true);
    expect(await onProblemsPage(account.id)).toBe(false);

    /*
     * Quick Prepare can sell it again: its five free profiles are back in the
     * stock the allocator draws from. Measured as a delta, because a preview is
     * capped at 20 profiles and need not pick this account among many.
     */
    const stockAfter = await quickPrepareService.availableStock();
    expect(stockBefore.ok && stockAfter.ok && stockAfter.value - stockBefore.value).toBe(5);
    replace = await quickReplaceService.preview({ accountEmail: account.email });
    expect(replace.ok && [...new Set(replace.value.accountProfiles.map((s) => s.state))]).toEqual([
      "available",
    ]);
  });
});
