import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M05 global search, against the isolated database.
 *
 * Runs the real `searchService.search` over real rows — accounts made by the
 * accounts service, problems reported through the problems service — and
 * checks what each role finds, what each hit says, and what no hit may ever
 * contain.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

/** Unique to this run, so no other fixture can match. Letters only: it is typed as a query. */
const TAG = `srch${String(Date.now() % 100000).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`;
const PIN = "4821";

let admin: AppUser;
let worker: AppUser;

const ids: {
  healthy?: string;
  blocked?: string;
  deleted?: string;
  profileAccount?: string;
  customer?: string;
  handleCustomer?: string;
  problem?: string;
  deletedProblem?: string;
} = {};

async function services() {
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService } = await import("@/modules/problems");
  const { searchService } = await import("@/modules/search");
  return { accountsService, problemsService, searchService };
}

async function makeAccount(label: string): Promise<string> {
  const { accountsService } = await services();
  const created = await accountsService.createAccount(
    {
      email: `${TAG}-${label}@example.invalid`,
      password: "not-a-real-password",
      country: "DZ",
      profileSlots: 5,
    },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function search(query: string, actor: AppUser = admin) {
  const { searchService } = await services();
  const result = await searchService.search(query, actor);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function group(response: Awaited<ReturnType<typeof search>>, kind: string) {
  const found = response.groups.find((entry) => entry.kind === kind);
  if (!found || found.status !== "ok") throw new Error(`group ${kind} missing or failed`);
  return found;
}

beforeAll(async () => {
  if (!local) return;

  const rows = await sql!<{ id: string; name: string; role: string }[]>`
    select id, name, role from users where status = 'active' and deleted_at is null`;
  const seedAdmin = rows.find((row) => row.role === "super_admin")!;
  const seedWorker = rows.find((row) => row.role === "worker")!;
  admin = {
    id: seedAdmin.id,
    email: "admin@test.invalid",
    displayName: seedAdmin.name,
    initials: "SA",
    role: "super_admin",
  };
  worker = {
    id: seedWorker.id,
    email: "worker@test.invalid",
    displayName: seedWorker.name,
    initials: "W",
    role: "worker",
  };

  ids.healthy = await makeAccount("healthy");
  ids.blocked = await makeAccount("blocked");
  ids.deleted = await makeAccount("gone");
  ids.profileAccount = await makeAccount("profiles");

  /* Seven more, so the accounts group has more than it may show. */
  for (let index = 0; index < 7; index += 1) {
    await makeAccount(`bulk${index}`);
  }

  const { problemsService } = await services();

  /* A problem and a named profile on the account that is then deleted. */
  const onDeleted = await problemsService.report(
    { accountId: ids.deleted, issueType: "invalid_email", description: "" },
    { actor: admin },
  );
  if (!onDeleted.ok) throw new Error(onDeleted.error.message);
  ids.deletedProblem = onDeleted.value.id;
  await sql!`
    update profiles set profile_name = ${`Gone ${TAG}`}
    where account_id = ${ids.deleted}::uuid and profile_number = 1`;

  await sql!`update accounts set deleted_at = now() where id = ${ids.deleted}::uuid`;

  const reported = await problemsService.report(
    { accountId: ids.blocked, issueType: "payment_problem", description: "card declined" },
    { actor: admin },
  );
  if (!reported.ok) throw new Error(reported.error.message);
  ids.problem = reported.value.id;

  await sql!`
    update profiles set profile_name = ${`Kids ${TAG}`}, pin = ${PIN}
    where account_id = ${ids.profileAccount}::uuid and profile_number = 2`;

  const [customer] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url, notes)
    values (${`Karim ${TAG}`}, '0661 23 45 67', '661234567', 'https://wa.me/213661234567',
            'private note, not searchable')
    returning id`;
  ids.customer = customer!.id;

  const [handle] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (null, '@RahimouXyz', '@rahimouxyz', '')
    returning id`;
  ids.handleCustomer = handle!.id;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!local)("accounts", () => {
  it("finds an account by an email fragment, case-insensitively, with its effective badge", async () => {
    const response = await search(`${TAG.toUpperCase()}-HEALTHY`);
    const hits = group(response, "accounts").hits;

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: ids.healthy,
      title: `${TAG}-healthy@example.invalid`,
      href: `/accounts/${ids.healthy}`,
      badge: { label: "Healthy" },
    });
  });

  it("names a blocked account by its problem, never Healthy (accountEffectiveStatus)", async () => {
    const hits = group(await search(`${TAG}-blocked`), "accounts").hits;

    expect(hits[0]?.badge?.label).toBe("Payment Problem");
  });

  it("does not find a soft-deleted account", async () => {
    expect(group(await search(`${TAG}-gone`), "accounts").hits).toEqual([]);
  });

  it("excludes the deleted account's profiles and problems too", async () => {
    const response = await search(`${TAG}-gone`);

    expect(group(await search(`gone ${TAG}`), "profiles").hits).toEqual([]);
    expect(group(response, "problems").hits).toEqual([]);
    expect(
      group(await search("invalid email"), "problems").hits.map((hit) => hit.id),
    ).not.toContain(ids.deletedProblem);
  });

  it("shows at most five, says more exist, and links to the Accounts search", async () => {
    const accounts = group(await search(TAG), "accounts");

    expect(accounts.hits).toHaveLength(5);
    expect(accounts.hasMore).toBe(true);
    expect(accounts.viewAllHref).toBe(`/accounts?search=${TAG}`);
  });

  it("finds an account by the first group of its id", async () => {
    const prefix = ids.healthy!.slice(0, 8);
    const hits = group(await search(prefix), "accounts").hits;

    expect(hits.map((hit) => hit.id)).toContain(ids.healthy);
  });
});

describe.skipIf(!local)("profiles", () => {
  it("finds a profile by name, with its account and derived state", async () => {
    const hits = group(await search(`kids ${TAG}`), "profiles").hits;

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: `Kids ${TAG}`,
      subtitle: `Profile 2 · ${TAG}-profiles@example.invalid`,
      href: `/accounts/${ids.profileAccount}`,
      badge: { label: "Available" },
    });
  });

  it("never matches a PIN, and never returns one", async () => {
    const byPin = await search(PIN);
    const everything = JSON.stringify(await search(`kids ${TAG}`));

    expect(group(byPin, "profiles").hits).toEqual([]);
    expect(everything).not.toContain(PIN);
  });
});

describe.skipIf(!local)("customers", () => {
  it("finds a customer by a name fragment", async () => {
    const hits = group(await search(`karim ${TAG}`), "customers").hits;

    expect(hits).toEqual([
      {
        id: ids.customer,
        title: `Karim ${TAG}`,
        subtitle: "0661 23 45 67",
        href: `/customers/${ids.customer}`,
        badge: null,
      },
    ]);
  });

  it.each([
    ["a national fragment with its trunk 0", "0661 23 45"],
    ["the full international form", "+213 661 23 45 67"],
    ["the stored national digits", "661234567"],
    ["a fragment with 00213", "00213 6612"],
  ])("finds a customer by %s (Phone Engine keys)", async (_label, query) => {
    const hits = group(await search(query), "customers").hits;

    expect(hits.map((hit) => hit.id)).toContain(ids.customer);
  });

  it("finds a username customer by a fragment of the handle, in any case", async () => {
    const hits = group(await search("@RAHIMOU"), "customers").hits;

    expect(hits.map((hit) => hit.id)).toContain(ids.handleCustomer);
  });

  it("digits inside an email are not a phone number: no unrelated customers", async () => {
    /* The seed customer's number is 550000001; this is an email, not that phone. */
    const response = await search("mail550000@example.invalid");

    expect(group(response, "customers").hits).toEqual([]);
  });

  it("does not search or return private notes", async () => {
    const response = await search("private note");

    expect(group(response, "customers").hits).toEqual([]);
  });
});

describe.skipIf(!local)("problems", () => {
  it("finds a problem by its type's name, with its account and status", async () => {
    const hits = group(await search("payment"), "problems").hits;
    const hit = hits.find((entry) => entry.id === ids.problem);

    expect(hit).toMatchObject({
      title: "Payment problem",
      subtitle: `${TAG}-blocked@example.invalid`,
      href: `/problems/${ids.problem}`,
      badge: { label: "Open" },
    });
  });

  it("finds a problem by its account's email", async () => {
    const hits = group(await search(`${TAG}-blocked`), "problems").hits;

    expect(hits.map((hit) => hit.id)).toEqual([ids.problem]);
  });
});

describe.skipIf(!local)("authorization", () => {
  it("a Super Admin can find users", async () => {
    const users = group(await search("Test Worker"), "users");

    expect(users.hits[0]).toMatchObject({
      title: "Test Worker",
      href: `/users/${worker.id}`,
    });
    expect(users.hits[0]?.subtitle).toContain("Worker");
  });

  it("a Worker never receives a users group — not even an empty one", async () => {
    const response = await search("Test", worker);

    expect(response.groups.map((entry) => entry.kind)).toEqual([
      "accounts",
      "profiles",
      "customers",
      "problems",
    ]);
  });

  it("a Worker finds what they can browse", async () => {
    const hits = group(await search(`${TAG}-healthy`, worker), "accounts").hits;

    expect(hits.map((hit) => hit.id)).toEqual([ids.healthy]);
  });

  it("refuses the signed-out", async () => {
    const { searchService } = await services();
    const result = await searchService.search("anything", null);

    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!local)("queries that must not become broad or leaky", () => {
  it("one character asks nothing and returns no groups", async () => {
    expect((await search("a")).groups).toEqual([]);
  });

  it("LIKE wildcards are literal: '%%' and '__' match nothing", async () => {
    for (const query of ["%%", "__"]) {
      const response = await search(query);
      const total = response.groups.reduce(
        (sum, entry) => sum + (entry.status === "ok" ? entry.hits.length : 0),
        0,
      );

      expect(total, query).toBe(0);
    }
  });

  it("no results is an answer: every group ok and empty", async () => {
    const response = await search(`${TAG}-nothing-matches-this`);

    expect(response.groups.every((entry) => entry.status === "ok" && entry.hits.length === 0)).toBe(
      true,
    );
  });

  it("no response contains a password, a ciphertext or a PIN", async () => {
    const [account] = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from accounts where id = ${ids.healthy!}::uuid`;
    const body = JSON.stringify([await search(TAG), await search(`kids ${TAG}`)]);

    expect(body).not.toContain(account!.password_encrypted);
    expect(body).not.toContain("not-a-real-password");
    expect(body).not.toMatch(/"(pin|password|passwordEncrypted|notes)"/);
  });
});
