import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { ok } from "@/utils/result";

/**
 * The two refusal mappings, made deterministic.
 *
 * `quickReplaceService.preview` turns a short allocation plan into the
 * `blockedReason` the UI renders:
 *
 *   excludedForValidity > 0  →  "insufficient_validity"
 *   otherwise                →  "no_stock"
 *
 * That single expression was the last untested step in the chain. The allocation
 * engine's side is covered by unit tests, and the UI's side was browser-verified
 * for `nothing_to_replace` — but neither reaches this mapping, and the
 * integration test that appeared to (it was called "reports
 * insufficient_validity…") never asserted it. It was renamed rather than
 * quietly relied upon.
 *
 * WHY THIS FILE STUBS ONE FUNCTION
 *
 * Both refusals require global scarcity: `insufficient_validity` needs NO
 * account able to cover the request, `no_stock` needs no free profile anywhere.
 * The live database contains real accounts — including an open-ended one, which
 * by definition covers any duration — so neither state can occur while they
 * exist, and manufacturing scarcity would mean modifying real stock. That is not
 * something a test may do.
 *
 * So `allocationRepository.findCandidates` is stubbed, and ONLY that. Everything
 * else is real: the account, the customer, their profiles, the problems query,
 * and the whole of `preview` including the projections. The stub replaces the
 * one input that the rest of the database would otherwise dictate.
 *
 * WHAT THIS FILE DOES NOT PROVE
 *
 * That `findCandidates` selects the right candidates — that is the repository's
 * job, covered against the real database in `quick-replace.test.ts`. This file
 * proves only what `preview` does with the candidates it is given, which is
 * exactly the untested step.
 *
 * It is the only mock in the test suite, and it is deliberate: the properties
 * the other files exist to prove — that preview writes nothing, that a stale
 * preview loses under lock — could not be established against a mock, and are
 * not attempted here.
 */

/*
 * The path is written out rather than referenced from a const: `vi.mock` is
 * hoisted above every declaration in the file, so a const would not exist yet
 * when it runs.
 *
 * `importOriginal` keeps the rest of the module intact — `lockCandidates` and
 * `countAvailable` are the real ones, so nothing outside `findCandidates` is
 * quietly replaced.
 */
vi.mock("@/modules/quick-prepare/repositories/allocation.repository", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/modules/quick-prepare/repositories/allocation.repository")
    >();

  return {
    ...actual,
    allocationRepository: { ...actual.allocationRepository, findCandidates: vi.fn() },
  };
});

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m13-refuse";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { quickReplaceService } = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  const { allocationRepository } =
    await import("@/modules/quick-prepare/repositories/allocation.repository");
  return { quickReplaceService, accountsService, allocationRepository };
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id
  `;

  return rows[0]!.id;
}

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const result = await accountsService.createAccount(
    { email: address, password: PLAINTEXT, country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);

  return { id: result.value.id, email: address };
}

async function allocate(accountId: string, customerId: string, expiresInDays: number) {
  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${customerId}::uuid,
        sale_date = current_date - 40, expiration_date = current_date + ${expiresInDays}::int,
        duration_days = ${40 + expiresInDays}::int
    where account_id = ${accountId}::uuid and profile_number = 1
  `;
}

/** Real rows, handed to the engine as a synthetic candidate. */
async function candidateFrom(
  accountId: string,
  remainingValidityDays: number | null,
): Promise<{
  account: AccountRow;
  availableProfiles: readonly ProfileRow[];
  soldCount: number;
  remainingValidityDays: number | null;
}> {
  const accounts = await sql!<AccountRow[]>`
    select id, email, password_encrypted as "passwordEncrypted", status,
      profile_slots as "profileSlots",
      valid_from as "validFrom", valid_until as "validUntil", country, notes,
      created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt",
      archived_at as "archivedAt", deleted_at as "deletedAt"
    from public.accounts where id = ${accountId}::uuid
  `;

  const profiles = await sql!<ProfileRow[]>`
    select id, account_id as "accountId", profile_number as "profileNumber",
      profile_name as "profileName", pin, status, customer_id as "customerId",
      worker_id as "workerId", sale_date as "saleDate",
      expiration_date as "expirationDate", duration_days as "durationDays",
      notes, created_at as "createdAt", updated_at as "updatedAt"
    from public.profiles
    where account_id = ${accountId}::uuid and profile_number in (2, 3)
    order by profile_number
  `;

  return {
    account: accounts[0]!,
    availableProfiles: profiles,
    soldCount: 0,
    remainingValidityDays,
  };
}

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
});

afterEach(async () => {
  if (!configured) return;

  vi.clearAllMocks();

  await sql!`
    update public.profiles
    set status = 'available', customer_id = null, worker_id = null,
        sale_date = null, expiration_date = null, duration_days = null
    where customer_id in (select id from public.customers where name like ${`${PREFIX}-%`})
  `;
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("preview — the refusal the UI renders", () => {
  it("maps short-dated stock to insufficient_validity, with the numbers", async () => {
    const { quickReplaceService, allocationRepository } = await services();

    const broken = await makeAccount("iv-old");
    const customer = await makeCustomer("iv");
    /* The customer needs 50 days carried over. */
    await allocate(broken.id, customer, 50);

    const stock = await makeAccount("iv-stock");

    /*
     * Free profiles exist — so this is NOT a stock shortage — but the account
     * runs out in 10 days and cannot carry 50. That distinction is the whole
     * reason the two reasons are separate.
     */
    vi.mocked(allocationRepository.findCandidates).mockResolvedValue(
      ok([await candidateFrom(stock.id, 10)]),
    );

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* The exact payload the UI consumes. */
    expect(result.value.blockedReason).toBe("insufficient_validity");
    expect(result.value.replacement).toBeNull();
    expect(result.value.bestAvailableDays).toBe(10);

    /* Still says WHO was being moved and what they needed, so the screen can
       quote "10 days available, 50 needed" rather than a bare refusal. */
    expect(result.value.selected?.customer.id).toBe(customer);
    expect(result.value.selected?.remainingDays).toBe(50);

    /* A refusal is not an error: the operator gets a page, not a crash. */
    expect(result.value.oldAccount.id).toBe(broken.id);
    expect(result.value.accountProfiles).toHaveLength(5);
  }, 120_000);

  it("maps an empty candidate list to no_stock", async () => {
    const { quickReplaceService, allocationRepository } = await services();

    const broken = await makeAccount("ns-old");
    const customer = await makeCustomer("ns");
    await allocate(broken.id, customer, 50);

    /* Nothing free anywhere. Not a validity problem — there is simply nothing. */
    vi.mocked(allocationRepository.findCandidates).mockResolvedValue(ok([]));

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.blockedReason).toBe("no_stock");
    expect(result.value.replacement).toBeNull();

    /*
     * Null rather than 0. There is no "best available" when there are no
     * candidates at all, and reporting 0 would read as "an account with zero
     * days left", which is a different and wrong statement.
     */
    expect(result.value.bestAvailableDays).toBeNull();

    expect(result.value.selected?.customer.id).toBe(customer);
  }, 120_000);

  it("distinguishes the two reasons from the same customer and need", async () => {
    /*
     * The pair, back to back. Same account, same customer, same 50-day need —
     * only the available stock differs. If the mapping ever collapsed into one
     * reason, this is the test that would catch it.
     */
    const { quickReplaceService, allocationRepository } = await services();

    const broken = await makeAccount("both-old");
    const customer = await makeCustomer("both");
    await allocate(broken.id, customer, 50);

    const stock = await makeAccount("both-stock");

    vi.mocked(allocationRepository.findCandidates).mockResolvedValue(ok([]));
    const empty = await quickReplaceService.preview({ accountEmail: broken.email });

    vi.mocked(allocationRepository.findCandidates).mockResolvedValue(
      ok([await candidateFrom(stock.id, 3)]),
    );
    const shortDated = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(empty.ok && shortDated.ok).toBe(true);
    if (!empty.ok || !shortDated.ok) return;

    expect(empty.value.blockedReason).toBe("no_stock");
    expect(shortDated.value.blockedReason).toBe("insufficient_validity");

    expect(empty.value.bestAvailableDays).toBeNull();
    expect(shortDated.value.bestAvailableDays).toBe(3);

    /* Neither offered a replacement, which is the point of both. */
    expect(empty.value.replacement).toBeNull();
    expect(shortDated.value.replacement).toBeNull();
  }, 120_000);

  it("still carries no credentials when refusing", async () => {
    /*
     * A refusal path is a payload path. It returns the account and the
     * customer's profiles just as the success path does, so it has to be
     * checked too — an exception that only leaks on failure is still a leak.
     */
    const { quickReplaceService, allocationRepository } = await services();

    const broken = await makeAccount("clean-refusal");
    const customer = await makeCustomer("clean-refusal");
    await allocate(broken.id, customer, 50);

    await sql!`update public.profiles set pin = '3120' where account_id = ${broken.id}::uuid`;

    vi.mocked(allocationRepository.findCandidates).mockResolvedValue(ok([]));

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blockedReason).toBe("no_stock");

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${broken.id}::uuid
    `;

    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("passwordEncrypted");
    expect(serialized).not.toContain("password_encrypted");
    expect(serialized).not.toContain(stored[0]!.password_encrypted);
    expect(serialized).not.toContain("3120");
    expect(serialized).not.toContain('"pin"');

    expect(Object.hasOwn(result.value.oldAccount, "passwordEncrypted")).toBe(false);

    for (const slot of result.value.accountProfiles) {
      expect(Object.hasOwn(slot.profile, "pin")).toBe(false);
    }
  }, 120_000);
});
