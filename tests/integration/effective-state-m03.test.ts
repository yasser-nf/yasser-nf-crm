import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * After a problem is resolved, the account's state is RECALCULATED (M03 final
 * fix) — through the real resolution paths, single and bulk, over the isolated
 * database. Every screen is asked, and they must agree:
 *
 *   Accounts list + detail   effectiveStatus, the badge's only input
 *   Healthy filter           accountMatchesStatusSql("healthy")
 *   Quick Prepare            available stock (accountCanAllocateSql)
 *   Quick Replace            the old account's slot states
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;

const NOTE = { resolutionNote: "Resolved during the effective-state verification." };
const TAG = `es${Date.now() % 100000}`;
let counter = 0;

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

async function resolveOne(problemId: string) {
  const { problemResolutionService } = await services();
  const result = await problemResolutionService.resolve(problemId, NOTE, { actor: superAdmin });
  if (!result.ok) throw new Error(result.error.message);
}

/** What every screen says about one account, in one object. */
async function everyScreen(account: { id: string; email: string }) {
  const { accountsService, quickReplaceService } = await services();

  const list = await accountsService.listAccounts({
    limit: 200,
    search: account.email,
    includeBlocked: true,
  });
  const onAccountsPage = await accountsService.listAccounts({ limit: 200, search: account.email });
  const healthyFilter = await accountsService.listAccounts({
    limit: 200,
    search: account.email,
    status: "healthy",
  });
  const detail = await accountsService.getAccountDetail(account.id);
  const replace = await quickReplaceService.preview({ accountEmail: account.email });

  if (!list.ok || !onAccountsPage.ok || !healthyFilter.ok || !detail.ok || !replace.ok) {
    throw new Error("a screen failed to load");
  }

  return {
    listStatus: list.value.items[0]?.effectiveStatus,
    detailStatus: detail.value.effectiveStatus,
    onAccountsPage: onAccountsPage.value.items.length === 1,
    inHealthyFilter: healthyFilter.value.items.length === 1,
    detailAllowsAllocation: detail.value.accountAllowsAllocation,
    replaceStates: [...new Set(replace.value.accountProfiles.map((slot) => slot.state))],
  };
}

async function stock(): Promise<number> {
  const { quickPrepareService } = await services();
  const result = await quickPrepareService.availableStock();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeAll(async () => {
  if (!local) return;
  const [admin] = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from users where role = 'super_admin' and status = 'active' limit 1`;
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

describe.skipIf(!local)("the account state after resolution is recalculated", () => {
  it("1, 5, 6. the only blocking problem resolved on a genuinely healthy account → Healthy", async () => {
    const account = await makeAccount("genuine");
    const problem = await report(account.id);
    const before = await stock();

    await resolveOne(problem);

    expect(await everyScreen(account)).toEqual({
      listStatus: "healthy",
      detailStatus: "healthy",
      onAccountsPage: true,
      inHealthyFilter: true,
      detailAllowsAllocation: true,
      replaceStates: ["available"],
    });
    expect((await stock()) - before).toBe(5);
  });

  it("2. one of two blocking problems resolved → still that problem, not Healthy", async () => {
    const account = await makeAccount("two");
    const payment = await report(account.id, "payment_problem");
    await report(account.id, "invalid_email");

    await resolveOne(payment);

    expect(await everyScreen(account)).toEqual({
      listStatus: "invalid_email",
      detailStatus: "invalid_email",
      onAccountsPage: false,
      inHealthyFilter: false,
      detailAllowsAllocation: false,
      replaceStates: ["blocked"],
    });
  });

  it("3, 5, 6. last problem resolved on an account whose validity ended → Expired, not Healthy", async () => {
    const account = await makeAccount("expired");
    const problem = await report(account.id);
    await sql!`update accounts set valid_until = current_date - 3 where id = ${account.id}::uuid`;
    const before = await stock();

    await resolveOne(problem);

    expect(await everyScreen(account)).toEqual({
      listStatus: "expired",
      detailStatus: "expired",
      /* Not blocked by a problem, so it is listed — as Expired. */
      onAccountsPage: true,
      inHealthyFilter: false,
      detailAllowsAllocation: false,
      replaceStates: ["blocked"],
    });
    /* Quick Prepare gained nothing from the resolution. */
    expect(await stock()).toBe(before);
  });

  it("3. last problem resolved on an account with a stored fault → still that fault", async () => {
    const account = await makeAccount("stored-fault");
    const problem = await report(account.id);
    await sql!`update accounts set status = 'incorrect_password' where id = ${account.id}::uuid`;

    await resolveOne(problem);

    const screens = await everyScreen(account);
    expect(screens.listStatus).toBe("incorrect_password");
    expect(screens.detailStatus).toBe("incorrect_password");
    expect(screens.inHealthyFilter).toBe(false);
    expect(screens.detailAllowsAllocation).toBe(false);
  });

  it("7. the bulk Resolve follows the same rules, for both cases in one batch", async () => {
    const { bulkProblemsService } = await services();
    const genuine = await makeAccount("bulk-genuine");
    const expired = await makeAccount("bulk-expired");
    const p1 = await report(genuine.id);
    const p2 = await report(expired.id);
    await sql!`update accounts set valid_until = current_date - 1 where id = ${expired.id}::uuid`;

    const outcome = await bulkProblemsService.resolveProblems([p1, p2], NOTE, {
      actor: superAdmin,
    });
    expect(outcome.ok && outcome.value.succeeded).toEqual([p1, p2]);

    expect((await everyScreen(genuine)).listStatus).toBe("healthy");
    expect((await everyScreen(expired)).listStatus).toBe("expired");
  });

  it("7. the account-level bulk Resolve follows them too", async () => {
    const { bulkProblemsService } = await services();
    const expired = await makeAccount("acct-bulk-expired");
    await report(expired.id);
    await sql!`update accounts set valid_until = current_date - 10 where id = ${expired.id}::uuid`;

    await bulkProblemsService.resolveForAccounts([expired.id], NOTE, { actor: superAdmin });

    expect((await everyScreen(expired)).detailStatus).toBe("expired");
  });

  it("8. resolving writes nothing to the account row", async () => {
    const account = await makeAccount("untouched");
    const problem = await report(account.id);

    const [before] =
      await sql!`select status, updated_at, valid_until from accounts where id = ${account.id}::uuid`;
    await resolveOne(problem);
    const [after] =
      await sql!`select status, updated_at, valid_until from accounts where id = ${account.id}::uuid`;

    expect(after).toEqual(before);
  });
});
