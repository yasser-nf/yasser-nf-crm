import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M08 jobs: the guarantee WITHOUT the pre-check.
 *
 * `idempotency.lookup` (the cheap read before any work) is disabled here, so
 * every repeat reaches the business transaction and must be stopped by the
 * receipt claimed as its first write. That is exactly the path of the
 * adapter retrying a transaction whose COMMIT acknowledgement was lost, and of
 * a repeat that passes the pre-check while the first is still committing.
 *
 * LOCAL ONLY.
 */

vi.mock("@/modules/idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/idempotency")>();
  const { ok } = await import("@/utils/result");
  return {
    ...actual,
    idempotency: { ...actual.idempotency, lookup: async () => ok(null) },
  };
});

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let admin: AppUser;

function phone(): string {
  return `+21377${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
}

beforeAll(async () => {
  if (!local) return;
  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };

  const { accountsService } = await import("@/modules/accounts");
  for (let index = 0; index < 2; index += 1) {
    await accountsService.createAccount(
      {
        email: `m08-tx-${index}-${randomUUID().slice(0, 8)}@example.invalid`,
        password: "x-not-real",
        country: "DZ",
        profileSlots: 5,
      },
      { actor: admin },
    );
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!local)("the receipt inside the transaction stops a repeat on its own", () => {
  it("Quick Prepare: the repeat rolls back at its first write and replays", async () => {
    const { quickPrepareService } = await import("@/modules/quick-prepare");
    const customer = phone();
    const order = { profileCount: 2, durationDays: 30, phone: customer, operationId: randomUUID() };

    const first = await quickPrepareService.confirm(order, { actor: admin });
    const second = await quickPrepareService.confirm(order, { actor: admin });

    expect(first.ok && first.value.replayed).toBe(false);
    expect(second.ok && second.value.replayed).toBe(true);
    if (first.ok && second.ok) expect(second.value.accounts).toEqual(first.value.accounts);

    const [{ sold, events } = { sold: -1, events: -1 }] = await sql!<
      { sold: number; events: number }[]
    >`
      select
        (select count(*)::int from profiles p join customers c on c.id = p.customer_id
          where c.phone_normalized = ${customer.replace(/\D/g, "").slice(-9)} and p.status = 'sold') as sold,
        (select count(*)::int from profile_events e join customers c on c.id = e.customer_id
          where c.phone_normalized = ${customer.replace(/\D/g, "").slice(-9)}) as events`;
    expect({ sold, events }).toEqual({ sold: 2, events: 2 });
  });

  it("a mismatched reuse is refused inside the transaction too, and writes nothing", async () => {
    const { quickPrepareService } = await import("@/modules/quick-prepare");
    const customer = phone();
    const operationId = randomUUID();
    await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: customer, operationId },
      { actor: admin },
    );

    const reused = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 60, phone: customer, operationId },
      { actor: admin },
    );
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe("CONFLICT");

    const [{ sold } = { sold: -1 }] = await sql!<{ sold: number }[]>`
      select count(*)::int sold from profiles p join customers c on c.id = p.customer_id
      where c.phone_normalized = ${customer.replace(/\D/g, "").slice(-9)} and p.status = 'sold'`;
    expect(sold).toBe(1);
  });
});
