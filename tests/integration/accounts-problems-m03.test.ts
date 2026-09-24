import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import { previewExpirationDate } from "@/modules/accounts/services/profile-dates";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M03 — Accounts + Problems, against a real database.
 *
 * Every screen that describes an account — the Accounts list and detail,
 * Problems, Quick Prepare, Quick Replace — must tell the same story about it,
 * because all of them end at `accountCanAllocate` / `accountCanAllocateSql`
 * and `profileCellState`. These tests drive the real services over the
 * isolated database and compare their answers, rather than re-deriving the
 * rule in the test.
 *
 * Also: profile notes, and the expiration the profile editor shows versus the
 * one the server writes.
 *
 * LOCAL ONLY: it creates accounts, customers and problems, so it runs against
 * the per-file in-process database and nothing else.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;

async function services() {
  const { accountsService, profilesService } = await import("@/modules/accounts");
  const { problemsService, problemResolutionService } = await import("@/modules/problems");
  const { quickPrepareService, quickReplaceService } = await import("@/modules/quick-prepare");
  return {
    accountsService,
    profilesService,
    problemsService,
    problemResolutionService,
    quickPrepareService,
    quickReplaceService,
  };
}

let counter = 0;

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  counter += 1;
  const address = `m03-${tag}-${counter}@example.invalid`;

  const result = await accountsService.createAccount(
    { email: address, password: "not-a-real-password", country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);
  return { id: result.value.id, email: address };
}

async function profileId(accountId: string, profileNumber: number): Promise<string> {
  const rows = await sql!<{ id: string }[]>`
    select id from profiles where account_id = ${accountId}::uuid and profile_number = ${profileNumber}`;
  return rows[0]!.id;
}

async function sell(accountId: string, profileNumber: number, days = 90, soldDaysAgo = 0) {
  counter += 1;
  const digits = String(660_000_000 + counter);

  const [customer] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`m03 customer ${counter}`}, ${`0${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;

  await sql!`
    update profiles
    set status = 'sold', customer_id = ${customer!.id}::uuid,
        sale_date = current_date - ${soldDaysAgo}::int,
        duration_days = ${days}::int,
        expiration_date = current_date - ${soldDaysAgo}::int + ${days}::int
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}`;

  return customer!.id;
}

async function report(accountId: string, issueType: string) {
  const { problemsService } = await services();
  /* No severity, no description — exactly what the simplified form sends. */
  const created = await problemsService.report({ accountId, issueType }, { actor: superAdmin });
  if (!created.ok) throw new Error(`report failed: ${created.error.message}`);
  return created.value;
}

async function listRow(accountId: string) {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 200 });
  if (!page.ok) throw new Error(page.error.message);
  return page.value.items.find((row) => row.account.id === accountId)!;
}

async function listIdsForStatus(status: "healthy" | "payment_problem"): Promise<Set<string>> {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 200, status });
  if (!page.ok) throw new Error(page.error.message);
  return new Set(page.value.items.map((row) => row.account.id));
}

async function detail(accountId: string) {
  const { accountsService } = await services();
  const result = await accountsService.getAccountDetail(accountId);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Account ids Quick Prepare would draw from, asking for all available stock. */
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
  return new Set(preview.value.accounts.map((account) => account.accountId));
}

async function quickReplaceStates(accountEmail: string) {
  const { quickReplaceService } = await services();
  const preview = await quickReplaceService.preview({ accountEmail });
  if (!preview.ok) throw new Error(preview.error.message);
  return new Map(
    preview.value.accountProfiles.map((slot) => [slot.profile.profileNumber, slot.state]),
  );
}

beforeAll(async () => {
  if (!local) return;

  const [admin] = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1`;

  superAdmin = {
    id: admin!.id,
    email: admin!.email,
    displayName: admin!.name,
    initials: "SA",
    role: "super_admin",
  };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("problems and account state", () => {
  it("1. a blocking problem makes the account problematic everywhere", async () => {
    const account = await makeAccount("blocked");
    await report(account.id, "incorrect_password");

    const row = await listRow(account.id);
    expect(row.hasActiveProblem).toBe(true);
    expect(accountBadgeStyle(row.account.status, true, row.activeProblemTypes).label).toBe(
      "Incorrect Password",
    );
    expect((await detail(account.id)).accountAllowsAllocation).toBe(false);
    expect(await listIdsForStatus("healthy")).not.toContain(account.id);
    expect(await quickPrepareAccounts()).not.toContain(account.id);
  });

  it("2. an account with no blocking problem stays healthy", async () => {
    const account = await makeAccount("healthy");

    const row = await listRow(account.id);
    expect(row.hasActiveProblem).toBe(false);
    expect(accountBadgeStyle(row.account.status, false, row.activeProblemTypes).label).toBe(
      "Healthy",
    );
    expect((await detail(account.id)).accountAllowsAllocation).toBe(true);
    expect(await listIdsForStatus("healthy")).toContain(account.id);
    expect(await quickPrepareAccounts()).toContain(account.id);
  });

  it("3. resolving the LAST blocking problem restores it — not the first of two", async () => {
    const { problemResolutionService } = await services();
    const account = await makeAccount("two-problems");
    const first = await report(account.id, "payment_problem");
    const second = await report(account.id, "invalid_email");

    const resolved = await problemResolutionService.resolve(
      first.id,
      { resolutionNote: "Card updated, payment went through." },
      { actor: superAdmin },
    );
    expect(resolved.ok).toBe(true);

    /* One still open: still blocked, and the badge now names the one left. */
    let row = await listRow(account.id);
    expect(row.hasActiveProblem).toBe(true);
    expect(row.activeProblemTypes).toEqual(["invalid_email"]);
    expect(await quickPrepareAccounts()).not.toContain(account.id);

    await problemResolutionService.resolve(
      second.id,
      { resolutionNote: "Email address corrected on Netflix." },
      { actor: superAdmin },
    );

    row = await listRow(account.id);
    expect(row.hasActiveProblem).toBe(false);
    expect((await detail(account.id)).accountAllowsAllocation).toBe(true);
    expect(await listIdsForStatus("healthy")).toContain(account.id);
    expect(await quickPrepareAccounts()).toContain(account.id);
  });

  it("4. a problem in a non-blocking status does not block allocation", async () => {
    const { problemResolutionService } = await services();
    const account = await makeAccount("cancelled");
    const problem = await report(account.id, "something_went_wrong");

    const cancelled = await problemResolutionService.cancel(problem.id, { actor: superAdmin });
    expect(cancelled.ok).toBe(true);

    expect((await listRow(account.id)).hasActiveProblem).toBe(false);
    expect((await detail(account.id)).accountAllowsAllocation).toBe(true);
    expect(await quickPrepareAccounts()).toContain(account.id);
  });

  it("stores a report made without severity or description, keeping both columns", async () => {
    const account = await makeAccount("simple-report");
    const problem = await report(account.id, "payment_problem");

    const [stored] = await sql!<{ severity: string; description: string }[]>`
      select severity, description from issues where id = ${problem.id}::uuid`;
    expect(stored).toEqual({ severity: "medium", description: "" });
  });
});

describe.skipIf(!local)("payment problems", () => {
  it("5–8. a NEW payment problem blocks the account in every screen, consistently", async () => {
    const { problemsService } = await services();
    const account = await makeAccount("payment-new");
    await sell(account.id, 1);
    await report(account.id, "payment_problem");

    /* Accounts list: named, filtered as Payment Problem, never as Healthy. */
    const row = await listRow(account.id);
    expect(
      accountBadgeStyle(row.account.status, row.hasActiveProblem, row.activeProblemTypes).label,
    ).toBe("Payment Problem");
    expect(await listIdsForStatus("payment_problem")).toContain(account.id);
    expect(await listIdsForStatus("healthy")).not.toContain(account.id);

    /* Quick Prepare: none of its profiles are offered. */
    expect(await quickPrepareAccounts()).not.toContain(account.id);

    /* Quick Replace: free slots blocked, the sold one still sold. */
    const replace = await quickReplaceStates(account.email);
    expect(replace.get(1)).toBe("sold");
    expect([2, 3, 4, 5].map((n) => replace.get(n))).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
    ]);

    /* Problems page, "Blocking now": the account is on it. */
    const blocking = await problemsService.list({ blocking: true, limit: 200 }, superAdmin);
    expect(blocking.ok && blocking.value.items.map((entry) => entry.problem.accountId)).toContain(
      account.id,
    );

    /* Accounts and Problems agree: every account on "Blocking now" is flagged in the list. */
    const flagged = await listRow(account.id);
    expect(flagged.hasActiveProblem).toBe(true);
  });

  it("an EXISTING payment-problem account (stored status) is blocked the same way", async () => {
    const account = await makeAccount("payment-stored");
    await sql!`update accounts set status = 'payment_problem' where id = ${account.id}::uuid`;

    const row = await listRow(account.id);
    expect(accountBadgeStyle(row.account.status, row.hasActiveProblem).label).toBe(
      "Payment Problem",
    );
    expect(await listIdsForStatus("payment_problem")).toContain(account.id);
    expect(await quickPrepareAccounts()).not.toContain(account.id);
    expect((await detail(account.id)).indicators.map((indicator) => indicator.state)).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
    ]);
  });

  it("a RESOLVED payment problem no longer blocks", async () => {
    const { problemResolutionService } = await services();
    const account = await makeAccount("payment-resolved");
    const problem = await report(account.id, "payment_problem");

    await problemResolutionService.resolve(
      problem.id,
      { resolutionNote: "Subscription renewed by the owner." },
      { actor: superAdmin },
    );

    expect(await listIdsForStatus("payment_problem")).not.toContain(account.id);
    expect(await listIdsForStatus("healthy")).toContain(account.id);
    expect(await quickPrepareAccounts()).toContain(account.id);
  });
});

describe.skipIf(!local)("profile state is the same on every screen", () => {
  it("23–26. Accounts detail, Accounts list and Quick Replace agree slot by slot", async () => {
    const account = await makeAccount("consistency");
    await sell(account.id, 1, 90); /* sold, active */
    await sell(account.id, 2, 30, 40); /* expired ten days ago */
    await sell(account.id, 3, 30, 27); /* expiring soon */
    await report(account.id, "payment_problem");

    const fromDetail = (await detail(account.id)).indicators.map((i) => i.state);
    const fromList = (await listRow(account.id)).profiles.map((p) => p.state);
    const replace = await quickReplaceStates(account.email);
    const fromReplace = [1, 2, 3, 4, 5].map((n) => replace.get(n));

    expect(fromDetail).toEqual(["sold", "expired", "expiring_soon", "blocked", "blocked"]);
    expect(fromList).toEqual(fromDetail);
    expect(fromReplace).toEqual(fromDetail);
  });

  it("24. Quick Prepare offers exactly the slots the Accounts page calls available", async () => {
    const account = await makeAccount("prepare-agrees");
    await sell(account.id, 1);

    const states = (await detail(account.id)).indicators.map((i) => i.state);
    const available = states.filter((state) => state === "available").length;
    expect(available).toBe(4);

    const { quickPrepareService } = await services();
    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);

    const offered = await sql!<{ n: number }[]>`
      select count(*)::int n from profiles p join accounts a on a.id = p.account_id
      where a.id = ${account.id}::uuid and p.status = 'available'`;
    expect(offered[0]!.n).toBe(available);
    expect(await quickPrepareAccounts()).toContain(account.id);
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("profile notes", () => {
  it("9–13. create, edit and clear a note on exactly one profile", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("notes");
    const target = await profileId(account.id, 2);

    const created = await profilesService.updateProfile(
      target,
      { notes: "Customer prefers the Kids profile." },
      { actor: superAdmin },
    );
    expect(created.ok && created.value.profile.notes).toBe("Customer prefers the Kids profile.");

    const edited = await profilesService.updateProfile(
      target,
      { notes: "  Moved to profile 2 on request.  " },
      { actor: superAdmin },
    );
    expect(edited.ok && edited.value.profile.notes).toBe("Moved to profile 2 on request.");

    /* Only profile 2 carries it — in the database and in what the list sends. */
    const notes = await sql!<{ profile_number: number; notes: string | null }[]>`
      select profile_number, notes from profiles where account_id = ${account.id}::uuid
      order by profile_number`;
    expect(notes.map((n) => n.notes)).toEqual([
      null,
      "Moved to profile 2 on request.",
      null,
      null,
      null,
    ]);
    const row = await listRow(account.id);
    expect(row.profiles.map((p) => p.profile.notes)).toEqual(notes.map((n) => n.notes));

    const cleared = await profilesService.updateProfile(
      target,
      { notes: "" },
      { actor: superAdmin },
    );
    expect(cleared.ok && cleared.value.profile.notes).toBeNull();
  });

  it("refuses a note that contains the profile's PIN, and stores nothing", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("note-pin");
    const target = await profileId(account.id, 1);

    await profilesService.updateProfile(target, { pin: "4821" }, { actor: superAdmin });

    const refused = await profilesService.updateProfile(
      target,
      { notes: "pin is 4821 if they ask" },
      { actor: superAdmin },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(refused.error.toLogObject())).not.toContain("4821");
    }

    /* A different number that merely contains the digits is fine. */
    const allowed = await profilesService.updateProfile(
      target,
      { notes: "renewed invoice 48210" },
      { actor: superAdmin },
    );
    expect(allowed.ok).toBe(true);
  });

  it("14. the note change is audited, and the audit holds no PIN", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("note-audit");
    const target = await profileId(account.id, 3);

    await profilesService.updateProfile(target, { pin: "7314" }, { actor: superAdmin });
    await profilesService.updateProfile(
      target,
      { notes: "Asked for a second screen." },
      { actor: superAdmin },
    );

    const audits = await sql!<{ after: Record<string, unknown> }[]>`
      select after from audit_logs
      where entity = 'profile' and entity_id = ${target}::uuid order by created_at`;
    const noteAudit = audits.at(-1)!.after;

    expect(noteAudit["notes"]).toBe("Asked for a second screen.");
    expect(noteAudit["changedFields"]).toEqual(["notes"]);
    expect(JSON.stringify(audits)).not.toContain("7314");
  });
});

/* ------------------------------------------------------------------------- */

describe.skipIf(!local)("expiration: the server's value is the one the editor previewed", () => {
  async function editAndCompare(
    payload: { saleDate?: string; durationDays?: number },
    before: { saleDate: string | null; durationDays: number | null; expirationDate: string | null },
  ) {
    const { profilesService } = await services();
    const account = await makeAccount("expiry");
    const target = await profileId(account.id, 1);
    await sell(account.id, 1);

    await sql!`update profiles set sale_date = ${before.saleDate}, duration_days = ${before.durationDays},
               expiration_date = ${before.expirationDate} where id = ${target}::uuid`;

    const preview = previewExpirationDate(
      {
        ...(payload.saleDate ? { saleDate: payload.saleDate } : {}),
        ...(payload.durationDays ? { durationDays: String(payload.durationDays) } : {}),
      },
      before,
    );

    const result = await profilesService.updateProfile(target, payload, { actor: superAdmin });
    if (!result.ok) throw new Error(result.error.message);

    return { stored: result.value.profile.expirationDate, preview };
  }

  const today = new Date();
  const iso = (offset: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset))
      .toISOString()
      .slice(0, 10);

  it("15. changing the duration recalculates", async () => {
    const { stored, preview } = await editAndCompare(
      { durationDays: 60 },
      { saleDate: iso(-5), durationDays: 30, expirationDate: iso(25) },
    );
    expect(stored).toBe(iso(55));
    expect(preview).toBe(stored);
  });

  it("16. changing the sale date recalculates", async () => {
    const { stored, preview } = await editAndCompare(
      { saleDate: iso(-1) },
      { saleDate: iso(-5), durationDays: 30, expirationDate: iso(25) },
    );
    expect(stored).toBe(iso(29));
    expect(preview).toBe(stored);
  });

  it("17. changing both recalculates from both", async () => {
    const { stored, preview } = await editAndCompare(
      { saleDate: iso(-2), durationDays: 90 },
      { saleDate: iso(-5), durationDays: 30, expirationDate: iso(25) },
    );
    expect(stored).toBe(iso(88));
    expect(preview).toBe(stored);
  });

  it("18. a stale stored expiration is corrected, and the preview says so first", async () => {
    const { stored, preview } = await editAndCompare(
      { durationDays: 30 },
      { saleDate: iso(-5), durationDays: 30, expirationDate: iso(200) },
    );
    expect(stored).toBe(iso(25));
    expect(preview).toBe(stored);
  });

  it("a profile with no duration keeps its stored expiration, as previewed", async () => {
    const { stored, preview } = await editAndCompare(
      { saleDate: iso(-3) },
      { saleDate: iso(-5), durationDays: null, expirationDate: iso(40) },
    );
    expect(stored).toBe(iso(40));
    expect(preview).toBe(stored);
  });

  it("a notes-only edit writes no allocation change", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("notes-only");
    await sell(account.id, 1);
    const target = await profileId(account.id, 1);

    const before = await sql!<{ n: number }[]>`
      select count(*)::int n from profile_events where profile_id = ${target}::uuid`;
    await profilesService.updateProfile(target, { notes: "Just a note." }, { actor: superAdmin });
    const after = await sql!<{ event_type: string }[]>`
      select event_type from profile_events where profile_id = ${target}::uuid
      order by created_at offset ${before[0]!.n}`;

    expect(after.map((e) => e.event_type)).not.toContain("extended");
  });
});

describe.skipIf(!local)("profile edits are authorized on the server", () => {
  it("refuses a caller with no session, and writes nothing", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("no-actor");
    const target = await profileId(account.id, 1);

    const result = await profilesService.updateProfile(target, { notes: "x" }, { actor: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");

    const [row] = await sql!<{ notes: string | null }[]>`
      select notes from profiles where id = ${target}::uuid`;
    expect(row!.notes).toBeNull();
  });
});
