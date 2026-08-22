import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * The accounts list reports active problems.
 *
 * The badge rule is unit-tested against `accountBadgeStyle`. This file proves
 * the other half: that the list actually carries the flag the badge needs.
 *
 * `listAccounts` used to ask the Problems module nothing at all, so every row
 * rendered its persisted `accounts.status`. An account with an open payment
 * problem still says `healthy` in that column — ADR-010 Decision 4 keeps
 * problems out of it — so the list showed a green badge while the detail page,
 * which did ask, showed the problem. Same account, two answers.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "p4-status";

let superAdmin: AppUser;

function email(tag: string): string {
  return `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { accountsService } = await import("@/modules/accounts");
  return { accountsService };
}

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const result = await accountsService.createAccount(
    { email: address, password: "not-a-real-password", country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);
  return { id: result.value.id, email: address };
}

/** Writes an issue directly, so the test controls its status exactly. */
async function reportProblem(accountId: string, status: string): Promise<void> {
  const resolved = ["resolved", "closed"].includes(status);

  await sql!`
    insert into public.issues (
      account_id, issue_type, status, severity, description,
      reported_by, resolved_by, resolution_note, resolved_at
    )
    values (
      ${accountId}::uuid, 'payment_problem', ${status}::issue_status, 'medium',
      ${`${PREFIX} fixture`}, ${superAdmin.id}::uuid,
      ${resolved ? superAdmin.id : null}, ${resolved ? "fixture" : null},
      ${resolved ? new Date() : null}
    )`;
}

async function rowFor(accountId: string) {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 100 });
  if (!page.ok) throw new Error(`list failed: ${page.error.message}`);
  return page.value.items.find((row) => row.account.id === accountId);
}

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1`;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
}, 120_000);

afterAll(async () => {
  if (!configured) return;

  await sql!`
    delete from public.issues where account_id in (
      select id from public.accounts where email like ${`${PREFIX}-%@example.invalid`})`;
  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("accounts list reflects active problems", () => {
  it("the reported defect: an open problem makes the row stop reading Healthy", async () => {
    const account = await makeAccount("open");

    const before = await rowFor(account.id);
    expect(before?.account.status, "starts healthy").toBe("healthy");
    expect(before?.hasActiveProblem, "and with nothing open").toBe(false);

    await reportProblem(account.id, "open");

    const after = await rowFor(account.id);
    expect(after?.hasActiveProblem, "the list now reports the problem").toBe(true);

    /*
     * The persisted column is deliberately untouched — ADR-010 Decision 4. The
     * badge is a conjunction of the two facts, not a rewrite of one of them.
     */
    expect(after?.account.status, "accounts.status is not rewritten").toBe("healthy");
  }, 180_000);

  it("every blocking status counts as active", async () => {
    for (const status of ["open", "in_progress", "waiting"] as const) {
      const account = await makeAccount(`blocking-${status}`);
      await reportProblem(account.id, status);

      const row = await rowFor(account.id);
      expect(row?.hasActiveProblem, `${status} is active`).toBe(true);
    }
  }, 180_000);

  it("a resolved or closed problem leaves a healthy account healthy", async () => {
    for (const status of ["resolved", "closed", "cancelled"] as const) {
      const account = await makeAccount(`historical-${status}`);
      await reportProblem(account.id, status);

      const row = await rowFor(account.id);
      expect(row?.hasActiveProblem, `${status} is history, not a fault`).toBe(false);
      expect(row?.account.status).toBe("healthy");
    }
  }, 180_000);

  it("an account with no problems at all is unaffected", async () => {
    const account = await makeAccount("clean");
    const row = await rowFor(account.id);

    expect(row?.hasActiveProblem).toBe(false);
    expect(row?.account.status).toBe("healthy");
  }, 180_000);

  it("reopening a resolved problem makes it active again", async () => {
    const account = await makeAccount("reopened");
    await reportProblem(account.id, "resolved");

    expect((await rowFor(account.id))?.hasActiveProblem, "resolved is not active").toBe(false);

    await sql!`
      update public.issues set status = 'open', resolved_at = null, resolved_by = null,
        resolution_note = null
      where account_id = ${account.id}::uuid`;

    expect((await rowFor(account.id))?.hasActiveProblem, "reopened is active again").toBe(true);
  }, 180_000);

  it("the list and the detail page agree about the same account", async () => {
    const { accountsService } = await services();
    const account = await makeAccount("agreement");
    await reportProblem(account.id, "open");

    const listed = await rowFor(account.id);
    const detail = await accountsService.getAccountDetail(account.id);

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    expect(listed?.hasActiveProblem, "list says there is a problem").toBe(true);
    expect(detail.value.activeProblems.length, "and so does the detail page").toBeGreaterThan(0);
  }, 180_000);
});
