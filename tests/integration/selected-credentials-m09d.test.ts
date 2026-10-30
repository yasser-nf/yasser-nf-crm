import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M09D — the selected account's credentials in Quick Prepare and Quick Replace.
 *
 * What these tests pin down, in the order the server checks it:
 *
 *   1. the workflow permission (prepare / replace),
 *   2. the credential permission (view_accounts) — and that (1) does not
 *      imply (2),
 *   3. that the account is still the current, eligible selection,
 *
 * and that the plaintext appears in the one response that asked for it and
 * nowhere else: not in logs, audit rows, receipts, previews, account lists or
 * error messages, and that the stored ciphertext is never rewritten.
 *
 * Both real roles hold every permission involved, so "a role without it" is
 * staged by withholding one named permission from `roleHasPermission`. Stock is
 * controlled the same way as the M09C suite: everything this file did not
 * create is archived, which is only acceptable because the file runs on its own
 * throwaway database and refuses to run on anything else.
 */

const withheld = new Set<string>();

vi.mock("@/config/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/roles")>();
  return {
    ...actual,
    roleHasPermission: (role: Parameters<typeof actual.roleHasPermission>[0], permission: string) =>
      !withheld.has(permission) &&
      actual.roleHasPermission(role, permission as Parameters<typeof actual.roleHasPermission>[1]),
  };
});

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const isolated =
  describeDatabaseUrl(DATABASE_URL)?.isLocal === true && !process.env["EXTERNAL_TEST_DATABASE_URL"];
const sql = isolated ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m09d";

let admin: AppUser;
let worker: AppUser;

/** Captured output from every console channel the logger writes to. */
let consoleOutput: string[] = [];

async function services() {
  const prepare = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService } = await import("@/modules/problems");
  return { ...prepare, accountsService, problemsService };
}

/** A distinct, recognisable password per account, so a leak names its source. */
function secret(tag: string): string {
  return `M09D-Secret-${tag}-${randomUUID().slice(0, 6)}!`;
}

async function makeAccount(
  tag: string,
  options: { free?: number; offsetMinutes?: number } = {},
): Promise<{ id: string; email: string; password: string }> {
  const { accountsService } = await services();
  const email = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = secret(tag);
  const created = await accountsService.createAccount(
    { ownership: "owned", email, password, country: "DZ", profileSlots: 5 },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);

  const id = created.value.id;
  const free = options.free ?? 5;

  if (free < 5) {
    const holder = await makeCustomer(`${tag}-holder`);
    await sql!`
      update profiles
      set status = 'sold', customer_id = ${holder}::uuid,
          sale_date = current_date - 1, expiration_date = current_date + 300, duration_days = 301
      where account_id = ${id}::uuid and profile_number > ${free}::smallint`;
  }

  await sql!`
    update accounts set created_at = now() - interval '1 day' + ${`${options.offsetMinutes ?? 0} minutes`}::interval
    where id = ${id}::uuid`;

  return { id, email, password };
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));
  const [row] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;
  return row!.id;
}

async function ciphertextOf(accountId: string): Promise<string> {
  const [row] = await sql!<{ password_encrypted: string }[]>`
    select password_encrypted from accounts where id = ${accountId}::uuid`;
  return row!.password_encrypted;
}

/** Every audit row this file's accounts produced, serialised, for leak checks. */
async function auditText(): Promise<string> {
  const rows = await sql!<{ before: unknown; after: unknown }[]>`
    select before, after from audit_logs`;
  return JSON.stringify(rows);
}

beforeAll(async () => {
  if (!isolated) return;

  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  const [w] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'worker' and deleted_at is null limit 1`;
  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };
  worker = { id: w!.id, email: w!.email, displayName: w!.name, initials: "W", role: "worker" };

  /* The seed's stock is out of play for the whole file. */
  await sql!`update accounts set status = 'archived' where status <> 'archived'`;
});

beforeEach(() => {
  withheld.clear();
  consoleOutput = [];
  for (const channel of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => String(arg)).join(" "));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (!isolated) return;
  await sql!`update accounts set status = 'archived' where status <> 'archived'`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** The request the Quick Prepare review would send for one account of a plan. */
function preparationRequest(accountIds: string[], accountId: string, profileCount = 1) {
  return { profileCount, durationDays: 30, accountIds, accountId };
}

/* =============================================================== Quick Prepare */

describe.skipIf(!isolated)("Quick Prepare — the selected account's credentials", () => {
  it("returns the email and password of the selected account, to either role", async () => {
    const { selectedCredentialsService } = await services();
    const account = await makeAccount("prep-ok");

    for (const actor of [admin, worker]) {
      const result = await selectedCredentialsService.forPreparation(
        preparationRequest([account.id], account.id),
        { actor },
      );

      expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        accountId: account.id,
        email: account.email,
        password: account.password,
      });
    }
  });

  it("refuses the signed-out, and anyone missing either permission", async () => {
    const { selectedCredentialsService } = await services();
    const account = await makeAccount("prep-auth");
    const request = preparationRequest([account.id], account.id);

    const signedOut = await selectedCredentialsService.forPreparation(request, { actor: null });
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.error.code).toBe("FORBIDDEN");

    /* May prepare, may not read credentials: being able to sell is not enough. */
    withheld.add("view_accounts");
    const noCredentials = await selectedCredentialsService.forPreparation(request, {
      actor: worker,
    });
    expect(noCredentials.ok).toBe(false);
    if (!noCredentials.ok) expect(noCredentials.error.code).toBe("FORBIDDEN");

    /* May read credentials, may not prepare: refused before anything is looked up. */
    withheld.clear();
    withheld.add("prepare_subscriptions");
    const noWorkflow = await selectedCredentialsService.forPreparation(request, { actor: worker });
    expect(noWorkflow.ok).toBe(false);
    if (!noWorkflow.ok) expect(noWorkflow.error.code).toBe("FORBIDDEN");

    /* No refusal decrypted anything worth auditing, or said anything secret. */
    expect(await auditText()).not.toContain(account.password);
    for (const result of [signedOut, noCredentials, noWorkflow]) {
      expect(JSON.stringify(result)).not.toContain(account.password);
    }
  });

  it("refuses malformed requests and an account outside the selection", async () => {
    const { selectedCredentialsService } = await services();
    const account = await makeAccount("prep-shape");
    const outsider = await makeAccount("prep-outsider");

    for (const bad of [
      { ...preparationRequest([account.id], account.id), accountId: "not-a-uuid" },
      preparationRequest([account.id], outsider.id),
      { accountId: account.id },
    ]) {
      const result = await selectedCredentialsService.forPreparation(bad, { actor: admin });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(account.password);
      expect(JSON.stringify(result)).not.toContain(outsider.password);
    }
  });

  it("only reveals an account the current plan actually uses", async () => {
    const { selectedCredentialsService } = await services();
    const first = await makeAccount("plan-first", { offsetMinutes: 1 });
    const second = await makeAccount("plan-second", { offsetMinutes: 2 });

    /*
     * Both accounts listed, one profile ordered: the plan uses only `first`.
     * Listing `second` beside it cannot make the server hand its password over.
     */
    const unused = await selectedCredentialsService.forPreparation(
      preparationRequest([first.id, second.id], second.id),
      { actor: admin },
    );
    expect(unused.ok).toBe(false);
    if (!unused.ok) expect(unused.error.userMessage).toMatch(/no longer the one selected/);

    const used = await selectedCredentialsService.forPreparation(
      preparationRequest([first.id, second.id], first.id),
      { actor: admin },
    );
    expect(used.ok && used.value.password).toBe(first.password);
  });

  it("refuses a selection that went stale: sold out, broken, or unhealthy", async () => {
    const { selectedCredentialsService, problemsService } = await services();

    const soldOut = await makeAccount("stale-sold");
    await sql!`
      update profiles set status = 'sold', customer_id = ${await makeCustomer("stale-buyer")}::uuid,
        sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
      where account_id = ${soldOut.id}::uuid`;

    const broken = await makeAccount("stale-problem");
    await problemsService.report(
      { accountId: broken.id, issueType: "payment_problem", description: "m09d" },
      { actor: admin },
    );

    const unhealthy = await makeAccount("stale-status");
    await sql!`update accounts set status = 'invalid_email' where id = ${unhealthy.id}::uuid`;

    for (const account of [soldOut, broken, unhealthy]) {
      const result = await selectedCredentialsService.forPreparation(
        preparationRequest([account.id], account.id),
        { actor: admin },
      );
      expect(result.ok, account.email).toBe(false);
      expect(JSON.stringify(result)).not.toContain(account.password);
    }
  });

  it("fails safely when the stored credential cannot be decrypted", async () => {
    const { selectedCredentialsService } = await services();
    const account = await makeAccount("prep-corrupt");
    await sql!`update accounts set password_encrypted = 'v1:not-a-real-ciphertext' where id = ${account.id}::uuid`;

    const result = await selectedCredentialsService.forPreparation(
      preparationRequest([account.id], account.id),
      { actor: admin },
    );

    expect(result.ok).toBe(false);
    /* Neither the stored value nor anything like it is echoed back. */
    expect(JSON.stringify(result)).not.toContain("not-a-real-ciphertext");
  });
});

/* =============================================================== Quick Replace */

describe.skipIf(!isolated)("Quick Replace — the replacement account's credentials", () => {
  async function scenario(tag: string) {
    const failing = await makeAccount(`${tag}-failing`, { offsetMinutes: 0 });
    const customerId = await makeCustomer(`${tag}-customer`);
    await sql!`
      update profiles
      set status = 'sold', customer_id = ${customerId}::uuid,
          sale_date = current_date - 40, expiration_date = current_date + 50, duration_days = 90
      where account_id = ${failing.id}::uuid and profile_number = 1`;
    await sql!`update accounts set status = 'payment_problem' where id = ${failing.id}::uuid`;

    const replacement = await makeAccount(`${tag}-replacement`, { offsetMinutes: 1 });
    return { failing, customerId, replacement };
  }

  it("returns the replacement's credentials, never the failing account's", async () => {
    const { selectedCredentialsService } = await services();
    const { failing, customerId, replacement } = await scenario("rep-ok");

    const result = await selectedCredentialsService.forReplacement(
      { accountEmail: failing.email, customerId, replacementAccountId: replacement.id },
      { actor: worker },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      accountId: replacement.id,
      email: replacement.email,
      password: replacement.password,
    });
    expect(JSON.stringify(result.value)).not.toContain(failing.password);

    /* Asking for the failing account itself is refused. */
    const own = await selectedCredentialsService.forReplacement(
      { accountEmail: failing.email, customerId, replacementAccountId: failing.id },
      { actor: worker },
    );
    expect(own.ok).toBe(false);
    expect(JSON.stringify(own)).not.toContain(failing.password);
  });

  it("refuses a wrong customer, a stale proposal, and a missing permission", async () => {
    const { selectedCredentialsService, problemsService } = await services();
    const { failing, customerId, replacement } = await scenario("rep-refuse");
    const request = {
      accountEmail: failing.email,
      customerId,
      replacementAccountId: replacement.id,
    };

    const stranger = await selectedCredentialsService.forReplacement(
      { ...request, customerId: randomUUID() },
      { actor: admin },
    );
    expect(stranger.ok).toBe(false);

    withheld.add("replace_accounts");
    const noWorkflow = await selectedCredentialsService.forReplacement(request, { actor: worker });
    expect(noWorkflow.ok).toBe(false);
    if (!noWorkflow.ok) expect(noWorkflow.error.code).toBe("FORBIDDEN");
    withheld.clear();

    await problemsService.report(
      { accountId: replacement.id, issueType: "incorrect_password", description: "m09d" },
      { actor: admin },
    );
    const stale = await selectedCredentialsService.forReplacement(request, { actor: admin });
    expect(stale.ok).toBe(false);

    for (const result of [stranger, noWorkflow, stale]) {
      expect(JSON.stringify(result)).not.toContain(replacement.password);
    }
  });
});

/* =============================================================== Where secrets must never be */

describe.skipIf(!isolated)("the plaintext stays in the one response that asked for it", () => {
  it("audits the read with its reason, and no secret anywhere it is kept", async () => {
    const { selectedCredentialsService, quickPrepareService, accountsService } = await services();
    const account = await makeAccount("leak", { free: 2 });
    const storedBefore = await ciphertextOf(account.id);

    const revealed = await selectedCredentialsService.forPreparation(
      preparationRequest([account.id], account.id),
      { actor: admin },
    );
    expect(revealed.ok).toBe(true);

    /* The read is on record, as an event with a reason — and nothing more. */
    const [entry] = await sql!<{ after: Record<string, unknown> }[]>`
      select after from audit_logs
      where entity = 'account' and entity_id = ${account.id}::uuid
        and after->>'event' = 'password_revealed'
      order by created_at desc limit 1`;
    expect(entry?.after).toEqual({ event: "password_revealed", reason: "quick_prepare" });

    /* A sale too, so the receipt can be checked. */
    const sold = await quickPrepareService.confirm(
      {
        profileCount: 1,
        durationDays: 30,
        phone: `0663${String(Math.floor(100_000 + Math.random() * 899_999))}`,
        accountIds: [account.id],
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(sold.ok).toBe(true);

    const receipts = await sql!<{ result: unknown }[]>`select result from idempotency_keys`;
    /* Not vacuous: the sale above wrote one. */
    expect(receipts.length).toBeGreaterThan(0);
    expect(JSON.stringify(receipts)).not.toContain(account.password);

    /* The suggestion and the accounts list carry no password, plain or encrypted. */
    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    const list = await accountsService.listAccounts({ search: PREFIX, limit: 100, offset: 0 });
    for (const payload of [preview, list]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(account.password);
      expect(text).not.toContain(storedBefore);
      expect(text).not.toContain("passwordEncrypted");
    }

    expect(await auditText()).not.toContain(account.password);
    expect(consoleOutput.join("\n")).not.toContain(account.password);

    /* Reading never rewrote the stored credential. */
    expect(await ciphertextOf(account.id)).toBe(storedBefore);
  });
});
