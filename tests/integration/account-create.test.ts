import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Account creation, end to end, against the real database.
 *
 * The unit test locks the schema regression. This answers what it cannot: does
 * the whole path actually succeed — encrypt the password, insert the account,
 * create exactly five profiles, write the audit entry?
 *
 * It exists because account creation was broken from the day it was written and
 * no test ever exercised it. A unit test on the schema alone would have caught
 * this particular bug, but not the next one further down the path.
 *
 * Creates a throwaway account on the reserved `.invalid` domain and removes it.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
const createdIds: string[] = [];

const PLAINTEXT = "not-a-real-password";

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

afterAll(async () => {
  if (!configured) return;

  for (const id of createdIds) {
    await sql!`delete from public.accounts where id = ${id}::uuid`;
  }

  await sql!`delete from public.accounts where email like 'm12-create-%@example.invalid'`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("creating an account", () => {
  it("succeeds with exactly what the create form submits", async () => {
    /*
     * Exactly the fields the form collects. This is the payload that
     * failed for the entire life of the feature.
     */
    const { accountsService } = await import("@/modules/accounts");

    const result = await accountsService.createAccount(
      {
        email: `m12-create-${Date.now()}@example.invalid`,
        password: PLAINTEXT,
        country: "DZ",
        notes: "",
      },
      { actor: superAdmin },
    );

    expect(
      result.ok,
      result.ok
        ? ""
        : `${result.error.code}: ${result.error.message} ${JSON.stringify(
            "fieldErrors" in result.error ? result.error.fieldErrors : {},
          )}`,
    ).toBe(true);

    if (result.ok) {
      createdIds.push(result.value.id);
      expect(result.value.status).toBe("healthy");
    }
  }, 60_000);

  it("creates exactly five profiles with it", async () => {
    /* 01_MASTER_RULES.md: never four, never six, never dynamic. */
    const id = createdIds[0];
    expect(id).toBeTruthy();

    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles where account_id = ${id!}::uuid
    `;

    expect(rows[0]!.n).toBe(5);
  });

  it("stores the password as ciphertext, never as given", async () => {
    const id = createdIds[0];

    const rows = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${id!}::uuid
    `;

    expect(rows[0]!.password_encrypted).not.toBe(PLAINTEXT);
    expect(rows[0]!.password_encrypted.length).toBeGreaterThan(PLAINTEXT.length);
  });

  it("writes an audit entry", async () => {
    const id = createdIds[0];

    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'account' and entity_id = ${id!}::uuid and action = 'create'
    `;

    expect(rows[0]!.n).toBe(1);
  });

  it("refuses a duplicate email rather than creating a second account", async () => {
    const { accountsService } = await import("@/modules/accounts");

    const existing = await sql!<{ email: string }[]>`
      select email from public.accounts where id = ${createdIds[0]!}::uuid
    `;

    const result = await accountsService.createAccount(
      { email: existing[0]!.email, password: PLAINTEXT, country: "DZ", notes: "" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 60_000);
});
